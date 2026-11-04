const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-log-reviews-"));
process.env.AI_LOG_CONFIG = path.join(root, "config.json");
process.env.AI_LOG_DIR = root;
const { defaults } = require("../src/config.cjs");
const config = defaults();
config.captureText = true;
config.review.enabled = true;
config.review.maxCallsPerRun = 30;
config.review.maxCallsPerDay = 100;
fs.writeFileSync(process.env.AI_LOG_CONFIG, JSON.stringify(config));
const { aggregate, atomic, read, today } = require("../src/core.cjs");
const { buildPeriods, shift } = require("../src/periods.cjs");
const { tasks, review, invoke } = require("../src/reviews.cjs");
const days = aggregate([
  {
    name: "Synthetic device",
    data: {
      events: ["2024-02-28", "2024-02-29", today()].map((day, i) => ({
        id: "r" + i,
        day,
        agent: "Codex",
        model: "fixture",
        session: "s" + i,
        input: 100,
        output: 10,
      })),
      sessions: ["2024-02-28", "2024-02-29", today()].map((day, i) => ({
        id: "s" + i,
        day,
        agent: "Codex",
        requests: ["RAW_INTENT_" + i],
        results: ["RAW_REPORTED_RESULT_" + i],
        project: "fixture",
      })),
    },
  },
]).days;
function rebuild() {
  for (const day of Object.values(days))
    atomic(path.join(root, "days", day.date + ".json"), day);
  const index = {
    dates: Object.values(days).map((d) => ({ date: d.date, total: d.total })),
    sources: {},
  };
  atomic(path.join(root, "index.json"), index);
  buildPeriods(index);
}
const calls = [];
const mock = async (task) => {
  calls.push(structuredClone(task));
  return "Summary " + task.key + " #" + calls.length;
};
(async () => {
  try {
    rebuild();
    await assert.rejects(
      () => review({}, { ...config, captureText: false }, mock),
      /requires/,
    );
    await assert.rejects(
      () =>
        review(
          {},
          { ...config, review: { ...config.review, enabled: false } },
          mock,
        ),
      /requires/,
    );
    assert.equal(calls.length, 0);
    console.log("PASS Review requires explicit text and model opt-in");
    const pending = tasks(config);
    assert(pending.every((t) => t.kind === "day"));
    assert(!pending.some((t) => t.date === today()));
    const result = await review({}, config, mock);
    assert.equal(result.failed.length, 0);
    assert.equal(result.saved.filter((k) => k.startsWith("day:")).length, 2);
    assert(calls.some((t) => t.kind === "month"));
    assert(calls.some((t) => t.kind === "year"));
    assert(!calls.some((t) => t.kind === "total"));
    for (const call of calls.filter((t) => t.kind !== "day")) {
      assert(!JSON.stringify(call.records).includes("RAW_"));
      assert(call.records.every((r) => r.summary.startsWith("Summary")));
    }
    console.log(
      "PASS ended periods generate in dependency order; parents use saved summaries only",
    );
    const before = calls.length;
    await review({}, config, mock);
    assert.equal(calls.length, before);
    assert.equal(tasks(config).length, 0);
    console.log("PASS unchanged cache reused with zero model calls");
    // Total uses ended days and never reads today's raw excerpts.
    let total = await review({ kind: "total", total: true }, config, mock);
    assert(total.saved.includes("total:all"));
    delete days[today()];
    rebuild();
    total = await review({ kind: "total", total: true }, config, mock);
    assert.equal(total.saved.length, 0);
    assert(!JSON.stringify(calls.at(-1).records).includes("RAW_"));
    console.log(
      "PASS Total is manual, uses valid child summaries and excludes the unfinished day",
    );
    const entries = read(path.join(root, "summaries.json"));
    const hashBefore = entries["2024-02-28"].hash;
    days["2024-02-28"].activities[0].results = ["Changed report"];
    days["2024-02-28"].sourceHash = "changed";
    rebuild();
    assert.equal(tasks(config).filter((t) => t.kind === "day").length, 0); // already generated today
    assert(!tasks(config, { inspect: true }).valid.has("day:2024-02-28"));
    entries["2024-02-28"].generatedAt = shift(today(), -1) + "T00:00:00Z";
    atomic(path.join(root, "summaries.json"), entries);
    await review({}, config, mock);
    assert.notEqual(
      read(path.join(root, "summaries.json"))["2024-02-28"].hash,
      hashBefore,
    );
    assert(!tasks(config, { inspect: true }).valid.has("total:all"));
    console.log(
      "PASS changed child invalidates parent; once-per-day regeneration limit is respected",
    );
    // Budget rejects before any external command, never truncates the day.
    atomic(path.join(root, "summaries.json"), {});
    atomic(path.join(root, "period-summaries.json"), {});
    atomic(path.join(root, "state.json"), {});
    days["2024-02-28"].activities = Array.from({ length: 20 }, (_, i) => ({
      ...days["2024-02-28"].activities[0],
      id: "large-" + i,
      requestsText: ["X".repeat(500)],
      results: ["Y".repeat(900)],
    }));
    rebuild();
    const bounded = {
      ...config,
      review: { ...config.review, maxInputChars: 2000 },
    };
    const priorCalls = calls.length;
    const boundedResult = await review({}, bounded, mock);
    assert.equal(calls.length, priorCalls);
    assert.equal(boundedResult.failed[0].error, "review-input-budget-exceeded");
    console.log(
      "PASS strict input budget rejects full input before calling the model",
    );
    atomic(path.join(root, "state.json"), {});
    const dailyBudget = {
      ...config,
      review: { ...config.review, maxCallsPerDay: 1 },
    };
    assert.equal(
      (await review({}, dailyBudget, mock)).paused,
      "daily-call-budget",
    );
    console.log("PASS daily call budget prevents automatic historical bursts");
    // Portable command provider contract, using Node as a synthetic runner.
    const runner = path.join(root, "mock-runner.cjs");
    fs.writeFileSync(
      runner,
      'let s="";process.stdin.on("data",b=>s+=b);process.stdin.on("end",()=>{const p=JSON.parse(s);process.stdout.write(JSON.stringify({text:"Synthetic "+p.key,usage:{input_tokens:12,output_tokens:3}}))});',
    );
    const commandConfig = {
      ...config,
      review: {
        ...config.review,
        provider: "command",
        command: process.execPath,
        args: [runner],
      },
    };
    const text = await invoke(
      { key: "day:2024-02-28", kind: "day", records: [{ intent: "Example" }] },
      commandConfig,
    );
    assert.equal(text, "Synthetic day:2024-02-28");
    const usage = read(path.join(root, "generation-usage.json"));
    assert.equal(usage.at(-1).usage.input_tokens, 12);
    assert.equal(fs.readdirSync(path.join(root, "jobs")).length, 0);
    console.log(
      "PASS portable command provider, usage ledger and temporary job cleanup (no real AI)",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
