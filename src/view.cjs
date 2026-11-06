const { today, getDay } = require("./core.cjs");
const { getPeriod, bounds, shift } = require("./periods.cjs");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const short = (n) =>
  n >= 1e9
    ? (n / 1e9).toFixed(2) + "B"
    : n >= 1e6
      ? (n / 1e6).toFixed(2) + "M"
      : n >= 1e3
        ? (n / 1e3).toFixed(1) + "K"
        : String(n || 0);
const status = (s) =>
  ({
    ok: "Synced",
    partial: "Partially available",
    error: "Collection failed",
    collected: "Collected",
    "not-found": "No records",
    unavailable: "No usage records",
  })[s] || s;
const LABELS = {
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
  year: "Yearly",
  total: "Total",
};
const url = (date, kind = "day") =>
  "/ai/?date=" + date + (kind === "day" ? "" : "&period=" + kind);
const agentName = (name) =>
  ({
    "AI Log（自动回顾）": "AI Log",
    "Diary Summary（自动生成）": "Diary Summary",
  })[name] || name;
function token(key, u, includeEstimates = true) {
  const field = {
    input: "estimatedInput",
    output: "estimatedOutput",
    total: "estimatedTotal",
  }[key];
  const estimate = field && u.estimatedMessages ? fmt(u[field]) : "";
  if (u.messages && !u.requests) return estimate || "—";
  return fmt(u[key]) + (includeEstimates && estimate ? " / " + estimate : "");
}
function stats(d, daily) {
  const columns = [
    ["total", "Total"],
    ["input", "Input"],
    ["output", "Output"],
  ];
  const primary = columns
    .map(([key, label]) => {
      const value = token(key, d, false);
      return `<td data-label="${label}"><strong${value.length > 17 ? ' class="ai-stat-long"' : ""}>${value}</strong></td>`;
    })
    .join("");
  const estimates =
    d.requests && d.estimatedMessages
      ? `<tr class="ai-estimated"><th scope="row">ChatGPT</th>${[d.estimatedTotal, d.estimatedInput, d.estimatedOutput].map((value, i) => `<td data-label="${columns[i][1]}"><strong${fmt(value).length > 17 ? ' class="ai-stat-long"' : ''}>${fmt(value)}</strong></td>`).join("")}</tr>`
      : "";
  const subsets =
    d.requests || !d.messages
      ? `<tr class="ai-subsets"><th scope="row"><span class="ai-visually-hidden">Details</span></th><td></td><td data-label="Cached input"><span class="ai-sub-label">Cached </span>${token("cached", d, false)}</td><td data-label="Reasoning output"><span class="ai-sub-label">Reasoning </span>${token("reasoning", d, false)}</td></tr>`
      : "";
  const counts = [["Sessions", d.sessionCount]];
  if (d.requests || !d.messages) counts.push(["Calls", d.requests]);
  if (d.messages)
    counts.push(
      ["User messages", d.userMessages],
      ["Assistant replies", d.assistantMessages],
    );
  if (!daily) counts.push(["Days", d.dayCount]);
  return `<section class="ai-stats" aria-label="Token usage"><table class="ai-metrics"><thead><tr><th scope="col"><span class="ai-visually-hidden">Source</span></th>${columns.map(([, label]) => `<th scope="col">${label}</th>`).join("")}</tr></thead><tbody><tr class="ai-measured"><th scope="row">${d.messages && !d.requests ? "ChatGPT" : "Token"}</th>${primary}</tr>${subsets}${estimates}</tbody></table><ul class="ai-usage-meta" style="--meta-count:${counts.length}" aria-label="Activity counts">${counts.map(([label, value]) => `<li><span>${label}</span><b>${fmt(value)}</b></li>`).join("")}</ul></section>`;
}
function rows(items) {
  return Object.entries(items)
    .sort((a, b) => b[1].total - a[1].total)
    .map(
      ([name, u]) =>
        `<tr><th scope="row">${esc(agentName(name))}</th><td>${token("input", u)}</td><td>${token("cached", u)}</td><td>${token("output", u)}</td><td>${token("total", u)}</td></tr>`,
    )
    .join("");
}
function table(title, items) {
  return `<details class="ai-breakdown"><summary>${title}</summary><div class="ai-table-wrap"><table><thead><tr><th scope="col">${title}</th><th scope="col">Input</th><th scope="col">Cached input</th><th scope="col">Output</th><th scope="col">Total</th></tr></thead><tbody>${rows(items)}</tbody></table></div></details>`;
}
function weekLabel(from) {
  const year = shift(from, 3).slice(0, 4),
    first = bounds("week", year + "-01-04").from;
  const number =
    Math.round(
      (Date.parse(from + "T12:00:00Z") - Date.parse(first + "T12:00:00Z")) /
        (7 * 86400000),
    ) + 1;
  return year + "-W" + String(number).padStart(2, "0");
}
function periodPicker(kind, date, records) {
  const selected = bounds(kind, date),
    choices = new Map(records.map((p) => [p.from, p]));
  choices.set(selected.from, selected);
  return `<select id="ai-date" class="ai-period-select" name="date" aria-label="Choose a ${kind === "week" ? "Week" : kind === "month" ? "Month" : "Year"}">${[
    ...choices.values(),
  ]
    .sort((a, b) => b.from.localeCompare(a.from))
    .map(
      (p) =>
        `<option value="${p.from}"${p.from === selected.from ? " selected" : ""}>${kind === "week" ? weekLabel(p.from) : p.id}</option>`,
    )
    .join("")}</select>`;
}
function adjacent(kind, from, delta) {
  if (kind === "week") return shift(from, delta * 7);
  const d = new Date(from + "T12:00:00Z");
  if (kind === "month") d.setUTCMonth(d.getUTCMonth() + delta);
  else d.setUTCFullYear(d.getUTCFullYear() + delta);
  return d.toISOString().slice(0, 10);
}
function render(date, picker, script, kind = "day") {
  const { index, day: d, summary, worker, periodIndex } = getPeriod(kind, date),
    daily = kind === "day";
  const config = require("./config.cjs").load();
  const reviewsEnabled = config.captureText && config.review.enabled;
  if (summary && summary.model !== "synthetic" && reviewsEnabled)
    summary.stale = !require("./reviews.cjs")
      .tasks(config, { inspect: true })
      .valid.has(daily ? "day:" + date : d.key);
  const records = daily
    ? index.dates.map((x) => ({ from: x.date, id: x.date }))
    : kind === "total"
      ? []
      : periodIndex.periods
          .filter((p) => p.kind === kind)
          .sort((a, b) => b.from.localeCompare(a.from));
  const selected = daily ? date : d.from;
  let previous = records.find((x) => x.from < selected),
    next = [...records].reverse().find((x) => x.from > selected);
  if (!daily && kind !== "total") {
    const before = adjacent(kind, d.from, -1),
      after = adjacent(kind, d.from, 1),
      earliest = records.at(-1)?.from || d.from;
    previous = before >= earliest ? { from: before } : null;
    next = after <= today() ? { from: after } : null;
    picker = periodPicker(kind, date, records);
  }
  const hasText = daily
    ? d.activities.some((a) => a.requestsText.length || a.results.length)
    : d.source.length > 0;
  const needsReview = !summary || summary.stale,
    queued =
      kind === "total" &&
      worker.status === "summarizing" &&
      worker.dates?.includes("total:all");
  const current = daily ? date >= today() : kind !== "total" && d.to >= today();
  let state = needsReview
    ? hasText
      ? kind === "total"
        ? queued
          ? "Review queued"
          : "Manual update"
        : current
          ? {
              day: "Updates after today ends",
              week: "Updates after this week ends",
              month: "Updates after this month ends",
              year: "Updates after this year ends",
            }[kind]
          : "Review pending"
      : d.total
        ? "No saved conversation text"
        : "No usage records"
    : "";
  if (needsReview && worker.dates?.includes(daily ? date : d.key)) {
    if (worker.status === "summarizing") state = "Generating review…";
    else if (worker.status === "error" && (!current || queued))
      state =
        kind === "total"
          ? "Review failed. Please retry."
          : "Review failed. Retrying later.";
  }
  if (!reviewsEnabled)
    state = summary ? "Review updates disabled" : "Reviews disabled";
  else if (kind === "total" && needsReview)
    state = "Run ai-log review --period total to update";
  const summaryHTML = summary
    ? esc(summary.text)
        .split(/\n+/)
        .filter(Boolean)
        .map((p) => `<p>${p}</p>`)
        .join("")
    : "";
  const visibleActivities = daily ? d.activities : d.activities.slice(0, 30);
  const topics = visibleActivities
    .map((a) => {
      const text =
        a.requestsText.find(
          (x) =>
            !x.startsWith("# Files mentioned") && !/^[-\w]+ 20\d\d-/.test(x),
        ) || a.requestsText[0];
      return `<li><div class="ai-topic-head"><span>${esc(agentName(a.agent))}${a.project ? " · " + esc(a.project) : ""}</span><span>${a.messages ? token("total", a) : short(a.total)}</span></div>${text ? `<p>${esc(text.slice(0, 180))}${text.length > 180 ? "…" : ""}</p>` : '<p class="hint">No saved conversation text</p>'}<small>${esc(a.devices.join(" / "))} · ${a.messages ? fmt(a.messages) + (a.messages === 1 ? " chat message" : " chat messages") : fmt(a.requests) + (a.requests === 1 ? " call" : " calls")}</small></li>`;
    })
    .join("");
  const range = daily
    ? ""
    : kind === "total"
      ? d.coverageFrom
        ? d.coverageFrom + " — " + d.coverageTo
        : "No records"
      : d.from + " — " + (d.to > today() ? today() : d.to);
  const unit = { week: "week", month: "month", year: "year" }[kind];
  const nav =
    kind === "total"
      ? ""
      : `<nav class="ai-day-nav" aria-label="Date navigation">${previous ? `<a href="${urlAttr(url(previous.from, kind))}">← ${daily ? previous.id : "Previous " + unit}</a>` : "<span></span>"}<a href="${urlAttr(url(today(), kind))}">${daily ? "Today" : kind === "year" ? "This year" : "This " + unit}</a>${next ? `<a href="${urlAttr(url(next.from, kind))}">${daily ? next.id : "Next " + unit} →</a>` : "<span></span>"}</nav>`;
  return `<style>${CSS}</style><div class="ai-log" lang="en">${periodNav(date, kind)}${kind === "total" ? "" : `<form class="summary-picker ai-picker" method="get" action="/ai/"><label class="sr-only" for="ai-date">Choose a ${daily ? "Day" : { week: "Week", month: "Month", year: "Year" }[kind]}</label>${daily ? "" : `<input type="hidden" name="period" value="${kind}">`}<div class="summary-controls">${picker}<button type="submit">View</button></div></form>`}${nav}${range ? `<p class="ai-range">${range}</p>` : ""}
 ${stats(d, daily)}
 <section class="ai-section"><h3>${LABELS[kind]} Review</h3>${state ? `<p class="ai-state" role="status">${state}</p>` : ""}<div class="ai-review">${summaryHTML}</div></section>
 ${d.total || d.messages ? `<section class="ai-section">${table("Agent", d.agents)}${table("Device", d.devices)}${table("Model", d.models)}</section><section class="ai-section"><details><summary>Session topics · ${visibleActivities.length < d.sessionCount ? visibleActivities.length + " / " : ""}${d.sessionCount}</summary><ul class="ai-topics">${topics}</ul></details></section>` : ""}

</div>${daily ? script : ""}`;
}
function periodNav(date, active) {
  return `<nav class="ai-period-tabs" aria-label="Review period">${Object.entries(
    LABELS,
  )
    .map(
      ([kind, label]) =>
        `<a href="${esc(url(date, kind))}"${active === kind ? ' aria-current="page"' : ""}>${label}</a>`,
    )
    .join("")}</nav>`;
}
function renderStatus() {
  const { index, heartbeat } = getDay(today()),
    sources = Object.values(index.sources);
  const stale = !heartbeat.at || Date.now() - Date.parse(heartbeat.at) > 420000,
    bad = sources.some((s) => s.status === "error" || s.status === "partial");
  const time = (t) =>
    t
      ? new Date(t).toLocaleString("en-GB", {
          timeZone: require("./config.cjs").load().timezone,
          hour12: false,
        })
      : "Not synced yet";
  return `<style>${CSS}</style><div class="ai-log" lang="en"><section class="ai-section ai-sync"><h3>Collection status</h3><p class="ai-state" role="status">${stale ? "Collection paused" : bad ? "Some sources are out of date" : "Synced"}</p>${sources
    .map(
      (s) =>
        `<div class="ai-source"><p><strong>${esc(s.name)}</strong><span>${status(s.status)}</span></p><small>Last synced: ${time(s.lastSuccess)}</small>${s.imported ? `<p class="hint">Export snapshot · Through ${esc(s.coverageTo || "Unknown")}</p>` : ""}${s.errors?.length ? `<p class="hint">${s.errors.reduce((n, e) => n + (e.count || 1), 0)} unreadable records skipped</p>` : ""}<ul>${(
          s.inventory || []
        )
          .filter((a) => a.status !== "not-found")
          .map(
            (a) =>
              `<li>${esc(agentName(a.agent))} · ${status(a.status)}${a.events !== undefined ? " · " + fmt(a.events) + " records" : ""}</li>`,
          )
          .join("")}</ul></div>`,
    )
    .join(
      "",
    )}<p class="hint">${esc(require("./config.cjs").load().timezone)} · 00:00 day boundary</p><small class="hint">Updated ${time(index.updatedAt)}</small></section></div>`;
}
const urlAttr = esc;
const CSS = `
.ai-stats{border-block:1px solid var(--rule)}.ai-metrics{width:100%;table-layout:fixed;border-collapse:separate;border-spacing:0;padding:24px 0;font-family:var(--font-ui);font-variant-numeric:tabular-nums}.ai-metrics th,.ai-metrics td{text-align:right;vertical-align:baseline;padding:7px 0 7px 24px;white-space:nowrap;border:0;font-weight:400}.ai-metrics th:first-child{width:90px;text-align:left;padding-left:0;font-size:13px;color:var(--muted)}.ai-metrics thead th{font-size:13px;color:var(--muted);padding-top:0;padding-bottom:12px}.ai-metrics strong{font-weight:500;font-size:clamp(20px,2.2vw,28px);line-height:1.5;letter-spacing:-.5px;white-space:nowrap}.ai-metrics strong.ai-stat-long{font-size:18px}.ai-metrics .ai-subsets td{font-size:12px;color:var(--muted);padding-top:2px}.ai-sub-label{margin-right:8px}.ai-usage-meta{display:grid;grid-template-columns:repeat(var(--meta-count),minmax(0,1fr));gap:20px;list-style:none;margin:0;padding:20px 0;border-top:1px solid var(--rule);font-family:var(--font-ui)}.ai-usage-meta li{display:grid;gap:6px;white-space:nowrap;text-align:right}.ai-usage-meta span{font-size:12px;color:var(--muted)}.ai-usage-meta b{font-size:17px;line-height:1.5;font-weight:500;font-variant-numeric:tabular-nums}.ai-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:900px){.ai-metrics{display:block;padding:8px 0 20px}.ai-metrics thead{display:none}.ai-metrics tbody{display:block}.ai-metrics tr{display:block;padding-top:16px}.ai-metrics tbody th:first-child{display:block;width:auto;padding:0 0 10px;font-size:13px}.ai-metrics td{display:flex;justify-content:space-between;gap:12px;padding:6px 0;align-items:baseline}.ai-metrics td:before{content:attr(data-label);font-size:13px;color:var(--muted);font-weight:400;letter-spacing:0}.ai-metrics strong{font-size:25px}.ai-metrics .ai-subsets{padding-top:8px}.ai-subsets th,.ai-subsets td:empty,.ai-sub-label{display:none!important}.ai-estimated{border-top:1px dashed var(--rule);margin-top:14px}.ai-usage-meta{grid-template-columns:repeat(3,minmax(0,1fr));gap:18px 12px;padding:18px 0}.ai-usage-meta li{text-align:left}}@media(max-width:600px){.ai-usage-meta{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:380px){.ai-metrics strong{font-size:21px}.ai-metrics strong.ai-stat-long{font-size:15px}}
.ai-period-tabs{align-items:center;display:flex;justify-content:center;flex-wrap:wrap;gap:4px;margin:0 0 16px;font-family:var(--font-ui);font-size:14px}.ai-period-tabs a{padding:10px;min-height:44px;border-radius:8px}.ai-period-tabs a[aria-current]{background:var(--soft);font-weight:700}.ai-range{text-align:center;font-size:14px;color:var(--muted);margin:20px 0}.ai-day-nav>:first-child{justify-self:start}.ai-day-nav>:nth-child(2){justify-self:center}.ai-day-nav>:last-child{justify-self:end}.ai-picker{width:100%}.ai-picker input{text-align:center}.ai-period-select{flex:1;min-width:0;width:100%;border:0;border-bottom:1px dashed var(--border);border-radius:0;background:transparent;padding:10px 8px;text-align:center;font:inherit;color:inherit;color-scheme:light}.ai-review-update button{font-size:14px}.ai-log{max-width:900px;margin:auto;text-align:left}.ai-picker{margin:0 auto;max-width:560px}.ai-picker>label{text-align:center}.ai-day-nav{display:grid;grid-template-columns:1fr auto 1fr;max-width:560px;width:100%;margin-inline:auto;gap:12px;font-family:var(--font-ui);font-size:13px;margin:4px auto 20px}.ai-section{margin-top:32px}.ai-section h3{text-align:left;margin:0 0 16px;font-size:19px}.ai-review p{line-height:1.95;margin:0 0 12px}.ai-state{color:var(--muted);font-size:14px}.ai-log summary{cursor:pointer;min-height:44px;line-height:44px}.ai-log details summary::marker{color:var(--muted)}.ai-table-wrap{overflow-x:auto;max-width:100%;margin:8px 0 16px}.ai-table-wrap table{width:100%;font-family:var(--font-ui);font-size:12px;border-collapse:collapse;white-space:nowrap}.ai-table-wrap th,.ai-table-wrap td{padding:10px 12px;text-align:right;border-bottom:1px solid var(--rule);font-weight:400;font-variant-numeric:tabular-nums}.ai-table-wrap th:first-child{text-align:left}.ai-topics{padding:0;list-style:none}.ai-topics li{padding:16px 0;border-bottom:1px dashed var(--rule)}.ai-topic-head{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted);font-family:var(--font-ui);overflow-wrap:anywhere}.ai-topics p{margin:8px 0;font-size:15px;overflow-wrap:anywhere}.ai-topics small,.ai-sync small{font-size:12px;color:var(--muted)}.ai-source{padding:8px 0 12px;border-bottom:1px dashed var(--rule)}.ai-source p{display:flex;justify-content:space-between;gap:12px;margin:8px 0;font-size:14px}.ai-source p strong{font-weight:400}.ai-source ul{font-size:12px;color:var(--muted);margin:8px 0;padding-left:20px}.ai-sync>.hint{display:block;margin-top:16px}.ai-page{max-width:1000px}@media(max-width:600px){.ai-period-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;font-size:12px}.ai-period-tabs a{text-align:center;padding:10px 2px}.ai-day-nav{font-size:12px;gap:6px}.ai-picker .summary-controls{gap:8px}}
`;
module.exports = {
  render,
  renderStatus,
  CSS,
  weekLabel,
  periodPicker,
  adjacent,
};
