const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawn } = require("node:child_process");
const { load } = require("./config.cjs");
const { withLock } = require("./lock.cjs");
const { DIR, read, atomic, build } = require("./core.cjs");

// Whitelist the wire format. A stats-only import must not retain text or paths.
function normalize(raw, config) {
  if (
    raw.version !== 1 ||
    raw.timezone !== config.timezone ||
    !Array.isArray(raw.events) ||
    !Array.isArray(raw.sessions) ||
    !Array.isArray(raw.inventory) ||
    !Array.isArray(raw.errors)
  )
    throw new Error("Invalid snapshot or timezone mismatch");
  const text = (value) => String(value || "").slice(0, 1400);
  const date = (value) =>
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value + "T12:00:00Z"));
  const events = raw.events.map((e) => {
    if (!date(e.day) || !e.id || !e.agent || !e.session)
      throw new Error("Invalid usage record");
    const result = Object.fromEntries(
      ["id", "agent", "session", "model"].map((k) => [k, text(e[k])]),
    );
    result.day = e.day;
    if (e.kind === "chat-message") {
      if (
        !["user", "assistant"].includes(e.role) ||
        typeof e.tokensKnown !== "boolean" ||
        (e.role === "user" && e.tokensKnown)
      )
        throw new Error("Invalid chat message");
      result.kind = e.kind;
      result.role = e.role;
      result.tokensKnown = e.tokensKnown;
    }
    result.aliases = (Array.isArray(e.aliases) ? e.aliases : []).map(text);
    for (const k of ["input", "cached", "cacheWrite", "output", "reasoning"]) {
      if (result.kind === "chat-message" && !result.tokensKnown) {
        result[k] = null;
        continue;
      }
      const n = e[k] ?? 0;
      if (!Number.isSafeInteger(n) || n < 0)
        throw new Error("Invalid usage count");
      result[k] = n;
    }
    return result;
  });
  const sessions = config.captureText
    ? raw.sessions.map((s) => {
        if (
          !date(s.day) ||
          !s.id ||
          !s.agent ||
          !Array.isArray(s.requests) ||
          !Array.isArray(s.results)
        )
          throw new Error("Invalid session");
        return {
          id: text(s.id),
          agent: text(s.agent),
          day: s.day,
          project: text(s.project),
          requests: s.requests.slice(0, 4).map(text),
          results: s.results.slice(-2).map(text),
        };
      })
    : [];
  return {
    version: 1,
    timezone: config.timezone,
    captureText: config.captureText,
    scannedAt: new Date().toISOString(),
    imported: raw.imported === true,
    coverageFrom: date(raw.coverageFrom) ? raw.coverageFrom : null,
    coverageTo: date(raw.coverageTo) ? raw.coverageTo : null,
    events,
    sessions,
    inventory: raw.inventory.map((i) => ({
      agent: text(i.agent),
      status: text(i.status),
      files: Number(i.files) || 0,
      events: Number(i.events) || 0,
    })),
    errors: raw.errors.map((e) => ({
      agent: text(e.agent),
      kind: text(e.kind),
      count: Number(e.count) || 1,
    })),
  };
}
function scriptFor(source, config) {
  const options = {
    timezone: config.timezone,
    captureText: config.captureText,
    home: source.home,
  };
  if (source.type === "wsl") {
    const script = fs.readFileSync(path.join(__dirname, "scan-wsl.py"), "utf8");
    return script.replace(
      'SETTINGS=json.loads(os.environ.get("AI_LOG_SCAN_OPTIONS","{}"))',
      "SETTINGS=json.loads(" + JSON.stringify(JSON.stringify(options)) + ")",
    );
  }
  return (
    "process.env.AI_LOG_SCAN_OPTIONS=" +
    JSON.stringify(JSON.stringify(options)) +
    ";\n" +
    fs.readFileSync(path.join(__dirname, "scanner.cjs"), "utf8")
  );
}
function commandFor(source) {
  let command = process.execPath,
    args = ["--no-warnings", "-"];
  if (source.type === "wsl") {
    command = "wsl.exe";
    args = [
      "-d",
      source.distro,
      ...(source.user ? ["-u", source.user] : []),
      "--exec",
      "python3",
      "-",
    ];
  }
  if (source.type === "ssh" || source.host) {
    const remote =
      source.type === "wsl"
        ? [command, ...args].join(" ")
        : "node --no-warnings -";
    command = "ssh";
    args = [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=12",
      source.host,
      remote,
    ];
  }
  return { command, args };
}
function run(source, config) {
  if (source.type === "chatgpt")
    return Promise.resolve(
      normalize(require("./chatgpt.cjs").scan(source.path, config), config),
    );
  if (source.type === "file") {
    let data = fs.readFileSync(path.resolve(source.path));
    if (source.path.endsWith(".gz"))
      data = zlib.gunzipSync(data, { maxOutputLength: 256 * 1024 * 1024 });
    return Promise.resolve(normalize(JSON.parse(data.toString()), config));
  }
  return new Promise((resolve, reject) => {
    const { command, args } = commandFor(source);
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks = [];
    let bytes = 0,
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 240000);
    child.stdout.on("data", (b) => {
      bytes += b.length;
      if (bytes > 256 * 1024 * 1024) child.kill();
      else chunks.push(b);
    });
    child.stderr.resume(); // Do not copy remote diagnostics, paths or snippets into the central state.
    child.stdin.on("error", () => {});
    child.stdin.end(scriptFor(source, config));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(e.code || "collector-failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || bytes > 256 * 1024 * 1024)
        return reject(
          new Error(timedOut ? "collector-timeout" : "collector-failed"),
        );
      try {
        const data = zlib.gunzipSync(
          Buffer.from(Buffer.concat(chunks).toString().trim(), "base64"),
          { maxOutputLength: 256 * 1024 * 1024 },
        );
        resolve(normalize(JSON.parse(data.toString()), config));
      } catch {
        reject(new Error("invalid-snapshot"));
      }
    });
  });
}
async function collect(config = load(), { only } = {}) {
  return withLock(path.join(DIR, "collect.lock"), async () => {
    const previous = read(path.join(DIR, "sources.json"));
    const states = Object.fromEntries(
      Object.entries(previous).filter(([id]) =>
        config.sources.some((s) => s.id === id),
      ),
    );
    for (const source of config.sources.filter((s) => !only || s.id === only)) {
      const at = new Date().toISOString();
      try {
        const data = await run(source, config);
        const file = path.join(DIR, source.id + ".json.gz");
        fs.writeFileSync(file + ".tmp", zlib.gzipSync(JSON.stringify(data)), {
          mode: 0o600,
        });
        fs.renameSync(file + ".tmp", file);
        states[source.id] = {
          name: source.name || source.id,
          status: data.errors.length ? "partial" : "ok",
          lastAttempt: at,
          lastSuccess: at,
          inventory: data.inventory,
          errors: data.errors,
          events: data.events.length,
          imported: data.imported,
          coverageFrom: data.coverageFrom,
          coverageTo: data.coverageTo,
        };
      } catch (e) {
        states[source.id] = {
          ...states[source.id],
          name: source.name || source.id,
          status: "error",
          lastAttempt: at,
          error: e.message,
        };
      }
      atomic(path.join(DIR, "sources.json"), states);
    }
    atomic(path.join(DIR, "heartbeat.json"), {
      pid: process.pid,
      at: new Date().toISOString(),
    });
    return build();
  });
}
module.exports = { collect, normalize, run, scriptFor, commandFor };
