const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  zlib = require("zlib");
const DIR = process.env.AI_LOG_DIR || require("./config.cjs").load().dataDir;
const ZERO = () => ({
  input: 0,
  cached: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
  total: 0,
  requests: 0,
  messages: 0,
  userMessages: 0,
  assistantMessages: 0,
  unknownUsage: 0,
  estimatedInput: 0,
  estimatedOutput: 0,
  estimatedTotal: 0,
  estimatedMessages: 0,
});
function add(a, b) {
  if (b.kind === "chat-message") {
    a.messages++;
    if (b.role === "user") a.userMessages++;
    if (b.role === "assistant") a.assistantMessages++;
    if (
      b.estimateEncoding === "o200k_base" &&
      Number.isSafeInteger(b.estimatedInput) &&
      b.estimatedInput >= 0 &&
      Number.isSafeInteger(b.estimatedOutput) &&
      b.estimatedOutput >= 0
    ) {
      a.estimatedInput += b.estimatedInput;
      a.estimatedOutput += b.estimatedOutput;
      a.estimatedTotal = a.estimatedInput + a.estimatedOutput;
      a.estimatedMessages++;
    }
    if (!b.tokensKnown) {
      if (b.role === "assistant") a.unknownUsage++;
      return a;
    }
  }
  for (const k of ["input", "cached", "cacheWrite", "output", "reasoning"])
    a[k] += b[k] || 0;
  a.total = a.input + a.output;
  a.requests++;
  return a;
}
const timezone =
  process.env.AI_LOG_TIMEZONE || require("./config.cjs").load().timezone;
const dateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const today = () => dateFormat.format(new Date());
const read = (file, fallback = {}) => {
  try {
    return JSON.parse(fs.readFileSync(file));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
};
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + ".tmp-" + process.pid, JSON.stringify(value), {
    mode: 0o600,
  });
  fs.renameSync(file + ".tmp-" + process.pid, file);
}
function aggregate(snapshots) {
  const days = {},
    seen = new Set(),
    sessions = new Map();
  let duplicates = 0;
  for (const { id, name, data } of snapshots) {
    for (const s of data.sessions) {
      const key = s.agent + ":" + s.id + ":" + s.day;
      const old = sessions.get(key);
      if (!old) sessions.set(key, { ...s, devices: [name] });
      else {
        old.devices = [...new Set([...old.devices, name])];
        old.requests = [...new Set([...old.requests, ...s.requests])].slice(
          0,
          5,
        );
        old.results = [...new Set([...old.results, ...s.results])].slice(-3);
      }
    }
    for (const e of data.events) {
      if ([e.id, ...(e.aliases || [])].some((id) => seen.has(id))) {
        duplicates++;
        continue;
      }
      for (const id of [e.id, ...(e.aliases || [])]) seen.add(id);
      const d = (days[e.day] ||= {
        date: e.day,
        ...ZERO(),
        agents: {},
        devices: {},
        models: {},
        activities: {},
      });
      add(d, e);
      for (const [key, label] of [
        ["agents", e.agent],
        ["devices", name],
        ["models", e.model],
      ])
        add((d[key][label] ||= ZERO()), e);
      const key = e.agent + ":" + e.session;
      const a = (d.activities[key] ||= {
        id: e.session,
        agent: e.agent,
        devices: [],
        ...ZERO(),
      });
      add(a, e);
      if (!a.devices.includes(name)) a.devices.push(name);
    }
  }
  for (const d of Object.values(days)) {
    d.activities = Object.values(d.activities)
      .sort((a, b) => b.total - a.total)
      .map((a) => {
        const s = sessions.get(a.agent + ":" + a.id + ":" + d.date);
        return {
          ...a,
          project: s?.project || "",
          requestsText: s?.requests || [],
          results: s?.results || [],
        };
      });
    d.sessionCount = d.activities.length;
    d.sourceHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          "ai-journal-1",
          d.activities.map((a) => [a.id, a.agent, a.requestsText, a.results]),
        ]),
      )
      .digest("hex");
  }
  return { days, duplicates };
}
function build() {
  const sources = read(path.join(DIR, "sources.json")),
    snapshots = [];
  for (const [id, s] of Object.entries(sources)) {
    try {
      snapshots.push({
        id,
        name: s.name,
        data: JSON.parse(
          zlib.gunzipSync(fs.readFileSync(path.join(DIR, id + ".json.gz"))),
        ),
      });
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const generated = read(path.join(DIR, "generation-usage.json"), []);
  if (generated.length)
    snapshots.push({
      id: "ai-journal",
      name: "Review automation",
      data: {
        sessions: [],
        events: generated.map((e) => ({
          id: "ai-journal:" + e.id,
          ts: e.timestamp,
          day: dateFormat.format(new Date(e.timestamp)),
          agent: "AI Log（自动回顾）",
          session: "ai-journal",
          model: e.model,
          input: e.usage.input_tokens || 0,
          cached: e.usage.cached_input_tokens || 0,
          output: e.usage.output_tokens || 0,
          reasoning: 0,
        })),
      },
    });
  const { days, duplicates } = aggregate(snapshots);
  for (const d of Object.values(days))
    atomic(path.join(DIR, "days", d.date + ".json"), d);
  const dates = Object.values(days)
    .map(
      ({
        date,
        total,
        input,
        cached,
        output,
        sessionCount,
        requests,
        messages,
        userMessages,
        assistantMessages,
        unknownUsage,
        estimatedInput,
        estimatedOutput,
        estimatedTotal,
        estimatedMessages,
      }) => ({
        date,
        total,
        input,
        cached,
        output,
        sessionCount,
        requests,
        messages,
        userMessages,
        assistantMessages,
        unknownUsage,
        estimatedInput,
        estimatedOutput,
        estimatedTotal,
        estimatedMessages,
      }),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
  const result = {
    updatedAt: new Date().toISOString(),
    timezone,
    dayStartsAt: "00:00",
    dates,
    sources,
    duplicates,
  };
  atomic(path.join(DIR, "index.json"), result);
  require("./periods.cjs").buildPeriods(result);
  return result;
}
function getDay(date) {
  const index = read(path.join(DIR, "index.json"), { dates: [], sources: {} });
  const known = index.dates.some((day) => day.date === date);
  const empty = {
    date,
    ...ZERO(),
    agents: {},
    devices: {},
    models: {},
    activities: [],
    sessionCount: 0,
  };
  const d = known ? read(path.join(DIR, "days", date + ".json"), empty) : empty;
  const summary = known ? read(path.join(DIR, "summaries.json"))[date] : null;
  return {
    index,
    day: d,
    summary: summary
      ? { ...summary, stale: summary.sourceHash !== d.sourceHash }
      : null,
    worker: read(path.join(DIR, "state.json")),
    heartbeat: read(path.join(DIR, "heartbeat.json")),
  };
}
module.exports = { DIR, ZERO, today, read, atomic, aggregate, build, getDay };
