const path = require("node:path");
const { DIR, read, atomic, build, today } = require("./core.cjs");
const { shift } = require("./periods.cjs");
const zlib = require("node:zlib");
const fs = require("node:fs");
function demo() {
  if (
    fs.existsSync(path.join(DIR, "sources.json")) ||
    fs.existsSync(path.join(DIR, "index.json"))
  )
    throw new Error("Demo needs an empty data directory; use --data-dir");
  const events = [],
    sessions = [];
  for (let i = 0; i < 120; i++) {
    if (i % 7 === 3) continue;
    const date = shift(today(), -i);
    const input = ((i * 7919) % 85000) + 1000,
      output = ((i * 317) % 5000) + 100;
    const agent = i % 2 ? "Codex" : "Claude Code";
    events.push({
      id: "synthetic-" + i,
      day: date,
      agent,
      session: "demo-" + i,
      model: "demo-model",
      input,
      cached: Math.floor(input * 0.6),
      output,
      reasoning: 0,
    });
    sessions.push({
      id: "demo-" + i,
      day: date,
      agent,
      project: "sample-project",
      requests: ["完善示例项目的搜索界面"],
      results: ["会话报告：调整筛选条件并通过模拟测试。"],
    });
  }
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(DIR, "demo.json.gz"),
    zlib.gzipSync(
      JSON.stringify({
        version: 1,
        timezone: "Asia/Shanghai",
        captureText: true,
        events,
        sessions,
      }),
    ),
    { mode: 0o600 },
  );
  atomic(path.join(DIR, "sources.json"), {
    demo: {
      name: "Demo · synthetic data",
      status: "ok",
      lastSuccess: new Date().toISOString(),
      events: events.length,
      inventory: [
        {
          agent: "Synthetic fixtures",
          status: "collected",
          events: events.length,
        },
      ],
    },
  });
  const index = build();
  const summaries = {};
  for (const day of index.dates)
    summaries[day.date] = {
      text: "这是模拟回顾：调整示例项目的搜索与筛选界面，会话报告已通过测试。没有调用 AI 模型。",
      sourceHash: read(path.join(DIR, "days", day.date + ".json")).sourceHash,
      model: "synthetic",
      generatedAt: new Date().toISOString(),
    };
  atomic(path.join(DIR, "summaries.json"), summaries);
  atomic(path.join(DIR, "heartbeat.json"), {
    pid: process.pid,
    at: new Date().toISOString(),
  });
  return index;
}
module.exports = { demo };
