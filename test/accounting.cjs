const assert = require("assert/strict"),
  fs = require("fs"),
  os = require("os"),
  path = require("path");
const {
    parseFile,
    clean,
    day,
    openCodeUsage,
    zcodeUsage,
  } = require("../src/scanner.cjs"),
  { aggregate } = require("../src/core.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-log-test-"));
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok " + name);
}
(async () => {
  try {
    check("Beijing natural day boundary", () => {
      assert.equal(day("2026-11-03T15:59:59Z"), "2026-11-03");
      assert.equal(day("2026-11-03T16:00:00Z"), "2026-11-04");
      assert.equal(day("2026-11-03T19:00:00Z"), "2026-11-04");
    });
    check("strip credentials and instruction context", () => {
      assert(
        !clean(
          "hello -----BEGIN OPENSSH PRIVATE KEY-----\nprivate material\n-----END OPENSSH PRIVATE KEY----- goodbye",
        ).includes("private material"),
      );
      assert.equal(
        clean("# AGENTS.md instructions\n<INSTRUCTIONS>secret</INSTRUCTIONS>"),
        "",
      );
      assert(!clean("apiKey=abc123").includes("abc123"));
    });
    const ts = "2026-11-04T02:00:00Z";
    const usage = {
      input_tokens: 100,
      cached_input_tokens: 60,
      output_tokens: 10,
      reasoning_output_tokens: 4,
    };
    const meta = {
        type: "session_meta",
        payload: { id: "s", cwd: "/project" },
      },
      counter = {
        timestamp: ts,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: usage, last_token_usage: usage },
        },
      },
      modern = {
        timestamp: ts,
        type: "token_usage_record",
        payload: {
          response_id: "r1",
          thread_id: "s",
          usage,
          thread_token_usage: usage,
        },
      };
    const file = path.join(root, "sample.jsonl");
    fs.writeFileSync(
      file,
      [meta, modern, counter, counter].map(JSON.stringify).join("\n"),
    );
    let data = await parseFile(file, "Codex");
    check("modern record and counter count once", () => {
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].input, 100);
      assert.equal(data.events[0].output, 10);
    });
    const drift = JSON.parse(JSON.stringify(counter));
    drift.timestamp = "2026-11-04T02:00:00.250Z";
    drift.payload.info.total_token_usage = { ...usage, input_tokens: 1000 };
    fs.writeFileSync(
      file,
      [meta, modern, drift].map(JSON.stringify).join("\n"),
    );
    data = await parseFile(file, "Codex");
    check("Codex cumulative drift never duplicates per-response usage", () => {
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].input + data.events[0].output, 110);
    });
    fs.writeFileSync(file, [meta, drift].map(JSON.stringify).join("\n"));
    data = await parseFile(file, "Codex");
    check(
      "legacy fork inherited cumulative baseline is not assigned to the first observed day",
      () => {
        assert.equal(data.events[0].input + data.events[0].output, 110);
      },
    );
    const second = JSON.parse(JSON.stringify(counter));
    second.timestamp = "2026-11-04T02:01:00Z";
    second.payload.info.total_token_usage = {
      input_tokens: 180,
      cached_input_tokens: 100,
      output_tokens: 30,
      reasoning_output_tokens: 8,
    };
    fs.writeFileSync(
      file,
      [meta, counter, counter, second].map(JSON.stringify).join("\n"),
    );
    data = await parseFile(file, "Codex");
    check("legacy cumulative deltas and repeated counters", () => {
      assert.equal(data.events.length, 2);
      assert.equal(data.events[1].input, 80);
      assert.equal(data.events[1].output, 20);
    });
    let result = aggregate([
      { id: "one", name: "One", data },
      { id: "two", name: "Two", data },
    ]);
    check("migrated logs and fork copies deduplicate across devices", () => {
      assert.equal(result.duplicates, 2);
      assert.equal(result.days["2026-11-04"].input, 180);
      assert.equal(result.days["2026-11-04"].total, 210);
    });
    const c = {
      timestamp: ts,
      type: "assistant",
      sessionId: "c",
      message: {
        id: "m",
        model: "claude",
        usage: {
          input_tokens: 30,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          output_tokens: 5,
        },
      },
    };
    const c2 = JSON.parse(JSON.stringify(c));
    c2.message.usage.output_tokens = 15;
    fs.writeFileSync(file, [c, c2].map(JSON.stringify).join("\n"));
    data = await parseFile(file, "Claude Code");
    check("Claude cache inputs normalized and streamed blocks merged", () => {
      assert.equal(data.events.length, 1);
      assert.equal(data.events[0].input, 150);
      assert.equal(data.events[0].output, 15);
    });
    fs.writeFileSync(
      file,
      JSON.stringify({ type: "session", id: "pi" }) +
        "\n" +
        JSON.stringify({
          timestamp: ts,
          type: "message",
          id: "p",
          message: {
            role: "assistant",
            usage: {
              input: 40,
              cacheRead: 50,
              cacheWrite: 5,
              output: 20,
              reasoning: 3,
            },
          },
        }),
    );
    data = await parseFile(file, "Pi");
    check("Pi cache inputs normalized without adding reasoning twice", () => {
      assert.equal(data.events[0].input, 95);
      assert.equal(data.events[0].output, 20);
      assert.equal(data.events[0].reasoning, 3);
    });
    check("OpenCode restores cache and reasoning fields exactly once", () => {
      const u = openCodeUsage({
        input: 10,
        cache: { read: 60, write: 5 },
        output: 12,
        reasoning: 8,
      });
      assert.equal(u.input, 75);
      assert.equal(u.output, 20);
    });
    check(
      "Zcode inclusive provider totals do not add cache or reasoning twice",
      () => {
        const u = zcodeUsage({
          input_tokens: 18533,
          cache_read_input_tokens: 11712,
          output_tokens: 780,
          reasoning_tokens: 100,
        });
        assert.equal(u.input + u.output, 19313);
      },
    );
    const aliased = {
      id: "response:message-id",
      aliases: ["response:uuid"],
      day: "2026-11-04",
      agent: "Claude Code",
      session: "one",
      model: "m",
      input: 100,
      output: 10,
    };
    const imported = { ...aliased, id: "response:uuid", aliases: [] };
    check(
      "CC Switch imported assistant UUIDs deduplicate with transcripts",
      () => {
        const r = aggregate([
          { id: "a", name: "A", data: { events: [aliased], sessions: [] } },
          { id: "b", name: "B", data: { events: [imported], sessions: [] } },
        ]);
        assert.equal(r.days["2026-11-04"].total, 110);
        assert.equal(r.duplicates, 1);
      },
    );
    const noisy = path.join(root, "noise.jsonl"),
      badMeta =
        '{"type":"event_msg","payload":{"type":"task_started","turn_id":"unfinished',
      badUsage = '{"type":"event_msg","payload":{"type":"token_count","info":';
    const wslParse = () =>
      JSON.parse(
        require("child_process").execFileSync(
          process.env.PYTHON || "python3",
          [
            "-c",
            'import importlib.util,json,pathlib,sys; s=importlib.util.spec_from_file_location("scan",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.parse(pathlib.Path(sys.argv[2]))))',
            path.join(__dirname, "../src/scan-wsl.py"),
            noisy,
          ],
          { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } },
        ),
      );
    fs.writeFileSync(
      noisy,
      [JSON.stringify(meta), badMeta, "", JSON.stringify(counter)].join("\n"),
    );
    let jsNoise = await parseFile(noisy, "Codex"),
      pyNoise = wslParse();
    check(
      "truncated non-usage startup metadata is silent in both scanners",
      () => {
        for (const d of [jsNoise, pyNoise]) {
          assert.equal(d.malformed, 0);
          assert.equal(d.events.length, 1);
          assert.equal(d.events[0].input + d.events[0].output, 110);
        }
      },
    );
    fs.appendFileSync(noisy, "\n" + badUsage);
    jsNoise = await parseFile(noisy, "Codex");
    pyNoise = wslParse();
    check(
      "damaged token records still report incomplete usage in both scanners",
      () => {
        for (const d of [jsNoise, pyNoise]) {
          assert.equal(d.malformed, 1);
          assert.equal(d.events.length, 1);
        }
      },
    );
    const compressed = path.join(root, "compressed.jsonl.zst");
    fs.writeFileSync(
      compressed,
      require("zlib").zstdCompressSync(fs.readFileSync(file)),
    );
    const compressedData = await parseFile(compressed, "Pi");
    check("compressed and plain history equivalent", () =>
      assert.deepEqual(compressedData, data),
    );
    console.log(passed + " groups passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
