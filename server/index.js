/* =========================================================================
   index.js — שרת proxy קטן ל"צייד שינקנסן".

   - מגיש את ה-front-end (../).
   - /api/next-trains?station=<id> מחזיר אירועי-רכבת בפורמט המנוע.
       * אם יש טוקן Bright Data ↦ מושך נתונים חיים (source:"brightdata").
       * אחרת / בכשל scraping ↦ נופל לסימולציה (source:"simulation").
   - /api/health מחזיר אם Bright Data מוגדר.

   הרצה:  npm install && npm start   (ברירת מחדל פורט 8080)
   ========================================================================= */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const Spotter = require("../engine");
const { hasCredentials } = require("./brightdata");
const { buildLiveEvents } = require("./scrape-navitime");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".ico": "image/x-icon" };

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8",
                        "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let p = url.parse(req.url).pathname;
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, brightData: hasCredentials() });
  }

  if (parsed.pathname === "/api/next-trains") {
    const id = parsed.query.station || "odawara";
    const idx = Spotter.indexOfId(id);
    if (idx < 0) return sendJson(res, 400, { error: "unknown station id" });

    // ניסיון נתונים חיים דרך Bright Data, עם נפילה רכה לסימולציה
    if (hasCredentials()) {
      try {
        const events = await buildLiveEvents(idx);
        if (events.length) {
          return sendJson(res, 200, { source: "brightdata", station: id, events });
        }
        console.warn(`[next-trains] Bright Data returned 0 events for ${id}; using simulation.`);
      } catch (err) {
        console.warn(`[next-trains] Bright Data failed (${err.message}); using simulation.`);
      }
    }
    return sendJson(res, 200, {
      source: "simulation", station: id, events: Spotter.buildSimEvents(idx),
    });
  }

  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`🚄 Shinkansen Spotter on http://localhost:${PORT}`);
  console.log(hasCredentials()
    ? "   Bright Data: configured ✓ (live scraping enabled)"
    : "   Bright Data: not configured — running in simulation mode. See .env.example");
});
