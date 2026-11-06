const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-log-integration-"));
process.env.AI_LOG_CONFIG = path.join(root, "config.json");
process.env.AI_LOG_DIR = path.join(root, "data");
const { defaults, load } = require("../src/config.cjs");
const config = defaults();
config.dataDir = process.env.AI_LOG_DIR;
const home = path.join(root, "fake-home");
fs.mkdirSync(path.join(home, ".codex", "sessions"), { recursive: true });
const ts = "2026-01-01T16:00:00Z";
const record = {
  timestamp: ts,
  type: "token_usage_record",
  payload: {
    thread_id: "demo-session",
    response_id: "demo-response",
    usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 },
  },
};
const message = {
  timestamp: ts,
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: "PRIVATE_SENTINEL_7429 build a sample search form",
      },
    ],
  },
};
const history = path.join(home, ".codex", "sessions", "sample.jsonl");
fs.writeFileSync(history, [record, message].map(JSON.stringify).join("\n"));
config.sources = [
  { id: "fixture", name: "Synthetic laptop", type: "local", home },
];
fs.writeFileSync(process.env.AI_LOG_CONFIG, JSON.stringify(config));
const { scan, parseFile } = require("../src/scanner.cjs");
const {
  collect,
  normalize,
  scriptFor,
  commandFor,
} = require("../src/collector.cjs");
const { read, DIR } = require("../src/core.cjs");
const { bounds, getPeriod } = require("../src/periods.cjs");
let server;
(async () => {
  try {
    assert.equal(bounds("week", "2027-01-01").from, "2026-12-28");
    assert.equal(bounds("month", "2024-02-03").to, "2024-02-29");
    assert.equal(bounds("month", "2026-02-03").to, "2026-02-28");
    console.log(
      "PASS calendar periods include leap years and ISO week boundaries",
    );
    let snapshot = await scan(home);
    assert.equal(snapshot.events[0].day, "2026-01-02");
    assert.equal(snapshot.sessions.length, 0);
    for (const file of fs.readdirSync(
      path.join(home, ".cache", "ai-log", "Asia_Shanghai", "stats-v1"),
    ))
      assert(
        !fs
          .readFileSync(
            path.join(
              home,
              ".cache",
              "ai-log",
              "Asia_Shanghai",
              "stats-v1",
              file,
            ),
            "utf8",
          )
          .includes("PRIVATE_SENTINEL"),
      );
    console.log("PASS default scanner and its local cache contain no excerpts");
    const withText = await scan(home, { includeText: true });
    assert(withText.sessions[0].requests[0].includes("PRIVATE_SENTINEL"));
    snapshot = await scan(home);
    assert.equal(snapshot.sessions.length, 0);
    assert.equal(normalize(withText, config).sessions.length, 0);
    assert.throws(
      () => normalize({ ...snapshot, timezone: "UTC" }, config),
      /timezone/,
    );
    console.log(
      "PASS text opt-in has a separate cache and stats-only imports strip all text",
    );
    const py = spawnSync(process.env.PYTHON || "python3", ["-"], {
      input: scriptFor({ type: "wsl", home }, config),
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
    });
    assert.equal(py.status, 0, py.stderr);
    const pyData = JSON.parse(
      zlib.gunzipSync(Buffer.from(py.stdout.trim(), "base64")),
    );
    assert.equal(pyData.events[0].day, "2026-01-02");
    assert.equal(pyData.sessions.length, 0);
    const pyText = spawnSync(process.env.PYTHON || "python3", ["-"], {
      input: scriptFor({ type: "wsl", home }, { ...config, captureText: true }),
      encoding: "utf8",
    });
    assert.equal(pyText.status, 0, pyText.stderr);
    assert(
      JSON.parse(
        zlib.gunzipSync(Buffer.from(pyText.stdout.trim(), "base64")),
      ).sessions[0].requests[0].includes("PRIVATE_SENTINEL"),
    );
    console.log(
      "PASS Python WSL fallback enforces the same privacy and day boundary",
    );
    let index = await collect(config);
    assert.equal(index.dates[0].total, 110);
    assert.equal(index.sources.fixture.status, "ok");
    assert.equal(getPeriod("total", "2026-01-02").day.total, 110);
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(DIR, "index.json")).mode & 0o777,
        0o600,
      );
    assert(
      !JSON.stringify(read(path.join(DIR, "days", "2026-01-02.json"))).includes(
        "PRIVATE_SENTINEL",
      ),
    );
    const mtime = fs.statSync(
      path.join(DIR, "periods", "total_all.json"),
    ).mtimeMs;
    index = await collect(config);
    assert.equal(index.dates[0].total, 110);
    assert.equal(
      fs.statSync(path.join(DIR, "periods", "total_all.json")).mtimeMs,
      mtime,
    );
    console.log(
      "PASS end-to-end local collection, normalized totals and unchanged period reuse",
    );
    const file = path.join(root, "snapshot.json");
    fs.writeFileSync(file, JSON.stringify(snapshot));
    config.sources = [
      { id: "fixture", name: "Imported snapshot", type: "file", path: file },
    ];
    await collect(config);
    fs.unlinkSync(file);
    index = await collect(config);
    assert.equal(index.sources.fixture.status, "error");
    assert.equal(index.dates[0].total, 110);
    assert(index.sources.fixture.lastSuccess);
    console.log(
      "PASS failed source preserves last snapshot and success timestamp",
    );
    const lock = path.join(DIR, "collect.lock");
    fs.writeFileSync(lock, String(process.pid));
    await assert.rejects(() => collect(config), /Another/);
    fs.unlinkSync(lock);
    console.log("PASS collector lock prevents concurrent mutation");
    const utc = spawnSync(
      process.execPath,
      [
        "-e",
        "console.log(require('./src/scanner.cjs').day('2026-01-01T16:00:00Z'))",
      ],
      {
        cwd: path.join(__dirname, ".."),
        env: { ...process.env, AI_LOG_TIMEZONE: "UTC" },
        encoding: "utf8",
      },
    );
    assert.equal(utc.stdout.trim(), "2026-01-01");
    const local = commandFor({
      type: "wsl",
      distro: "Example",
      user: "sample",
    });
    assert.deepEqual(local.args, [
      "-d",
      "Example",
      "-u",
      "sample",
      "--exec",
      "python3",
      "-",
    ]);
    const ssh = commandFor({ type: "ssh", host: "sample-host" });
    assert.equal(ssh.args.at(-1), "node --no-warnings -");
    fs.writeFileSync(
      process.env.AI_LOG_CONFIG,
      JSON.stringify({
        ...config,
        sources: [{ id: "../bad", type: "ssh", host: "-oProxyCommand=x" }],
      }),
    );
    assert.throws(load);
    fs.writeFileSync(
      process.env.AI_LOG_CONFIG,
      JSON.stringify({ ...defaults(), dataDir: DIR }),
    );
    console.log(
      "PASS configurable timezone, WSL/SSH commands and unsafe configuration rejection",
    );
    server = require("../src/server.cjs").createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    for (const url of [
      "/",
      "/ai/",
      "/ai/?period=week&date=2026-01-02",
      "/ai/?period=month",
      "/ai/?period=year",
      "/ai/?period=total",
      "/ai/status/",
    ]) {
      const response = await fetch(base + url);
      assert.equal(response.status, 200);
      const body = await response.text();
      assert(!body.includes("PRIVATE_SENTINEL"));
      assert(body.includes("Token-Diary"));
      if (url === "/") assert(body.includes("ai-heatmap-days"));
      else assert(!body.includes('class="ai-heatmap-days"'));
    }
    assert.equal((await fetch(base + "/ai/?date=2026-02-30")).status, 400);
    assert.equal((await fetch(base + "/ai/?period=nope")).status, 400);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);
    const hostile = await new Promise((resolve, reject) => {
      const request = require("node:http").get(
        base + "/",
        { headers: { Host: "attacker.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    });
    assert.equal(hostile, 403);
    assert.equal((await fetch(base + "/missing")).status, 404);
    console.log(
      "PASS read-only loopback web views, heatmap placement, dates, Host protection and methods",
    );
    const output = spawnSync(
      process.execPath,
      ["bin/ai-log.cjs", "export", "--format", "json"],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    );
    assert.equal(output.status, 0, output.stderr);
    assert.equal(JSON.parse(output.stdout).dates[0].total, 110);
    const markdown = spawnSync(
      process.execPath,
      ["bin/ai-log.cjs", "export", "--format", "markdown"],
      { cwd: path.join(__dirname, ".."), encoding: "utf8" },
    );
    assert(markdown.stdout.includes("110 tokens"));
    console.log(
      "PASS CLI exports reusable JSON and Markdown without live model calls",
    );
    const { atomic, getDay } = require("../src/core.cjs");
    atomic(path.join(DIR, "summaries.json"), {
      "2026-01-02": { text: "REMOVED_SOURCE_REVIEW", sourceHash: "old" },
    });
    atomic(path.join(DIR, "period-summaries.json"), {
      "month:2026-01": { text: "REMOVED_PERIOD_REVIEW", hash: "old" },
    });
    assert.match(require("../src/view.cjs").render("2026-01-02", "", ""), /Review updates disabled/);
    fs.writeFileSync(file, JSON.stringify({ ...snapshot, events: [], sessions: [] }));
    config.sources = [{ id: "replacement", type: "file", path: file }];
    index = await collect(config);
    assert.equal(index.dates.length, 0);
    // Old cache files may remain on disk, but no longer belong to the current index.
    assert(fs.existsSync(path.join(DIR, "days", "2026-01-02.json")));
    assert.equal(getDay("2026-01-02").day.total, 0);
    assert.equal(getDay("2026-01-02").summary, null);
    for (const kind of ["week", "month", "year", "total"]) {
      assert.equal(getPeriod(kind, "2026-01-02").day.total, 0);
      assert.equal(getPeriod(kind, "2026-01-02").summary, null);
      const body = await (await fetch(base + "/ai/?period=" + kind + "&date=2026-01-02")).text();
      assert(!body.includes("REMOVED_"));
    }
    const removedExport = spawnSync(process.execPath, ["bin/ai-log.cjs", "export"], {
      cwd: path.join(__dirname, ".."), encoding: "utf8",
    });
    assert.equal(removedExport.status, 0, removedExport.stderr);
    assert.deepEqual(JSON.parse(removedExport.stdout).summaries, {});
    assert.equal(JSON.parse(removedExport.stdout).dates.length, 0);
    console.log("PASS removed sources invalidate daily/period views and exported reviews");

  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
