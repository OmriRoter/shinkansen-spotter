/* =========================================================================
   brightdata.js — לקוח ל-Bright Data Web Unlocker / Browser API.

   זהו בדיוק מנגנון ה-scraping שה-"Bright Data MCP" עוטף: ה-MCP פשוט
   קורא ל-Web Unlocker עם טוקן ו-zone. כאן אנחנו קוראים ל-REST API ישירות
   כדי שהשרת יוכל למשוך נתונים חיים גם בלי שרת MCP מחובר.

   צריך משתני סביבה (ראו .env.example):
     BRIGHTDATA_API_TOKEN   — הטוקן מ-account settings
     BRIGHTDATA_ZONE        — שם ה-Web Unlocker zone (ברירת מחדל: web_unlocker1)

   Docs: https://docs.brightdata.com/scraping-automation/web-unlocker/send-your-first-request
   ========================================================================= */
"use strict";

const API_URL = "https://api.brightdata.com/request";

function hasCredentials() {
  return Boolean(process.env.BRIGHTDATA_API_TOKEN);
}

/**
 * מושך URL דרך Bright Data Web Unlocker (עוקף anti-bot, CAPTCHA, חסימות גאו').
 * @param {string} url        — היעד לגרד
 * @param {object} [opts]
 * @param {boolean} [opts.renderJs=false] — true => Browser API לרינדור JS מלא
 * @param {string}  [opts.country="jp"]   — יוצא מ-IP יפני (חשוב לאתרי JR)
 * @returns {Promise<string>} — ה-HTML/JSON הגולמי
 */
async function unlock(url, opts = {}) {
  if (!hasCredentials()) {
    throw new Error("BRIGHTDATA_API_TOKEN is not set — cannot reach Bright Data.");
  }
  const body = {
    zone: process.env.BRIGHTDATA_ZONE || "web_unlocker1",
    url,
    format: "raw",
    country: opts.country || "jp",
  };
  // רינדור JS מלא (לדפים כמו מיקום-רכבות חי של JR) דורש zone מסוג Browser/Unlocker עם data_format
  if (opts.renderJs) body.data_format = "html";

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.BRIGHTDATA_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Bright Data responded ${res.status}: ${txt.slice(0, 300)}`);
  }
  return res.text();
}

module.exports = { unlock, hasCredentials };
