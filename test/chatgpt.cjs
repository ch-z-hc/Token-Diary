const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  zlib = require("node:zlib"),
  { spawnSync } = require("node:child_process");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-import-"));
process.env.AI_LOG_DIR = path.join(root, "data");
process.env.AI_LOG_CONFIG = path.join(root, "config.json");
const { parse, scan } = require("../src/chatgpt.cjs"),
  { aggregate, atomic, DIR, read } = require("../src/core.cjs"),
  { merge, buildPeriods } = require("../src/periods.cjs"),
  { normalize } = require("../src/collector.cjs");
const node = (id, parent, role, type, text, time, metadata = {}) => ({
  id,
  parent,
  message: role
    ? {
        id,
        author: { role },
        create_time: Date.parse(time) / 1000,
        content: { content_type: type, parts: [text] },
        metadata,
      }
    : null,
});
const c = {
  id: "conversation",
  current_node: "answer",
  title: "PRIVATE_TITLE",
  update_time: 1,
  mapping: {
    root: node("root", null),
    user: node(
      "user",
      "root",
      "user",
      "text",
      "PRIVATE_INTENT apiKey=redact-me",
      "2024-02-28T15:59:00Z",
    ),
    thought: node(
      "thought",
      "user",
      "assistant",
      "thoughts",
      "PRIVATE_THOUGHT",
      "2024-02-28T16:00:00Z",
    ),
    answer: node(
      "answer",
      "thought",
      "assistant",
      "text",
      "PRIVATE_RESULT",
      "2024-02-28T16:01:00Z",
    ),
    alternate: node(
      "alternate",
      "user",
      "assistant",
      "text",
      "PRIVATE_WRONG_BRANCH",
      "2024-02-28T16:02:00Z",
    ),
  },
};
function zip(entries) {
  const locals = [],
    headers = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const filename = Buffer.from(name),
      bytes = Buffer.from(text),
      compressed = zlib.deflateRawSync(bytes),
      crc = zlib.crc32(bytes),
      local = Buffer.alloc(30),
      central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, filename, compressed);
    headers.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(headers),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
