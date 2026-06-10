/* =========================================================================
   engine.js — מנוע הלו"ז המשותף של "צייד שינקנסן".
   עובד גם בדפדפן (window.Spotter) וגם ב-Node (module.exports).

   זהו "מקור האמת" היחיד: נתוני התחנות, דפוסי העצירה, חישוב אירועי מעבר,
   זיהוי כיוון/מצפן וזיהוי חסימה. גם הסימולציה וגם מסלול ה-Bright Data
   החי מחזירים אירועים באותו פורמט: { type, dir, timeMin, stops }.
   ========================================================================= */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api; // Node
  root.Spotter = api;                                                        // Browser
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* קו טוקאידו שינקנסן — index 0 = טוקיו (מזרח) עד שין-אוסקה (מערב).
     navitimeId/jrId שמורים כדי לבנות כתובות scraping יציבות עבור Bright Data. */
  const STATIONS = [
    { id:"tokyo",       name:"טוקיו",          jp:"東京",     lat:35.6812, lon:139.7671 },
    { id:"shinagawa",   name:"שינגאווה",       jp:"品川",     lat:35.6285, lon:139.7387 },
    { id:"shinyokohama",name:"שין-יוקוהמה",    jp:"新横浜",   lat:35.5079, lon:139.6173 },
    { id:"odawara",     name:"אודוארה",        jp:"小田原",   lat:35.2563, lon:139.1556 },
    { id:"atami",       name:"אטאמי",          jp:"熱海",     lat:35.1031, lon:139.0781 },
    { id:"mishima",     name:"מישימה",         jp:"三島",     lat:35.1267, lon:138.9111 },
    { id:"shinfuji",    name:"שין-פוג'י",      jp:"新富士",   lat:35.1417, lon:138.6633 },
    { id:"shizuoka",    name:"שיזואוקה",       jp:"静岡",     lat:34.9719, lon:138.3886 },
    { id:"kakegawa",    name:"קקגאווה",        jp:"掛川",     lat:34.7692, lon:137.9986 },
    { id:"hamamatsu",   name:"הממאטסו",        jp:"浜松",     lat:34.7036, lon:137.7347 },
    { id:"toyohashi",   name:"טויוהאשי",       jp:"豊橋",     lat:34.7628, lon:137.3819 },
    { id:"mikawaanjo",  name:"מיקאווה-אנג'ו",  jp:"三河安城", lat:34.9367, lon:137.0594 },
    { id:"nagoya",      name:"נגויה",          jp:"名古屋",   lat:35.1706, lon:136.8816 },
    { id:"gifuhashima", name:"גיפו-האשימה",    jp:"岐阜羽島", lat:35.3156, lon:136.6861 },
    { id:"maibara",     name:"מאיבארה",        jp:"米原",     lat:35.3147, lon:136.2894 },
    { id:"kyoto",       name:"קיוטו",          jp:"京都",     lat:34.9858, lon:135.7589 },
    { id:"shinosaka",   name:"שין-אוסקה",      jp:"新大阪",   lat:34.7333, lon:135.5003 },
  ];
  const N = STATIONS.length;

  /* דפוסי עצירה אמיתיים (index בקו) לכל סוג רכבת */
  const STOPS = {
    nozomi: new Set([0,1,2,12,15,16]),
    hikari: new Set([0,1,2,3,7,12,14,15,16]),
    kodama: new Set(Array.from({length:N}, (_,i)=>i)),
  };
  const TRAIN_META = {
    nozomi:{ label:"のぞみ Nozomi", cls:"nozomi", cruise:285, dwell:1.5 },
    hikari:{ label:"ひかり Hikari", cls:"hikari", cruise:255, dwell:2.0 },
    kodama:{ label:"こだま Kodama", cls:"kodama", cruise:220, dwell:1.0 },
  };
  const SCHEDULE = [
    { type:"nozomi", headway:10, downOffset:0,  upOffset:5  },
    { type:"hikari", headway:30, downOffset:8,  upOffset:23 },
    { type:"kodama", headway:20, downOffset:3,  upOffset:13 },
  ];
  const SERVICE_START = 6*60, SERVICE_END = 23*60;

  /* ---------- גאומטריה ---------- */
  const R = 6371, toRad = d=>d*Math.PI/180, toDeg = r=>r*180/Math.PI;
  function haversine(a,b){
    const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
    const s=Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
    return 2*R*Math.asin(Math.sqrt(s));
  }
  function bearing(a,b){
    const y=Math.sin(toRad(b.lon-a.lon))*Math.cos(toRad(b.lat));
    const x=Math.cos(toRad(a.lat))*Math.sin(toRad(b.lat))
          - Math.sin(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.cos(toRad(b.lon-a.lon));
    return (toDeg(Math.atan2(y,x))+360)%360;
  }
  const COMPASS_HE = ["צפון","צפון-מזרח","מזרח","דרום-מזרח","דרום","דרום-מערב","מערב","צפון-מערב"];
  const compass = deg => COMPASS_HE[Math.round(deg/45)%8];

  const CUM = (()=>{ const c=[0]; for(let i=1;i<N;i++) c[i]=c[i-1]+haversine(STATIONS[i-1],STATIONS[i]); return c; })();

  /* ---------- סימולציה דטרמיניסטית (fallback / מצב offline) ---------- */
  function eventTime(type, dir, baseMin, idx){
    const m=TRAIN_META[type], stops=STOPS[type];
    let distKm, lo, hi;
    if(dir==="down"){ distKm=CUM[idx]-CUM[0]; lo=1; hi=idx; }
    else            { distKm=CUM[N-1]-CUM[idx]; lo=idx+1; hi=N-2; }
    let travel = distKm/m.cruise*60;
    for(let i=lo;i<=hi;i++) if(stops.has(i)) travel += m.dwell;
    return baseMin + travel;
  }
  function buildSimEvents(idx){
    const out=[];
    for(const s of SCHEDULE){
      for(const dir of ["down","up"]){
        const off = dir==="down" ? s.downOffset : s.upOffset;
        for(let base=SERVICE_START+off; base<=SERVICE_END; base+=s.headway){
          const t=eventTime(s.type,dir,base,idx);
          if(t<SERVICE_START || t>SERVICE_END+30) continue;
          out.push({ type:s.type, dir, timeMin:t, stops:STOPS[s.type].has(idx) });
        }
      }
    }
    out.sort((a,b)=>a.timeMin-b.timeMin);
    return out;
  }

  /* ---------- אינטרפולציית זמן-מעבר מנתוני scraping אמיתיים ----------
     בהינתן לו"ז אמיתי של רכבת אחת (זמנים בתחנות שבהן היא כן עוצרת),
     מחשבים מתי היא חולפת בתחנה idx (שבה היא לא עוצרת) לפי מרחק יחסי
     בין שתי תחנות העצירה שעוטפות אותה.
     schedule = [{ idx, timeMin }] ממויין; dir = "down" | "up".          */
  function interpolatePass(schedule, idx, dir){
    const pts = schedule.slice().sort((a,b)=> dir==="down" ? a.idx-b.idx : b.idx-a.idx);
    for(let k=0;k<pts.length-1;k++){
      const a=pts[k], b=pts[k+1];
      const lo=Math.min(a.idx,b.idx), hi=Math.max(a.idx,b.idx);
      if(idx>lo && idx<hi){
        const frac=(CUM[idx]-CUM[lo])/(CUM[hi]-CUM[lo]);
        const tLo = a.idx===lo ? a.timeMin : b.timeMin;
        const tHi = a.idx===hi ? a.timeMin : b.timeMin;
        return tLo + frac*(tHi-tLo);
      }
    }
    return null; // התחנה מחוץ לטווח הלו"ז שנסרק
  }

  /* ---------- כיוון/מצפן + זיהוי חסימה (משותף לכל המקורות) ---------- */
  function approachBearing(idx, dir){
    if(dir==="down"){ const p=Math.max(0,idx-1); return bearing(STATIONS[idx],STATIONS[p]); }
    const p=Math.min(N-1,idx+1); return bearing(STATIONS[idx],STATIONS[p]);
  }
  function blockingTrain(events, t, dir){
    for(const e of events){
      if(!e.stops || e.dir!==dir) continue;
      const dwell = e.type==="kodama" ? 6 : (TRAIN_META[e.type]?.dwell ?? 1.5);
      if(t>=e.timeMin-0.3 && t<=e.timeMin+dwell+0.3) return { type:e.type, until:e.timeMin+dwell };
    }
    return null;
  }
  function nearestStation(lat,lon){
    let best=0,bd=Infinity;
    for(let i=0;i<N;i++){ const d=haversine({lat,lon},STATIONS[i]); if(d<bd){bd=d;best=i;} }
    return { idx:best, dist:bd };
  }

  return {
    STATIONS, STOPS, TRAIN_META, SCHEDULE, N, CUM,
    SERVICE_START, SERVICE_END,
    haversine, bearing, compass, approachBearing,
    buildSimEvents, interpolatePass, blockingTrain, nearestStation,
    indexOfId: id => STATIONS.findIndex(s=>s.id===id),
  };
});
