const { spawnSync } = require("node:child_process");
const path = require("node:path");
for (const file of [
  "accounting.cjs",
  "chatgpt.cjs",
  "heatmap.cjs",
  "integration.cjs",
  "reviews.cjs",
]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
    stdio: "inherit",
    env: { ...process.env, AI_LOG_TIMEZONE: "Asia/Shanghai" },
  });
  if (result.status !== 0) process.exit(result.status || 1);
}