(async () => {
  try {
    let data = parse([[c]], { timezone: "Asia/Shanghai" });
    assert.equal(data.events.length, 2);
    assert.equal(data.sessions.length, 0);
    assert(!JSON.stringify(data).includes("PRIVATE_"));
    assert(
      data.events.every(
        (e) => e.input === null && e.output === null && e.tokensKnown === false,
      ),
    );
    assert.deepEqual(
      data.events.map((e) => e.day),
      ["2024-02-28", "2024-02-29"],
    );
    console.log(
      "PASS current branch, midnight boundary, hidden reasoning exclusion and no text by default",
    );
    const text = parse([[c]], { captureText: true });
    assert.equal(text.sessions.length, 2);
    assert(text.sessions[0].requests[0].includes("已隐去"));
    assert(!JSON.stringify(text).includes("redact-me"));
    assert(!JSON.stringify(text).includes("PRIVATE_THOUGHT"));
    assert(!JSON.stringify(text).includes("PRIVATE_WRONG_BRANCH"));
    console.log(
      "PASS optional excerpts are bounded and sanitized; discarded branches and thoughts stay out",
    );
    const updated = structuredClone(c);
    updated.update_time = 2;
    updated.current_node = "next";
    updated.mapping.next = node(
      "next",
      "answer",
      "user",
      "multimodal_text",
      { asset_pointer: "PRIVATE_IMAGE" },
      "2024-02-29T01:00:00Z",
    );
    data = parse([[updated], [c]], { captureText: true });
    assert.equal(data.events.length, 3);
    assert(!JSON.stringify(data).includes("PRIVATE_IMAGE"));
    assert.equal(parse([[updated], [updated]]).events.length, 3);
    console.log(
      "PASS multipart latest conversation selection and repeated messages deduplicate",
    );
    const hidden = structuredClone(c);
    hidden.mapping.answer.message.metadata.is_visually_hidden_from_conversation = true;
    assert.equal(parse([[hidden]]).events.length, 1);
    const bad = structuredClone(c);
    bad.mapping.root.parent = "answer";
    assert.equal(parse([[bad]]).errors.length, 1);
    assert.throws(() => parse({}), /export/);
    console.log(
      "PASS hidden final messages, corrupt branches and unsupported exports are handled explicitly",
    );
    const archive = path.join(root, "export.zip");
    fs.writeFileSync(
      archive,
      zip([
        ["conversations-000.json", JSON.stringify([c])],
        ["conversations-001.json", JSON.stringify([c])],
        ["../../private-attachment.txt", "DO_NOT_EXTRACT"],
      ]),
    );
    const imported = scan(archive, { captureText: true });
    assert.equal(imported.events.length, 2);
    assert.equal(imported.inventory[0].files, 2);
    assert(!fs.existsSync(path.join(root, "private-attachment.txt")));
    const damaged = Buffer.from(fs.readFileSync(archive));
    damaged[60] ^= 255;
    fs.writeFileSync(path.join(root, "bad.zip"), damaged);
    assert.throws(() => scan(path.join(root, "bad.zip")));
    console.log(
      "PASS ZIP shards import without extracting attachments; corrupted archives rejected",
    );
    const dir = path.join(root, "parts");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "conversations-000.json"),
      JSON.stringify([c]),
    );
    fs.writeFileSync(
      path.join(dir, "conversations-001.json"),
      JSON.stringify([c]),
    );
    assert.equal(scan(dir).events.length, 2);
    console.log(
      "PASS unpacked JSON parts and ZIP inputs produce the same records",
    );
    const normalized = normalize(imported, {
      timezone: "Asia/Shanghai",
      captureText: false,
    });
    assert.equal(normalized.sessions.length, 0);
    assert(normalized.events.every((e) => e.input === null));
    const snapshots = [
        { name: "Export", data: imported },
        { name: "Duplicate export", data: imported },
      ],
      result = aggregate(snapshots);
    assert.equal(result.duplicates, 2);
    assert.equal(result.days["2024-02-28"].messages, 1);
    assert.equal(result.days["2024-02-28"].requests, 0);
    assert.equal(result.days["2024-02-29"].unknownUsage, 1);
    const period = merge("month", "2024-02-29", Object.values(result.days));
    assert.equal(period.messages, 2);
    assert.equal(period.userMessages, 1);
    assert.equal(period.assistantMessages, 1);
    assert.equal(period.requests, 0);
    assert.equal(period.sessionCount, 1);
    assert.equal(period.source.length, 2);
    console.log(
      "PASS unknown token events retain chat counts, cross-day sessions and Review inputs without counted usage",
    );
    const known = structuredClone(c);
    known.mapping.answer.message.metadata.usage = {
      input_tokens: 100,
      output_tokens: 20,
      cached_input_tokens: 60,
    };
    const withKnown = aggregate([
      { name: "Export", data: parse([[known]]) },
    ]).days;
    assert.equal(withKnown["2024-02-29"].total, 120);
    assert.equal(withKnown["2024-02-29"].unknownUsage, 0);
    console.log(
      "PASS explicitly recorded usage counts once; user messages are not model calls",
    );
    for (const day of Object.values(result.days))
      atomic(path.join(DIR, "days", day.date + ".json"), day);
    const index = {
      dates: Object.values(result.days).map((d) => ({ ...d })),
      sources: {},
    };
    atomic(path.join(DIR, "index.json"), index);
    buildPeriods(index);
    const html = require("../src/view.cjs").render("2024-02-29", "", "", "day");
    assert(html.includes("<strong>未知</strong>"));
    assert(html.includes("ai-chat-notice"));
    assert(html.includes("PRIVATE_RESULT") === false);
    assert(html.includes("ChatGPT"));
    assert(html.includes("会话主题"));
    const heatmap = require("../src/heatmap.cjs");
    const cell = heatmap
      .calendar("2024", index.dates, "2024-03-01")
      .cells.find((d) => d.date === "2024-02-29");
    assert.equal(cell.total, null);
    assert.equal(cell.known, false);
    assert.equal(cell.messages, 1);
    assert(
      heatmap
        .renderHeatmap(index, "2024", "2024-02-29", "2024-02-29")
        .includes("token 未知"),
    );
    console.log(
      "PASS chat-only UI and heatmap expose unknown usage rather than fabricated zero",
    );
    atomic(path.join(DIR, "sources.json"), {});
    const config = {
      dataDir: DIR,
      sources: [{ id: "fixture", type: "local", home: dir }],
      captureText: false,
    };
    fs.writeFileSync(process.env.AI_LOG_CONFIG, JSON.stringify(config));
    const run = () =>
      spawnSync(
        process.execPath,
        ["bin/ai-log.cjs", "import-chatgpt", archive],
        { cwd: path.join(__dirname, ".."), env: process.env, encoding: "utf8" },
      );
    let cli = run();
    assert.equal(cli.status, 0, cli.stderr);
    const first = read(path.join(DIR, "index.json"));
    cli = run();
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(read(path.join(DIR, "index.json")).dates, first.dates);
    assert.equal(read(path.join(DIR, "days", "2024-02-29.json")).messages, 1);
    assert.equal(
      JSON.parse(fs.readFileSync(process.env.AI_LOG_CONFIG)).sources.at(-1)
        .type,
      "chatgpt",
    );
    assert(
      !zlib
        .gunzipSync(fs.readFileSync(path.join(DIR, "chatgpt.json.gz")))
        .toString()
        .includes("PRIVATE_"),
    );
    console.log(
      "PASS CLI import persists source config, remains idempotent and invokes no model",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
