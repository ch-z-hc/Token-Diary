const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto");
const { DIR, ZERO, today, read, atomic, getDay } = require("./core.cjs");
const KINDS = ["day", "week", "month", "year", "total"];
const shift = (date, n) =>
  new Date(Date.parse(date + "T12:00:00Z") + n * 86400000)
    .toISOString()
    .slice(0, 10);
function bounds(kind, date) {
  if (!KINDS.includes(kind)) throw new Error("invalid-period");
  if (kind === "total") return { id: "all", from: "0001-01-01", to: today() };
  if (kind === "day") return { id: date, from: date, to: date };
  if (kind === "week") {
    const weekday = new Date(date + "T12:00:00Z").getUTCDay(),
      from = shift(date, -((weekday + 6) % 7));
    return { id: from, from, to: shift(from, 6) };
  }
  if (kind === "month") {
    const from = date.slice(0, 7) + "-01",
      d = new Date(from + "T12:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1);
    return {
      id: date.slice(0, 7),
      from,
      to: shift(d.toISOString().slice(0, 10), -1),
    };
  }
  return {
    id: date.slice(0, 4),
    from: date.slice(0, 4) + "-01-01",
    to: date.slice(0, 4) + "-12-31",
  };
}
function sum(a, b) {
  for (const k of [
    "input",
    "cached",
    "cacheWrite",
    "output",
    "reasoning",
    "requests",
  ])
    a[k] += b[k] || 0;
  a.total = a.input + a.output;
}
function merge(kind, date, days) {
  const range = bounds(kind, date),
    key = kind + ":" + range.id,
    selected = days
      .filter((d) => d.date >= range.from && d.date <= range.to)
      .sort((a, b) => a.date.localeCompare(b.date));
  const result = {
    date: key,
    key,
    kind,
    ...range,
    ...ZERO(),
    agents: {},
    devices: {},
    models: {},
    activities: [],
    dayCount: selected.length,
    dates: selected.map((d) => ({ date: d.date, total: d.total })),
    source: [],
  };
  const activities = new Map();
  for (const d of selected) {
    sum(result, d);
    for (const group of ["agents", "devices", "models"])
      for (const [label, u] of Object.entries(d[group]))
        sum((result[group][label] ||= ZERO()), u);
    for (const a of d.activities) {
      const id = a.agent + ":" + a.id;
      let target = activities.get(id);
      if (!target) {
        target = {
          id: a.id,
          agent: a.agent,
          project: a.project,
          devices: [],
          requestsText: [],
          results: [],
          ...ZERO(),
        };
        activities.set(id, target);
      }
      sum(target, a);
      target.devices = [...new Set([...target.devices, ...a.devices])];
      target.requestsText = [
        ...new Set([...target.requestsText, ...a.requestsText]),
      ].slice(0, 4);
    }
    const sessions = d.activities
      .filter((a) => a.requestsText.length || a.results.length)
      .sort((a, b) =>
        (a.agent + ":" + a.id).localeCompare(b.agent + ":" + b.id),
      )
      .map((a) => ({
        agent: a.agent,
        project: a.project,
        request: (a.requestsText[0] || "").slice(0, 160),
        reportedResult: (a.results.at(-1) || "").slice(0, 350),
      }));
    if (sessions.length) result.source.push({ date: d.date, sessions });
  }
  result.activities = [...activities.values()].sort(
    (a, b) => b.total - a.total,
  );
  result.sessionCount = result.activities.length;
  result.coverageFrom = selected[0]?.date || null;
  result.coverageTo = selected.at(-1)?.date || null;
  result.sourceHash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify(["ai-period-review-1", kind, range.id, result.source]),
    )
    .digest("hex");
  return result;
}
function buildPeriods(index) {
  const days = index.dates.map((x) =>
      read(path.join(DIR, "days", x.date + ".json")),
    ),
    keys = new Map();
  for (const date of index.dates.map((x) => x.date))
    for (const kind of KINDS.slice(1)) {
      const r = bounds(kind, date);
      keys.set(kind + ":" + r.id, { kind, date });
    }
  const manifest = { updatedAt: index.updatedAt, periods: [] };
  for (const { kind, date } of keys.values()) {
    const p = merge(kind, date, days),
      file = path.join(DIR, "periods", p.key.replace(":", "_") + ".json");
    let saved;
    try {
      saved = fs.readFileSync(file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (saved !== JSON.stringify(p)) atomic(file, p);
    manifest.periods.push({
      key: p.key,
      kind: p.kind,
      id: p.id,
      from: p.from,
      to: p.to,
      coverageFrom: p.coverageFrom,
      coverageTo: p.coverageTo,
      total: p.total,
      sourceHash: p.sourceHash,
    });
  }
  manifest.periods.sort(
    (a, b) => b.from.localeCompare(a.from) || a.kind.localeCompare(b.kind),
  );
  atomic(path.join(DIR, "period-index.json"), manifest);
  return manifest;
}
function getPeriod(kind, date) {
  if (kind === "day") return getDay(date);
  const base = getDay(date),
    range = bounds(kind, date),
    key = kind + ":" + range.id;
  const d =
      read(path.join(DIR, "periods", key.replace(":", "_") + ".json"), null) ||
      merge(kind, date, []),
    summary = read(path.join(DIR, "period-summaries.json"))[key];
  return {
    ...base,
    day: d,
    summary: summary
      ? { ...summary, stale: summary.hash !== d.sourceHash }
      : null,
    worker: read(path.join(DIR, "period-state.json")),
    periodIndex: read(path.join(DIR, "period-index.json"), { periods: [] }),
  };
}
module.exports = {
  KINDS,
  shift,
  bounds,
  sum,
  merge,
  buildPeriods,
  getPeriod,
};
