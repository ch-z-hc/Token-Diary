// Read-only agent history scanner. Run over SSH on the source device; stdout is a compressed normalized snapshot.
const fs = require("fs"),
  path = require("path"),
  os = require("os"),
  crypto = require("crypto");
const zlib = require("zlib"),
  readline = require("readline");
const SETTINGS = JSON.parse(process.env.AI_LOG_SCAN_OPTIONS || "{}");
const TIMEZONE =
  SETTINGS.timezone || process.env.AI_LOG_TIMEZONE || "Asia/Shanghai";
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hash = (x) =>
  crypto
    .createHash("sha256")
    .update(typeof x === "string" ? x : JSON.stringify(x))
    .digest("hex");
const num = (x) =>
  Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0;
function clean(text) {
  return String(text || "")
    .replace(
      /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?(?:-----END [^-]+-----|$)/g,
      "[已隐去凭据]",
    )
    .replace(
      /<(?:environment_context|INSTRUCTIONS|system-reminder|user_instructions|external_codex_apps_open_page|send_user_message_question_reply)[\s\S]*?<\/(?:environment_context|INSTRUCTIONS|system-reminder|user_instructions|external_codex_apps_open_page|send_user_message_question_reply)>/gi,
      "",
    )
    .replace(/^# AGENTS\.md instructions[\s\S]*/gm, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(
      /(?:sk-|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}/g,
      "[已隐去凭据]",
    )
    .replace(
      /((?:password|api[_-]?key|secret|token|口令|密码)\s*[=:：]\s*)[^\s,，;；]+/gi,
      "$1[已隐去]",
    )
    .replace(/data:[^\s]+/g, "[附件]")
    .replace(/https?:\/\/[^\s<]+/g, "[链接]")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1400);
}
function textOf(c) {
  return typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c
          .filter((x) => ["text", "input_text", "output_text"].includes(x.type))
          .map((x) => x.text || "")
          .join("\n")
      : "";
}
function day(ts) {
  const d = new Date(ts);
  return Number.isNaN(+d) ? null : dateFormat.format(d);
}
function codexUsage(u) {
  return {
    input: num(u.input_tokens),
    cached: num(u.cached_input_tokens),
    cacheWrite: num(u.cache_write_input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.reasoning_output_tokens),
  };
}
function usageKey(u) {
  return [u.input, u.cached, u.cacheWrite, u.output, u.reasoning].join(":");
}
// OpenCode stores uncached input and visible output separately from cache/reasoning.
function openCodeUsage(u) {
  return {
    input: num(u.input) + num(u.cache?.read) + num(u.cache?.write),
    cached: num(u.cache?.read),
    cacheWrite: num(u.cache?.write),
    output: num(u.output) + num(u.reasoning),
    reasoning: num(u.reasoning),
  };
}
// Zcode model_usage preserves provider totals: input includes cache, output includes reasoning.
function zcodeUsage(u) {
  return {
    input: num(u.input_tokens),
    cached: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.reasoning_tokens),
  };
}
async function walk(dir, pred) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, pred)));
    else if (e.isFile() && pred(p)) out.push(p);
  }
  return out;
}
async function jsonlines(file) {
  let stream = fs.createReadStream(file);
  if (file.endsWith(".zst")) stream = stream.pipe(zlib.createZstdDecompress());
  return readline.createInterface({ input: stream, crlfDelay: Infinity });
}
function ignorableLine(line) {
  return (
    !line.trim() ||
    (/"type"\s*:\s*"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"task_started"\s*[,}]/.test(
      line,
    ) &&
      !/token_usage_record|token_count|"usage"\s*:/.test(line))
  );
}
async function parseFile(
  file,
  agent,
  { includeText = SETTINGS.captureText === true } = {},
) {
  let sid = path.basename(file).replace(/\.jsonl(?:\.zst)?$/, ""),
    model = "unknown",
    cwd = "",
    prev = null;
  const events = [],
    messages = [],
    counters = [],
    modernSignatures = new Set(),
    modernCalls = [],
    messageMap = new Map();
  let malformed = 0;
  for await (const line of await jsonlines(file)) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      if (!ignorableLine(line)) malformed++;
      continue;
    }
    const p = r.payload || {},
      m = r.message || {},
      ts = r.timestamp;
    if (r.type === "session_meta") {
      sid = p.id || p.session_id || sid;
      cwd = p.cwd || "";
    }
    if (r.type === "session") {
      sid = r.id || sid;
      cwd = r.cwd || "";
    }
    if (r.type === "turn_context") model = p.model || model;
    if (agent === "Codex") {
      if (r.type === "token_usage_record" && p.usage) {
        const u = codexUsage(p.usage);
        modernCalls.push({ ts: Date.parse(ts), usage: usageKey(u) });
        modernSignatures.add(usageKey(codexUsage(p.thread_token_usage || {})));
        events.push({
          id: p.response_id
            ? "response:" + p.response_id
            : "record:" + hash([ts, p.usage]),
          ts,
          day: day(ts),
          agent,
          session: p.thread_id || sid,
          model,
          ...u,
        });
      }
      if (
        r.type === "event_msg" &&
        p.type === "token_count" &&
        p.info?.total_token_usage
      ) {
        const total = codexUsage(p.info.total_token_usage),
          sig = usageKey(total);
        if (!prev || sig !== usageKey(prev)) {
          // Counters are cumulative; repeated rate-limit snapshots must not add usage again.
          const last = p.info.last_token_usage
            ? codexUsage(p.info.last_token_usage)
            : null;
          const u =
            !prev && last
              ? last
              : Object.fromEntries(
                  Object.keys(total).map((k) => [
                    k,
                    Math.max(0, total[k] - (prev?.[k] || 0)),
                  ]),
                );
          counters.push({
            id: "counter:" + hash([ts, sig]),
            ts,
            day: day(ts),
            agent,
            session: sid,
            model,
            ...u,
            signature: sig,
            lastSignature: last ? usageKey(last) : null,
          });
          prev = total;
        }
      }
      if (
        r.type === "response_item" &&
        p.type === "message" &&
        ["user", "assistant"].includes(p.role)
      ) {
        const text = includeText ? clean(textOf(p.content)) : "";
        if (text) messages.push({ ts, day: day(ts), role: p.role, text });
      }
      if (
        r.type === "event_msg" &&
        ["user_message", "task_complete"].includes(p.type)
      ) {
        const text = includeText
          ? clean(p.message || p.last_agent_message)
          : "";
        if (text)
          messages.push({
            ts,
            day: day(ts),
            role: p.type === "user_message" ? "user" : "assistant",
            text,
          });
      }
    } else if (agent === "Claude Code" || agent === "Qoder Work") {
      sid = r.sessionId || sid;
      cwd = r.cwd || cwd;
      if (["user", "assistant"].includes(r.type)) {
        const text = includeText ? clean(textOf(m.content)) : "";
        if (text) messages.push({ ts, day: day(ts), role: r.type, text });
      }
      if (r.type === "assistant" && m.usage) {
        const u = m.usage,
          id = "response:" + (r.requestId || m.id || r.uuid || hash([ts, u]));
        const event = {
          id,
          aliases: [r.uuid, m.id, r.requestId]
            .filter(Boolean)
            .map((v) => "response:" + v),
          ts,
          day: day(ts),
          agent,
          session: sid,
          model: m.model || model,
          input:
            num(u.input_tokens) +
            num(u.cache_read_input_tokens) +
            num(u.cache_creation_input_tokens),
          cached: num(u.cache_read_input_tokens),
          cacheWrite: num(u.cache_creation_input_tokens),
          output: num(u.output_tokens),
          reasoning: 0,
        };
        // Streaming blocks can repeat the same message with a later, complete usage report.
        const old = messageMap.get(id);
        if (old)
          event.aliases = [...new Set([...old.aliases, ...event.aliases])];
        if (!old || event.input + event.output >= old.input + old.output)
          messageMap.set(id, event);
      }
    } else if (agent === "Pi" || agent === "Oh My Pi") {
      if (r.type === "message" && ["user", "assistant"].includes(m.role)) {
        const text = includeText ? clean(textOf(m.content)) : "";
        if (text) messages.push({ ts, day: day(ts), role: m.role, text });
      }
      if (r.type === "message" && m.role === "assistant" && m.usage) {
        const u = m.usage;
        events.push({
          id: "response:" + (m.responseId || r.id || hash([ts, u])),
          ts,
          day: day(ts),
          agent,
          session: sid,
          model: m.model || model,
          input: num(u.input) + num(u.cacheRead) + num(u.cacheWrite),
          cached: num(u.cacheRead),
          cacheWrite: num(u.cacheWrite),
          output: num(u.output),
          reasoning: num(u.reasoning),
        });
      }
    }
  }
  if (agent === "Codex")
    events.push(
      ...counters
        .filter(
          (e) =>
            !modernSignatures.has(e.signature) &&
            !modernCalls.some(
              (m) =>
                m.usage === e.lastSignature &&
                Math.abs(m.ts - Date.parse(e.ts)) < 60000,
            ),
        )
        .map(({ signature, lastSignature, ...e }) => e),
    );
  events.push(...messageMap.values());
  const days = {};
  for (const m of messages) {
    if (!m.day) continue;
    const s = (days[m.day] ||= { requests: [], results: [] });
    const a = m.role === "user" ? s.requests : s.results;
    if (!a.includes(m.text)) a.push(m.text);
  }
  return {
    events: events.filter((e) => e.day && e.input + e.output > 0),
    sessions: Object.entries(days).map(([date, s]) => ({
      id: sid,
      agent,
      day: date,
      project: includeText ? path.basename(cwd.replace(/\\/g, "/")) : "",
      requests: s.requests.slice(0, 4),
      results: s.results.slice(-2),
    })),
    malformed,
  };
}
async function scan(
  home = SETTINGS.home || os.homedir(),
  { includeText = SETTINGS.captureText === true } = {},
) {
  const cacheDir = path.join(
    home,
    ".cache",
    "ai-log",
    TIMEZONE.replace(/[^a-z0-9-]/gi, "_"),
    includeText ? "text-v1" : "stats-v1",
  );
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const events = [],
    sessions = [],
    inventory = [],
    errors = [];
  for (const [agent, dirs] of [
    ["Codex", [".codex/sessions", ".codex/archived_sessions"]],
    ["Claude Code", [".claude/projects"]],
    ["Pi", [".pi/agent/sessions"]],
    ["Oh My Pi", [".omp/agent/sessions"]],
    ["Qoder Work", [".qoderworkcn/projects"]],
  ]) {
    let files = [];
    for (const d of dirs)
      files.push(
        ...(await walk(path.join(home, d), (p) =>
          /\.jsonl(?:\.zst)?$/.test(p),
        )),
      );
    let count = 0,
      failed = 0;
    for (const file of files) {
      try {
        const st = fs.statSync(file),
          key = hash(file),
          cache = path.join(cacheDir, key + ".json");
        let data;
        try {
          const c = JSON.parse(fs.readFileSync(cache));
          if (c.version === 10 && c.size === st.size && c.mtime === st.mtimeMs)
            data = c.data;
        } catch {}
        if (!data) {
          data = await parseFile(file, agent, { includeText });
          const tmp = cache + ".tmp-" + process.pid;
          fs.writeFileSync(
            tmp,
            JSON.stringify({
              version: 10,
              size: st.size,
              mtime: st.mtimeMs,
              data,
            }),
            { mode: 0o600 },
          );
          fs.renameSync(tmp, cache);
        }
        events.push(...data.events);
        sessions.push(...data.sessions);
        count += data.events.length;
        if (data.malformed)
          errors.push({
            agent,
            file: path.basename(file),
            kind: "invalid-json-lines",
            count: data.malformed,
          });
      } catch (e) {
        failed++;
        errors.push({
          agent,
          file: path.basename(file),
          kind: e.code || e.name,
        });
      }
    }
    inventory.push({
      agent,
      files: files.length,
      events: count,
      status: failed
        ? "partial"
        : files.length
          ? count
            ? "collected"
            : "unavailable"
          : "not-found",
      failed,
    });
  }
  for (const relative of [
    ".local/share/opencode/opencode.db",
    "AppData/Roaming/opencode/opencode.db",
    ".zcode/cli/db/db.sqlite",
  ]) {
    const dbpath = path.join(home, relative),
      dbAgent = relative.includes(".zcode") ? "Zcode" : "OpenCode";
    if (!fs.existsSync(dbpath)) continue;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbpath, { readOnly: true });
      const titles = new Map();
      for (const s of db
        .prepare("SELECT id,title,directory FROM session")
        .all())
        titles.set(s.id, s);
      const msgs = db.prepare("SELECT id,session_id,data FROM message").all(),
        byId = new Map(msgs.map((m) => [m.id, m]));
      let count = 0;
      for (const row of msgs) {
        let m;
        try {
          m = JSON.parse(row.data);
        } catch {
          continue;
        }
        const ts = new Date(
            m.time?.completed || m.time?.created || 0,
          ).toISOString(),
          date = day(ts),
          u = m.tokens;
        if (dbAgent !== "Zcode" && m.role === "assistant" && u) {
          events.push({
            id: dbAgent + ":" + row.id,
            ts,
            day: date,
            agent: dbAgent,
            session: row.session_id,
            model: m.modelID || "unknown",
            ...openCodeUsage(u),
          });
          count++;
        }
      }
      if (dbAgent === "Zcode")
        for (const row of db
          .prepare(
            "SELECT id,session_id,model_id,input_tokens,output_tokens,reasoning_tokens,cache_read_input_tokens,cache_creation_input_tokens,completed_at,started_at FROM model_usage",
          )
          .all()) {
          if (!row.input_tokens && !row.output_tokens) continue;
          const ts = new Date(row.completed_at || row.started_at).toISOString();
          events.push({
            id: "zcode-usage:" + row.id,
            ts,
            day: day(ts),
            agent: dbAgent,
            session: row.session_id,
            model: row.model_id || "unknown",
            ...zcodeUsage(row),
          });
          count++;
        }
      // Only text parts are used; tool arguments and results never leave the device.
      const groups = new Map();
      if (includeText)
        for (const row of db
          .prepare("SELECT message_id,session_id,data FROM part")
          .all()) {
          let p;
          try {
            p = JSON.parse(row.data);
          } catch {
            continue;
          }
          if (p.type !== "text") continue;
          const m = byId.get(row.message_id);
          if (!m) continue;
          const msg = JSON.parse(m.data),
            date = day(msg.time?.created),
            text = clean(p.text);
          if (!text || !date) continue;
          const key = row.session_id + ":" + date;
          let g = groups.get(key);
          if (!g) {
            g = {
              id: row.session_id,
              agent: dbAgent,
              day: date,
              project: path.basename(
                titles.get(row.session_id)?.directory || "",
              ),
              requests: [],
              results: [],
            };
            groups.set(key, g);
          }
          const a = msg.role === "user" ? g.requests : g.results;
          if (!a.includes(text)) a.push(text);
        }
      for (const g of groups.values())
        sessions.push({
          ...g,
          requests: g.requests.slice(0, 4),
          results: g.results.slice(-2),
        });
      db.close();
      inventory.push({
        agent: dbAgent,
        files: 1,
        events: count,
        status: "collected",
      });
    } catch (e) {
      inventory.push({
        agent: dbAgent,
        files: 1,
        events: 0,
        status: "partial",
      });
      errors.push({ agent: dbAgent, kind: e.code || e.name });
    }
  }
  const proxyPath = path.join(home, ".cc-switch/cc-switch.db");
  if (fs.existsSync(proxyPath))
    try {
      const { DatabaseSync } = require("node:sqlite"),
        db = new DatabaseSync(proxyPath, { readOnly: true });
      const known = new Set(
        events.flatMap((e) => [e.id, ...(e.aliases || [])]),
      );
      let count = 0,
        duplicates = 0;
      for (const r of db
        .prepare(
          "SELECT request_id,app_type,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,session_id,created_at FROM proxy_request_logs",
        )
        .all()) {
        const id = "response:" + r.request_id.replace(/^session:/, "");
        if (known.has(id)) {
          duplicates++;
          continue;
        }
        const ts = new Date(r.created_at * 1000).toISOString();
        if (
          !r.input_tokens &&
          !r.output_tokens &&
          !r.cache_read_tokens &&
          !r.cache_creation_tokens
        )
          continue;
        events.push({
          id,
          ts,
          day: day(ts),
          agent: r.app_type === "claude" ? "Claude Code" : r.app_type,
          session: r.session_id || id,
          model: r.model || "unknown",
          input:
            num(r.input_tokens) +
            num(r.cache_read_tokens) +
            num(r.cache_creation_tokens),
          cached: num(r.cache_read_tokens),
          cacheWrite: num(r.cache_creation_tokens),
          output: num(r.output_tokens),
          reasoning: 0,
        });
        known.add(id);
        count++;
      }
      db.close();
      inventory.push({
        agent: "CC Switch 历史用量",
        files: 1,
        events: count,
        duplicates,
        status: "collected",
      });
    } catch (e) {
      inventory.push({
        agent: "CC Switch 历史用量",
        files: 1,
        status: "partial",
      });
      errors.push({ agent: "CC Switch", kind: e.code || e.name });
    }
  if (!inventory.some((x) => x.agent === "OpenCode"))
    inventory.push({
      agent: "OpenCode",
      status: "not-found",
      files: 0,
      events: 0,
    });
  for (const [agent, dirs] of [
    ["Gemini CLI", [".gemini/tmp"]],
    [
      "GitHub Copilot",
      [
        ".copilot/session-state",
        "AppData/Roaming/Code/User/globalStorage/github.copilot-chat",
      ],
    ],
    ["Cursor", [".cursor/projects"]],
    [
      "Cline",
      ["AppData/Roaming/Code/User/globalStorage/saoudrizwan.claude-dev"],
    ],
    [
      "Roo Code",
      ["AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline"],
    ],
    [
      "Kilo Code",
      ["AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code"],
    ],
    ["DeepSeek Shell", [".dsh"]],
    ["Nanobot", [".nanobot/workspace/sessions"]],
    ["Qoder CLI", [".qoder-cli"]],
    ["LM Studio", [".lmstudio/conversations"]],
  ]) {
    const found = dirs.filter((p) => fs.existsSync(path.join(home, p)));
    inventory.push({
      agent,
      status: found.length ? "unavailable" : "not-found",
      paths: found,
    });
  }
  return {
    version: 1,
    timezone: TIMEZONE,
    captureText: includeText,
    scannedAt: new Date().toISOString(),
    events,
    sessions,
    inventory,
    errors,
  };
}
module.exports = {
  scan,
  parseFile,
  clean,
  day,
  codexUsage,
  openCodeUsage,
  zcodeUsage,
};
if (require.main === module || module.id === "[stdin]") {
  scan()
    .then((x) =>
      process.stdout.write(zlib.gzipSync(JSON.stringify(x)).toString("base64")),
    )
    .catch((e) => {
      console.error(e.code || e.name);
      process.exitCode = 1;
    });
}
