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
    ok: "已同步",
    partial: "部分可用",
    error: "采集失败",
    collected: "已采集",
    "not-found": "无记录",
    unavailable: "无可用用量记录",
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
const agentName = name => ({"AI Log（自动回顾）": "AI Log", "Diary Summary（自动生成）": "Diary Summary"})[name] || name;
function token(key, u, includeEstimates = true) {
  const field = {
    input: "estimatedInput",
    output: "estimatedOutput",
    total: "estimatedTotal",
  }[key];
  const estimate = field && u.estimatedMessages ? "≈ " + fmt(u[field]) : "";
  if (u.messages && !u.requests) return estimate || "—";
  return fmt(u[key]) + (includeEstimates && estimate ? " / " + estimate : "");
}
function inlineEstimate(key, d) {
  const field = {
    input: "estimatedInput",
    output: "estimatedOutput",
    total: "estimatedTotal",
  }[key];
  return d.requests && d.estimatedMessages
    ? `<span>ChatGPT ≈ ${fmt(d[field])}</span>`
    : "";
}
function chatNotice(d) {
  return d.messages
    ? `<p class="ai-state ai-chat-notice">ChatGPT：${fmt(d.userMessages)} 条用户消息 · ${fmt(d.assistantMessages)} 条助手回复</p>`
    : "";
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
  return `<details class="ai-breakdown"><summary>${title}</summary><div class="ai-table-wrap"><table><thead><tr><th scope="col">${title}</th><th scope="col">输入</th><th scope="col">缓存输入</th><th scope="col">输出</th><th scope="col">合计</th></tr></thead><tbody>${rows(items)}</tbody></table></div></details>`;
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
          ? "回顾排队中"
          : "手动更新回顾"
        : current
          ? {
              day: "当天结束后更新",
              week: "本周结束后更新",
              month: "本月结束后更新",
              year: "本年结束后更新",
            }[kind]
          : "回顾待更新"
      : d.total
        ? "未保存可用会话文本"
        : "暂无用量记录"
    : "";
  if (needsReview && worker.dates?.includes(daily ? date : d.key)) {
    if (worker.status === "summarizing") state = "回顾生成中";
    else if (worker.status === "error" && (!current || queued))
      state =
        kind === "total"
          ? "回顾生成失败，请重试"
          : "回顾生成失败，稍后自动重试";
  }
  if (!reviewsEnabled)
    state = summary ? "Review 已停止生成，保留已有回顾" : "Review 已关闭";
  else if (kind === "total" && needsReview)
    state = "运行 ai-log review --period total 更新回顾";
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
      return `<li><div class="ai-topic-head"><span>${esc(agentName(a.agent))}${a.project ? " · " + esc(a.project) : ""}</span><span>${a.messages ? token("total", a) : short(a.total)}</span></div>${text ? `<p>${esc(text.slice(0, 180))}${text.length > 180 ? "…" : ""}</p>` : '<p class="hint">会话未保存可用文本</p>'}<small>${esc(a.devices.join(" / "))} · ${a.messages ? fmt(a.messages) + " 条聊天消息" : fmt(a.requests) + " 次调用"}</small></li>`;
    })
    .join("");
  const range = daily
    ? ""
    : kind === "total"
      ? d.coverageFrom
        ? d.coverageFrom + " — " + d.coverageTo
        : "暂无记录"
      : d.from + " — " + (d.to > today() ? today() : d.to);
  const unit = { week: "周", month: "月", year: "年" }[kind];
  const nav =
    kind === "total"
      ? ""
      : `<nav class="ai-day-nav" aria-label="日期导航">${previous ? `<a href="${urlAttr(url(previous.from, kind))}">← ${daily ? previous.id : "上一" + unit}</a>` : "<span></span>"}<a href="${urlAttr(url(today(), kind))}">${daily ? "Today" : kind === "year" ? "今年" : "本" + unit}</a>${next ? `<a href="${urlAttr(url(next.from, kind))}">${daily ? next.id : "下一" + unit} →</a>` : "<span></span>"}</nav>`;
  return `<style>${CSS}</style><div class="ai-log">${periodNav(date, kind)}${kind === "total" ? "" : `<form class="summary-picker ai-picker" method="get" action="/ai/"><label class="sr-only" for="ai-date">Choose a ${daily ? "Day" : { week: "Week", month: "Month", year: "Year" }[kind]}</label>${daily ? "" : `<input type="hidden" name="period" value="${kind}">`}<div class="summary-controls">${picker}<button type="submit">View</button></div></form>`}${nav}${range ? `<p class="ai-range">${range}</p>` : ""}
 <section class="ai-stats" aria-label="Token 用量"><div><small>${d.messages ? (d.requests ? "实测合计" : "估算合计") : "Total tokens"}</small><strong>${token("total", d, false)}</strong>${inlineEstimate("total", d)}<span>${d.sessionCount} 个会话 · ${d.messages ? fmt(d.messages) + " 条聊天消息" + (d.requests ? " · " + fmt(d.requests) + " 次已记录调用" : "") : fmt(d.requests) + " 次调用"}${daily ? "" : " · " + d.dayCount + " 个有记录的日期"}</span></div><div><small>${d.messages ? (d.requests ? "实测输入" : "估算输入") : "Input"}</small><strong>${token("input", d, false)}</strong>${inlineEstimate("input", d)}<span>含缓存输入 ${token("cached", d, false)}</span></div><div><small>${d.messages ? (d.requests ? "实测输出" : "估算输出") : "Output"}</small><strong>${token("output", d, false)}</strong>${inlineEstimate("output", d)}<span>含推理输出 ${token("reasoning", d, false)}</span></div></section>
 ${chatNotice(d)}<section class="ai-section"><h3>${LABELS[kind]} Review</h3>${state ? `<p class="ai-state" role="status">${state}</p>` : ""}<div class="ai-review">${summaryHTML}</div></section>
 ${d.total || d.messages ? `<section class="ai-section">${table("Agent", d.agents)}${table("Device", d.devices)}${table("Model", d.models)}</section><section class="ai-section"><details><summary>${daily ? "会话主题" : "主要会话主题"} · ${visibleActivities.length < d.sessionCount ? visibleActivities.length + " / " : ""}${d.sessionCount}</summary><ul class="ai-topics">${topics}</ul></details></section>` : ""}

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
      ? new Date(t).toLocaleString("zh-CN", {
          timeZone: require("./config.cjs").load().timezone,
          hour12: false,
        })
      : "尚未同步";
  return `<style>${CSS}</style><div class="ai-log"><section class="ai-section ai-sync"><h3>采集状态</h3><p class="ai-state" role="status">${stale ? "后台采集暂停" : bad ? "部分数据未更新" : "已同步"}</p>${sources
    .map(
      (s) =>
        `<div class="ai-source"><p><strong>${esc(s.name)}</strong><span>${status(s.status)}</span></p><small>上次成功：${time(s.lastSuccess)}</small>${s.imported ? `<p class="hint">导出快照 · 记录截至 ${esc(s.coverageTo || "未知")}</p>` : ""}${s.errors?.length ? `<p class="hint">${s.errors.reduce((n, e) => n + (e.count || 1), 0)} 条记录无法读取，已跳过</p>` : ""}<ul>${(
          s.inventory || []
        )
          .filter((a) => a.status !== "not-found")
          .map(
            (a) =>
              `<li>${esc(agentName(a.agent))} · ${status(a.status)}${a.events !== undefined ? " · " + fmt(a.events) + " 条" : ""}</li>`,
          )
          .join("")}</ul></div>`,
    )
    .join(
      "",
    )}<p class="hint">${esc(require("./config.cjs").load().timezone)} · 00:00 换日</p><small class="hint">更新于 ${time(index.updatedAt)}</small></section></div>`;
}
const urlAttr = esc;
const CSS = `
.ai-period-tabs{align-items:center;display:flex;justify-content:center;flex-wrap:wrap;gap:4px;margin:0 0 16px;font-family:var(--font-ui);font-size:14px}.ai-period-tabs a{padding:10px;min-height:44px;border-radius:8px}.ai-period-tabs a[aria-current]{background:var(--soft);font-weight:700}.ai-range{text-align:center;font-size:14px;color:var(--muted);margin:20px 0}.ai-day-nav>:first-child{justify-self:start}.ai-day-nav>:nth-child(2){justify-self:center}.ai-day-nav>:last-child{justify-self:end}.ai-picker{width:100%}.ai-picker input{text-align:center}.ai-period-select{flex:1;min-width:0;width:100%;border:0;border-bottom:1px dashed var(--border);border-radius:0;background:transparent;padding:10px 8px;text-align:center;font:inherit;color:inherit;color-scheme:light}.ai-review-update button{font-size:14px}.ai-log{max-width:900px;margin:auto;text-align:left}.ai-picker{margin:0 auto;max-width:560px}.ai-picker>label{text-align:center}.ai-day-nav{display:grid;grid-template-columns:1fr auto 1fr;max-width:560px;width:100%;margin-inline:auto;gap:12px;font-family:var(--font-ui);font-size:13px;margin:4px auto 20px}.ai-stats{display:grid;grid-template-columns:1.3fr 1fr 1fr;border-block:1px dashed var(--rule);padding:24px 0;gap:16px}.ai-stats>div{min-width:0}.ai-stats small{display:block;font-family:var(--font-ui);font-size:13px;color:var(--muted)}.ai-stats strong{display:block;font-family:var(--font-ui);font-weight:500;font-size:clamp(20px,2.3vw,29px);letter-spacing:-.5px;line-height:1.6;font-variant-numeric:tabular-nums}.ai-stats span{display:block;font-size:12px;color:var(--muted)}.ai-section{margin-top:32px}.ai-section h3{text-align:left;margin:0 0 16px;font-size:19px}.ai-review p{line-height:1.95;margin:0 0 12px}.ai-state{color:var(--muted);font-size:14px}.ai-log summary{cursor:pointer;min-height:44px;line-height:44px}.ai-log details summary::marker{color:var(--muted)}.ai-table-wrap{overflow-x:auto;max-width:100%;margin:8px 0 16px}.ai-table-wrap table{width:100%;font-family:var(--font-ui);font-size:12px;border-collapse:collapse;white-space:nowrap}.ai-table-wrap th,.ai-table-wrap td{padding:10px 12px;text-align:right;border-bottom:1px solid var(--rule);font-weight:400;font-variant-numeric:tabular-nums}.ai-table-wrap th:first-child{text-align:left}.ai-topics{padding:0;list-style:none}.ai-topics li{padding:16px 0;border-bottom:1px dashed var(--rule)}.ai-topic-head{display:flex;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted);font-family:var(--font-ui);overflow-wrap:anywhere}.ai-topics p{margin:8px 0;font-size:15px;overflow-wrap:anywhere}.ai-topics small,.ai-sync small{font-size:12px;color:var(--muted)}.ai-source{padding:8px 0 12px;border-bottom:1px dashed var(--rule)}.ai-source p{display:flex;justify-content:space-between;gap:12px;margin:8px 0;font-size:14px}.ai-source p strong{font-weight:400}.ai-source ul{font-size:12px;color:var(--muted);margin:8px 0;padding-left:20px}.ai-sync>.hint{display:block;margin-top:16px}.ai-page{max-width:1000px}@media(max-width:600px){.ai-period-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;font-size:12px}.ai-period-tabs a{text-align:center;padding:10px 2px}.ai-stats{grid-template-columns:1fr 1fr;gap:18px 12px}.ai-stats>div:first-child{grid-column:1/-1}.ai-stats>div:first-child strong{font-size:34px}.ai-stats strong{font-size:clamp(16px,4.5vw,23px)}.ai-day-nav{font-size:12px;gap:6px}.ai-picker .summary-controls{gap:8px}}
`;
module.exports = {
  render,
  renderStatus,
  CSS,
  weekLabel,
  periodPicker,
  adjacent,
};
