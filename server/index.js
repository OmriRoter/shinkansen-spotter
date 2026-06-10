/* =========================================================================
   index.js — small local dev server. Serves the static front-end and routes
   /api/next-trains to the same handler used in production (api/next-trains.js),
   so there is one source of truth for the scraping logic.

   Run:  npm install && npm start   (default port 8080)
   ========================================================================= */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const apiHandler = require("../api/next-trains.js");

const PORT = process.env.PORT || 8080;
const ROOT = path.join(__dirname, "..");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
               ".css": "text/css", ".json": "application/json", ".ico": "image/x-icon" };

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

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/api/next-trains") {
    // adapt Node's req/res to the Vercel-style handler interface
    req.query = parsed.query;
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(o)); };
    return Promise.resolve(apiHandler(req, res)).catch(() => { res.statusCode = 500; res.end("{}"); });
  }
  return serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Shinkansen Spotter on http://localhost:${PORT}`);
  console.log(process.env.BRIGHTDATA_API_TOKEN
    ? "  Bright Data: configured (live scraping enabled)"
    : "  Bright Data: not configured — simulation mode. See .env.example");
});
