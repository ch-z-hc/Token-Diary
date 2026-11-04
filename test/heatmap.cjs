const assert = require("assert/strict"),
  { calendar, renderHeatmap } = require("../src/heatmap.cjs");
const d = [
    { date: "2024-02-28", total: 10 },
    { date: "2024-02-29", total: 100 },
    { date: "2024-03-01", total: 1000 },
    { date: "2024-03-02", total: 0 },
  ],
  c = calendar("2024", d, "2024-03-01");
assert.equal(c.cells.filter((d) => !d.padding).length, 366);
assert.equal(c.cells.length % 7, 0);
assert.equal(new Date(c.start + "T12:00:00Z").getUTCDay(), 1);
console.log("PASS leap year uses 366 days in complete Monday-first weeks");
const known = c.cells.filter((d) => d.known);
assert.equal(known.length, 3);
assert.equal(
  known.reduce((s, d) => s + d.total, 0),
  1110,
);
assert(c.cells.find((d) => d.date === "2024-03-02").future);
assert(!c.cells.find((d) => d.date === "2024-03-02").known);
console.log(
  "PASS known token totals are exact and future records are excluded",
);
assert(known[0].level < known[1].level && known[1].level < known[2].level);
assert.equal(c.cells.find((d) => d.date === "2024-02-27").total, null);
console.log(
  "PASS shade levels increase with tokens; missing records stay unknown",
);
const zero = calendar("2024", d, "2024-03-03").cells.find(
  (d) => d.date === "2024-03-02",
);
assert(zero.known);
assert.equal(zero.total, 0);
assert.equal(zero.level, 0);
console.log("PASS known zero differs from missing history");
const normal = calendar("2026", [], "2026-11-04");
assert.equal(normal.cells.filter((d) => !d.padding).length, 365);
assert.equal(normal.weeks, 53);
console.log("PASS ordinary calendar year has 365 days and 53 columns");
const html = renderHeatmap({ dates: d }, "2024", "2024-03-01", "2024-02-28");
assert(html.includes('href="/ai/?date=2024-02-29"'));
assert(html.includes('data-tokens="100"'));
assert(html.includes('href="/?date=2024-02-28&amp;heatmapYear=2024"'));
assert(!html.includes("30 Days"));
assert(!html.includes("ai-history"));
console.log("PASS heatmap links navigate to original daily records");
