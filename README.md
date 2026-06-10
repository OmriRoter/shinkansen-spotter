# 🚄 צייד שינקנסן — Bullet Train Spotter

אפליקציה שעוזרת לצלם רכבות שינקנסן מהירות **שחולפות בתחנה בלי לעצור**: מאתרת את התחנה
הקרובה אליך ביפן, מציגה בזמן אמת מתי הרכבת המהירה הבאה חולפת, מאיזה כיוון (מצפן),
ומזהירה אם רכבת עומדת בתחנה עלולה להסתיר את הצילום.

עובדת בשני מצבים:
- **סימולציה** (offline, ללא תלות) — מנוע דטרמיניסטי לפי דפוסי קו טוקאידו האמיתיים.
- **חי · Bright Data** — מושך לוחות-זמנים אמיתיים דרך **Bright Data Web Unlocker** ומחשב זמני מעבר.

---

## למה צריך את Bright Data (ממצאי המחקר)

כדי לדעת מתי רכבת *חולפת* בתחנה שבה היא לא עוצרת צריך נתונים אמיתיים. בדקתי את המקורות:

| מקור | מה יש בו | הבעיה ל-scraper רגיל |
|------|----------|----------------------|
| [JR Central — מיקום רכבות חי](https://traininfo.jr-central.co.jp/shinkansen/pc/ja/ti08.html) | מיקום בזמן-אמת של כל רכבת בקו טוקאידו + עיכובים | **מחזיר 403 Forbidden** ל-fetch רגיל (אימתתי) — חומת anti-bot |
| [NAVITIME](https://japantravel.navitime.com/en/area/jp/timetable/00006668/00000110) | לו"ז מלא לכל רכבת Nozomi/Hikari בנפרד | מרונדר ב-JS + הגנת bot |
| [JR-West train-guide](https://www.train-guide.westjr.co.jp/) | feed מיקום חי לקו סאניו | JS כבד, חוסם scraping |

המסקנה: הדפים הרשמיים חוסמים גרידה רגילה. **Bright Data Web Unlocker עוקף 403/CAPTCHA/חסימות-גאו ומחזיר HTML נקי** — וזה בדיוק מה ש"Bright Data MCP" עוטף מאחורי הקלעים.

> רכבת שלא עוצרת **לא מופיעה** בלוח-היציאות של התחנה. לכן מחשבים את זמן-המעבר
> ב**אינטרפולציה לפי מרחק** בין שתי תחנות-העצירה שעוטפות אותה (`Spotter.interpolatePass`).

---

## ארכיטקטורה

```
engine.js                 מקור-אמת משותף (browser + Node): תחנות, דפוסי עצירה,
                          חישוב מעבר/כיוון/מצפן/חסימה. פורמט אירוע: {type,dir,timeMin,stops}
index.html                ה-UI. טוען engine.js. בורר "סימולציה / חי".
server/index.js           proxy: מגיש את ה-UI + /api/next-trains + /api/health
server/brightdata.js      לקוח Bright Data Web Unlocker (REST: POST api.brightdata.com/request)
server/scrape-navitime.js מושך לו"ז דרך Bright Data → אינטרפולציה → אירועי-מעבר
```

זרימת בקשה במצב חי: `index.html → /api/next-trains?station=odawara →
scrape-navitime (Bright Data unlock) → אירועים → אותו UI`. בכל כשל (אין טוקן /
גרידה נכשלה / 0 תוצאות) — **נפילה רכה אוטומטית לסימולציה**, כך שה-UI תמיד עובד.

---

## הרצה

### מצב סימולציה בלבד (ללא התקנה)
פותחים את `index.html` ישירות בדפדפן.

### מצב מלא עם שרת + Bright Data
```bash
cd shinkansen-spotter
cp .env.example .env          # מלא BRIGHTDATA_API_TOKEN ו-BRIGHTDATA_ZONE
npm start                     # http://localhost:8080
npm test                      # בדיקות המנוע והפענוח
```
דורש Node ≥ 18 (משתמש ב-`fetch` המובנה). אין dependencies חיצוניים.

### חיבור Bright Data
1. ב-[brightdata.com](https://brightdata.com) צור **Web Unlocker zone**.
2. העתק את ה-API token ושם ה-zone אל `.env`:
   ```
   BRIGHTDATA_API_TOKEN=xxxxxxxx
   BRIGHTDATA_ZONE=web_unlocker1
   ```
3. `npm start` ירשום `Bright Data: configured ✓`. הבורר "חי" יתחיל למשוך נתונים אמיתיים.

ה-API שבו השרת משתמש (זהה למה שה-MCP עושה):
```
POST https://api.brightdata.com/request
Authorization: Bearer <TOKEN>
{ "zone": "<zone>", "url": "<target>", "format": "raw", "country": "jp" }
```

---

## שדרוגים אפשריים
- **מעבר ל-JR Central running-position (ti08)** עם `renderJs:true` (Browser API) לקבלת
  מיקומי-רכבת חיים + עיכובים אמיתיים במקום אינטרפולציה.
- הוספת קווים: Sanyo, Tohoku, Hokuriku (להוסיף ל-`STATIONS`/`STOPS` ב-engine.js).
- cache קצר (30-60ש') בשרת כדי לחסוך קריאות Bright Data.

## ⚠️ בטיחות
כלי הדגמה. **לעולם אל תתקרב מעבר לקו הצהוב.** רכבות חולפות במהירות גבוהה מאוד.
