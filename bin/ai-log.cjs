#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    "data-dir": { type: "string" },
    port: { type: "string" },
    period: { type: "string" },
    date: { type: "string" },
    format: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});
if (values.config) process.env.AI_LOG_CONFIG = path.resolve(values.config);
if (values["data-dir"])
  process.env.AI_LOG_DIR = path.resolve(values["data-dir"]);
const command = positionals[0] || "help";
const help = `AI Log — local AI usage and work journal

  ai-log init                  Write a stats-only configuration
  ai-log collect               Scan configured local/SSH/WSL/file sources
  ai-log watch                 Collect every 5 minutes; optional closed-period reviews
  ai-log serve [--port 4317]    Read-only dashboard on 127.0.0.1
  ai-log review                Generate due reviews (explicit opt-in required)
  ai-log review --period total Manually update Total from cached child summaries
  ai-log status                Print collector state
  ai-log export [--format json|markdown]
  ai-log demo --data-dir PATH  Create synthetic data in an empty directory

Options: --config PATH --data-dir PATH --period day|week|month|year|total --date YYYY-MM-DD
Statistics and browsing never invoke a model. Review generation uses your configured account.
`;
async function main() {
  if (values.version) {
    console.log(require("../package.json").version);
    return;
  }
  if (values.help || command === "help") {
    console.log(help);
    return;
  }
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("Node.js 24 or newer is required");
  const { load, defaults, configPath } = require("../src/config.cjs");
  if (command === "init") {
    const file = configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(
      fd,
      JSON.stringify(
        {
          ...defaults(),
          dataDir: process.env.AI_LOG_DIR || defaults().dataDir,
        },
        null,
        2,
      ) + "\n",
    );
    fs.closeSync(fd);
    console.log(file);
    return;
  }
  const config = load();
  const { DIR, read, today } = require("../src/core.cjs");
  if (
    values.date &&
    (!require("../src/server.cjs").validDate(values.date) ||
      values.date > today())
  )
    throw new Error("Invalid date");
  if (
    values.period &&
    !["day", "week", "month", "year", "total"].includes(values.period)
  )
    throw new Error("Invalid period");
  switch (command) {
    case "collect": {
      const result = await require("../src/collector.cjs").collect(config);
      console.log(
        JSON.stringify(
          { dates: result.dates.length, sources: result.sources },
          null,
          2,
        ),
      );
      if (Object.values(result.sources).some((s) => s.status === "error"))
        process.exitCode = 1;
      break;
    }
    case "serve":
      await require("../src/server.cjs").serve({
        port: values.port === undefined ? 4317 : Number(values.port),
      });
      break;
    case "review": {
      const result = await require("../src/reviews.cjs").review(
        {
          kind: values.period,
          date: values.date,
          total: values.period === "total",
        },
        config,
      );
      console.log(JSON.stringify(result, null, 2));
      if (result.failed.length) process.exitCode = 1;
      break;
    }
    case "watch": {
      let stopping = false,
        wake;
      const abort = () => {
        stopping = true;
        wake?.();
      };
      process.once("SIGTERM", abort);
      process.once("SIGINT", abort);
      await require("../src/lock.cjs").withLock(
        path.join(DIR, "watch.lock"),
        async () => {
          while (!stopping) {
            await require("../src/collector.cjs").collect(config);
            if (!stopping && config.review.enabled)
              await require("../src/reviews.cjs").review({}, config);
            if (!stopping)
              await new Promise((resolve) => {
                const timer = setTimeout(resolve, 300000);
                wake = () => {
                  clearTimeout(timer);
                  resolve();
                };
              });
          }
        },
      );
      break;
    }
    case "status":
      console.log(
        JSON.stringify(read(path.join(DIR, "sources.json")), null, 2),
      );
      break;
    case "export": {
      const index = read(path.join(DIR, "index.json"), { dates: [] });
      const summaries = read(path.join(DIR, "summaries.json"));
      if (values.format === "markdown") {
        console.log("# AI Log\n");
        for (const day of index.dates)
          console.log(
            "## " +
              day.date +
              "\n\n" +
              day.total +
              " tokens\n\n" +
              (summaries[day.date]?.text || "") +
              "\n",
          );
      } else if (!values.format || values.format === "json")
        console.log(
          JSON.stringify(
            { timezone: config.timezone, dates: index.dates, summaries },
            null,
            2,
          ),
        );
      else throw new Error("Unsupported export format");
      break;
    }
    case "demo":
      if (!values["data-dir"]) throw new Error("demo requires --data-dir PATH");
      console.log(
        "Created " +
          require("../src/demo.cjs").demo().dates.length +
          " synthetic days in " +
          DIR,
      );
      break;
    default:
      throw new Error("Unknown command: " + command);
  }
}
main().catch((e) => {
  console.error("AI Log: " + e.message);
  process.exitCode = 1;
});
