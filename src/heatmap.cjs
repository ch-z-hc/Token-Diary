const { today } = require("./core.cjs");
const { shift } = require("./periods.cjs");
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function calendar(year, dates, through = today()) {
  const from = year + "-01-01",
    to = year + "-12-31",
    weekday = (new Date(from + "T12:00:00Z").getUTCDay() + 6) % 7,
    start = shift(from, -weekday),
    lastWeekday = (new Date(to + "T12:00:00Z").getUTCDay() + 6) % 7,
    end = shift(to, 6 - lastWeekday);
  const activity = new Map(
    dates.filter((d) => d.date <= through).map((d) => [d.date, d]),
  );
  const values = new Map(
      dates
        .filter(
          (d) =>
            d.date >= from &&
            d.date <= to &&
            d.date <= through &&
            !(d.messages && !d.requests),
        )
        .map((d) => [d.date, d.total]),
    ),
    positive = [...values.values()].filter((n) => n > 0).sort((a, b) => a - b),
    cuts = [0.25, 0.5, 0.75].map(
      (q) => positive[Math.floor((positive.length - 1) * q)] || 0,
    );
  const cells = [];
  for (let date = start; date <= end; date = shift(date, 1)) {
    const padding = date < from || date > to,
      future = !padding && date > through,
      known = !padding && !future && values.has(date),
      total = known ? values.get(date) : null;
    const level = total > 0 ? 1 + cuts.filter((c) => total > c).length : 0;
    cells.push({
      date,
      padding,
      future,
      known,
      total,
      level,
      ...(activity.get(date)?.messages
        ? { messages: activity.get(date).messages }
        : {}),
    });
  }
  const months = MONTHS.map((name, i) => ({
    name,
    column: Math.floor(
      (Date.parse(
        year + "-" + String(i + 1).padStart(2, "0") + "-01T12:00:00Z",
      ) -
        Date.parse(start + "T12:00:00Z")) /
        (7 * 86400000),
    ),
  }));
  return { year, cells, months, weeks: cells.length / 7, start };
}
function renderHeatmap(index, year, date, homeDate) {
  const c = calendar(year, index.dates),
    years = [...new Set([...index.dates.map((d) => d.date.slice(0, 4)), year])]
      .sort()
      .reverse();
  const focus = date.startsWith(year)
      ? date
      : today().startsWith(year)
        ? today()
        : year + "-12-31",
    focusColumn = Math.floor(
      (Date.parse(focus + "T12:00:00Z") - Date.parse(c.start + "T12:00:00Z")) /
        (7 * 86400000),
    );
  const cells = c.cells
    .map((d) => {
      if (d.padding)
        return '<span class="ai-heatmap-cell padding" aria-hidden="true"></span>';
      if (d.future)
        return `<span class="ai-heatmap-cell future" data-date="${d.date}" aria-hidden="true"></span>`;
      const label =
          d.date +
          " · " +
          (d.known
            ? Number(d.total).toLocaleString("en-US") + " tokens"
            : d.messages
              ? d.messages + (d.messages === 1 ? " chat message" : " chat messages")
              : "No records"),
        attrs = `class="ai-heatmap-cell${d.date === date ? " selected" : ""}" data-date="${d.date}" data-level="${d.level}" title="${label}" aria-label="${label}"`;
      return d.known || d.messages
        ? `<a ${attrs} ${d.known ? `data-tokens="${d.total}"` : ""} href="/ai/?date=${d.date}"></a>`
        : `<span ${attrs} role="img"></span>`;
    })
    .join("");
  return `<section class="ai-section ai-heatmap-section"><div class="ai-heatmap-heading"><h3>Token Activity</h3><nav aria-label="Activity year">${years.map((y) => `<a href="/?date=${homeDate}&amp;heatmapYear=${y}"${y === year ? ' aria-current="date"' : ""}>${y}</a>`).join("")}</nav></div><div class="ai-heatmap-scroll" data-focus-column="${focusColumn}"><div class="ai-heatmap" data-year="${year}" style="--weeks:${c.weeks}"><div class="ai-heatmap-months">${c.months.map((m) => `<span style="grid-column:${m.column + 1}">${m.name}</span>`).join("")}</div><div class="ai-heatmap-weekdays" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div><div class="ai-heatmap-days" role="group" aria-label="${year} daily token usage">${cells}</div></div></div><div class="ai-heatmap-legend"><span>Less</span>${[0, 1, 2, 3, 4].map((n) => `<i class="ai-heatmap-cell" data-level="${n}" aria-hidden="true"></i>`).join("")}<span>More</span></div></section><script>(function(){const box=document.querySelector('.ai-heatmap-scroll');if(box)box.scrollLeft=Math.max(0,(Number(box.dataset.focusColumn)+2)*15+34-box.clientWidth)})();</script>`;
}
const CSS = `
.ai-heatmap-section{max-width:900px;margin:0 auto 28px;text-align:left}.ai-heatmap-section .ai-heatmap-heading h3{font-size:19px;margin:0 0 16px}.ai-heatmap-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px}.ai-heatmap-heading nav{display:flex;flex-wrap:wrap;gap:6px;font-family:var(--font-ui);font-size:13px}.ai-heatmap-heading nav a{padding:6px 8px;border-radius:6px}.ai-heatmap-heading nav a[aria-current]{background:var(--soft)}.ai-heatmap-scroll{max-width:100%;overflow-x:auto;padding:3px 2px 8px;overscroll-behavior-x:contain}.ai-heatmap{display:grid;grid-template-columns:30px max-content;grid-template-rows:20px max-content;column-gap:4px;row-gap:4px;width:max-content;margin-inline:auto;font-family:var(--font-ui);font-size:10px;color:var(--muted)}.ai-heatmap-months{grid-column:2;display:grid;grid-template-columns:repeat(var(--weeks),12px);gap:3px;line-height:16px}.ai-heatmap-months span{grid-row:1}.ai-heatmap-weekdays{grid-column:1;grid-row:2;display:grid;grid-template-rows:repeat(7,12px);row-gap:3px;line-height:12px}.ai-heatmap-weekdays span:nth-child(1){grid-row:1}.ai-heatmap-weekdays span:nth-child(2){grid-row:3}.ai-heatmap-weekdays span:nth-child(3){grid-row:5}.ai-heatmap-days{grid-column:2;grid-row:2;display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,12px);grid-template-columns:repeat(var(--weeks),12px);gap:3px}.ai-heatmap-cell{display:block;width:12px;height:12px;border-radius:2px;background:#eff2f5;box-shadow:inset 0 0 0 1px rgba(27,31,35,.06)}.ai-heatmap-cell[data-level="1"]{background:#9be9a8}.ai-heatmap-cell[data-level="2"]{background:#40c463}.ai-heatmap-cell[data-level="3"]{background:#30a14e}.ai-heatmap-cell[data-level="4"]{background:#216e39}.ai-heatmap-cell.padding{visibility:hidden}.ai-heatmap-cell.future{opacity:.35}.ai-heatmap-days a:hover,.ai-heatmap-days a:focus-visible,.ai-heatmap-cell.selected{outline:2px solid var(--link);outline-offset:1px}.ai-heatmap-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;font-family:var(--font-ui);font-size:11px;color:var(--muted);margin-top:8px}.ai-heatmap-legend span{margin-inline:4px}
`;
module.exports = { calendar, renderHeatmap, CSS };
