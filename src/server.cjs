const http = require("node:http");
const path = require("node:path");
const { load } = require("./config.cjs");
const { DIR, read, today } = require("./core.cjs");
const view = require("./view.cjs");
const heatmap = require("./heatmap.cjs");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const validDate = (date) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date) &&
  !Number.isNaN(Date.parse(date + "T12:00:00Z")) &&
  new Date(date + "T12:00:00Z").toISOString().slice(0, 10) === date;
const css = `:root{color-scheme:light;--font-ui:ui-monospace,SFMono-Regular,Consolas,monospace;--soft:#f0f6fc;--muted:#687582;--rule:#e5e7eb;--border:#ccd1d8;--link:#0969da}*{box-sizing:border-box}body{margin:0;background:#fff;color:#20252a;font:16px/1.7 system-ui,sans-serif}header{display:flex;gap:12px;flex-wrap:wrap;justify-content:space-between;align-items:center;max-width:1000px;margin:auto;padding:25px 28px;border-bottom:1px dashed var(--rule)}header>a{color:inherit;font-family:var(--font-ui);font-size:24px;font-weight:700}a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}main{max-width:1000px;margin:auto;padding:32px 28px}h1,h2,h3{font-family:var(--font-ui)}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.summary-picker>label{display:block;font-size:23px}.summary-controls{display:flex;gap:20px;align-items:center}.summary-controls input{flex:1;min-width:0;border:0;border-bottom:1px dashed var(--border);border-radius:0;padding:12px 0;background:transparent;font:inherit}.summary-controls button{border:0;background:none;color:var(--link);font:inherit;padding:12px;cursor:pointer}.hint{color:var(--muted);font-size:13px}.intro{text-align:center;margin:20px 0 40px}.home-links{display:flex;justify-content:center;gap:24px;margin:32px 0}.home-total{text-align:center;font-family:var(--font-ui);font-size:30px;margin:30px 0}.home-total small{font:14px system-ui;display:block;color:var(--muted)}@media(max-width:600px){main{padding:24px 16px}header{padding:18px 16px}.intro{margin:8px 0 28px}}`;
function layout(body) {
  return (
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Token-Diary</title><style>' +
    css +
    heatmap.CSS +
    '</style></head><body><header><a href="/">Token-Diary</a><nav><a href="/ai/">Usage</a> · <a href="/ai/status/">采集状态</a></nav></header><main>' +
    body +
    "</main></body></html>"
  );
}
function createServer(config = load()) {
  return http.createServer((req, res) => {
    const host = req.headers.host || "";
    if (!/^(?:127\.0\.0\.1|localhost):\d+$/.test(host)) {
      res.writeHead(403);
      res.end("Local access only");
      return;
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD" });
        res.end();
        return;
      }
      const url = new URL(req.url, "http://" + host);
      const date = url.searchParams.get("date") || today();
      if (!validDate(date) || date > today()) {
        res.writeHead(400);
        res.end("Invalid date");
        return;
      }
      let body;
      if (url.pathname === "/") {
        const year = url.searchParams.get("heatmapYear") || date.slice(0, 4);
        if (
          !/^\d{4}$/.test(year) ||
          year < "1900" ||
          year > today().slice(0, 4)
        ) {
          res.writeHead(400);
          res.end("Invalid year");
          return;
        }
        const index = read(path.join(DIR, "index.json"), { dates: [] });
        const total = index.dates.reduce((sum, day) => sum + day.total, 0);
        body =
          '<p class="intro">AI 用量，和每天做过的事</p><div class="home-total">' +
          total.toLocaleString("en-US") +
          "<small>recorded tokens · " +
          esc(config.timezone) +
          " · 00:00</small></div>" +
          heatmap.renderHeatmap(index, year, date, date) +
          '<nav class="home-links"><a href="/ai/?date=' +
          date +
          '">Daily journal →</a><a href="/ai/?period=total">Total →</a></nav>' +
          (index.dates.length
            ? ""
            : '<p class="intro hint">暂无记录。运行 ai-log collect，或用 ai-log demo 查看模拟数据。</p>');
      } else if (url.pathname === "/ai/status/") body = view.renderStatus();
      else if (url.pathname === "/ai/") {
        const kind = url.searchParams.get("period") || "day";
        if (!["day", "week", "month", "year", "total"].includes(kind)) {
          res.writeHead(400);
          res.end("Invalid period");
          return;
        }
        const picker =
          '<input type="date" id="ai-date" name="date" value="' +
          date +
          '" max="' +
          today() +
          '" required>';
        body = view.render(date, picker, "", kind);
      } else if (url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
        return;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(req.method === "HEAD" ? "" : layout(body));
    } catch {
      res.writeHead(500);
      res.end("Unable to read local data");
    }
  });
}
async function serve({ port = 4317 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid port");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  console.log("Token-Diary: http://127.0.0.1:" + server.address().port);
  return server;
}
module.exports = { createServer, serve, validDate, layout };
