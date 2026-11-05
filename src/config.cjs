const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function configPath() {
  return path.resolve(
    process.env.AI_LOG_CONFIG ||
      path.join(os.homedir(), ".config", "ai-log", "config.json"),
  );
}
function defaults() {
  return {
    dataDir: path.join(os.homedir(), ".local", "share", "ai-log"),
    timezone: "Asia/Shanghai",
    captureText: false,
    sources: [{ id: "local", name: "This computer", type: "local" }],
    review: {
      enabled: false,
      provider: "codex",
      command: "codex",
      model: "gpt-6.1-sol",
      maxInputChars: 24000,
      maxCallsPerRun: 5,
      maxCallsPerDay: 20,
    },
  };
}
function load(file = configPath()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const config = {
    ...defaults(),
    ...raw,
    review: { ...defaults().review, ...raw.review },
  };
  config.dataDir = path.resolve(process.env.AI_LOG_DIR || config.dataDir);
  config.timezone = process.env.AI_LOG_TIMEZONE || config.timezone;
  new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone });
  if (
    typeof config.captureText !== "boolean" ||
    typeof config.review.enabled !== "boolean"
  )
    throw new Error("Invalid privacy settings");
  if (
    !Number.isInteger(config.review.maxInputChars) ||
    config.review.maxInputChars < 2000 ||
    config.review.maxInputChars > 100000
  )
    throw new Error("maxInputChars must be 2000..100000");
  if (
    !Number.isInteger(config.review.maxCallsPerRun) ||
    config.review.maxCallsPerRun < 1 ||
    config.review.maxCallsPerRun > 100
  )
    throw new Error("maxCallsPerRun must be 1..100");
  if (
    !Number.isInteger(config.review.maxCallsPerDay) ||
    config.review.maxCallsPerDay < 1 ||
    config.review.maxCallsPerDay > 1000
  )
    throw new Error("maxCallsPerDay must be 1..1000");
  if (!Array.isArray(config.sources) || !config.sources.length)
    throw new Error("Configure at least one source");
  const ids = new Set();
  for (const source of config.sources) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(source.id) || ids.has(source.id))
      throw new Error("Source IDs must be unique safe filenames");
    ids.add(source.id);
    if (!["local", "ssh", "wsl", "file", "chatgpt"].includes(source.type))
      throw new Error("Unsupported source type");
    if (
      (source.type === "ssh" || source.host) &&
      !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(source.host || "")
    )
      throw new Error("Invalid SSH host alias");
    if (
      source.type === "wsl" &&
      (!/^[a-zA-Z0-9_.-]+$/.test(source.distro || "") ||
        (source.user && !/^[a-zA-Z0-9_-]+$/.test(source.user)))
    )
      throw new Error("Invalid WSL distribution/user");
    if (
      ["file", "chatgpt"].includes(source.type) &&
      typeof source.path !== "string"
    )
      throw new Error("File source needs path");
  }
  return config;
}
module.exports = { load, defaults, configPath };
