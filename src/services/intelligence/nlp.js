'use strict';
/**
 * NECPRA Intelligence: language utilities (no network, no dependencies).
 * Normalisation, English + Kiswahili number words, amounts, phone numbers, time periods and simple dates.
 * Adding another language = add its words to NUMBER_WORDS / PERIOD_WORDS and its lexicon in intents.js.
 */

const strip = (s) => { try { return s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); } catch (_) { return s; } };

/** Lower-case, accent-free, punctuation-free; "5k" -> 5000, "1,500" -> 1500, "m-pesa" -> "mpesa". Padded with spaces for whole-word matching. */
function normalize(text) {
  let t = strip(String(text == null ? '' : text).toLowerCase());
  t = t.replace(/\bm[\s-]?pesa\b/g, 'mpesa')
    .replace(/(\d),(\d{3})\b/g, '$1$2')
    .replace(/\b(\d+(?:\.\d+)?)\s?k\b/g, (_, n) => String(Math.round(parseFloat(n) * 1000)))
    .replace(/['’`]s\b/g, '').replace(/['’`]/g, '')
    .replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();
  return ' ' + t + ' ';
}

const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// Kiswahili: moja mbili tatu nne tano sita saba nane tisa kumi; tens "ishirini thelathini arobaini hamsini sitini sabini themanini tisini"; mia = 100; elfu = 1000
const SW_ONES = { moja: 1, mbili: 2, tatu: 3, nne: 4, tano: 5, sita: 6, saba: 7, nane: 8, tisa: 9, kumi: 10 };
const SW_TENS = { ishirini: 20, thelathini: 30, arobaini: 40, hamsini: 50, sitini: 60, sabini: 70, themanini: 80, tisini: 90 };

/** Replace English / Kiswahili number words by digits inside an already normalised string. Handles "elfu mbili" (2000), "mia tano" (500), "one thousand five hundred". */
function numberWordsToDigits(norm) {
  const toks = norm.trim().split(' ');
  const out = [];
  let i = 0;
  const isNum = (w) => w in ONES || w in TENS || w in SW_ONES || w in SW_TENS || w === 'hundred' || w === 'thousand' || w === 'mia' || w === 'elfu' || w === 'and' || w === 'na' || w === 'a';
  while (i < toks.length) {
    if (!(toks[i] in ONES || toks[i] in TENS || toks[i] in SW_ONES || toks[i] in SW_TENS || toks[i] === 'hundred' || toks[i] === 'thousand' || toks[i] === 'mia' || toks[i] === 'elfu' || (toks[i] === 'a' && /^(hundred|thousand)$/.test(toks[i + 1] || '')))) { out.push(toks[i]); i++; continue; }
    let j = i; while (j < toks.length && isNum(toks[j])) j++;
    while (j > i && /^(and|na|a)$/.test(toks[j - 1])) j--;          // never swallow a trailing connector
    const seg = toks.slice(i, j);
    let total = 0, cur = 0, sw = false, ok = true;
    for (let k = 0; k < seg.length; k++) {
      const w = seg[k];
      if (w === 'and' || w === 'na') continue;
      if (w === 'a') { cur = cur || 1; continue; }
      if (w in ONES) cur += ONES[w]; else if (w in TENS) cur += TENS[w];
      else if (w in SW_ONES) cur += SW_ONES[w]; else if (w in SW_TENS) cur += SW_TENS[w];
      else if (w === 'hundred') cur = (cur || 1) * 100;
      else if (w === 'thousand') { total += (cur || 1) * 1000; cur = 0; }
      else if (w === 'mia') { sw = true; const nx = seg[k + 1]; const mult = nx in SW_ONES ? SW_ONES[nx] : 1; cur += 100 * mult; if (nx in SW_ONES) k++; }
      else if (w === 'elfu') { sw = true; const nx = seg[k + 1]; const mult = nx in SW_ONES ? SW_ONES[nx] : 1; total += 1000 * mult; if (nx in SW_ONES) k++; }
      else ok = false;
    }
    if (ok && (total + cur) > 0) out.push(String(total + cur)); else out.push(...seg);
    void sw; i = j;
  }
  return ' ' + out.join(' ') + ' ';
}

/** Prepare text for matching: normalise + digitise number words. */
function prepare(text) { return numberWordsToDigits(normalize(text)); }

/** First plausible money amount (not a phone number, not a year-looking token). Returns a number or null. */
function extractAmount(prepared) {
  const t = prepared.replace(/(?:\+?254|\b0)[17]\d{8}\b/g, ' ');           // drop phone numbers first
  const m = /\b(\d{1,9}(?:\.\d{1,2})?)\b/.exec(t.replace(/\b(?:ksh|kes|bob|shillings|shilingi)\b/g, ' '));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 10000000 ? n : null;
}

/** Kenyan phone number -> 2547XXXXXXXX, or null. */
function extractPhone(prepared) {
  const m = /(?:\+?254|\b0)([17]\d{8})\b/.exec(prepared);
  return m ? '254' + m[1] : null;
}

const PERIOD_WORDS = {
  today: ['today', 'leo', 'hivi leo', 'sasa hivi'],
  yesterday: ['yesterday', 'jana'],
  week: ['this week', 'week', 'wiki hii', 'wiki', 'weekly'],
  last_week: ['last week', 'wiki iliyopita', 'wiki jana'],
  month: ['this month', 'month', 'mwezi huu', 'mwezi', 'monthly'],
  last_month: ['last month', 'mwezi uliopita', 'mwezi jana']
};

/** today|yesterday|week|last_week|month|last_month, or null. Longest phrase wins so "last week" is not read as "week". */
function extractPeriod(prepared) {
  let best = null, bestLen = 0;
  for (const [k, words] of Object.entries(PERIOD_WORDS)) {
    for (const w of words) {
      if (prepared.includes(' ' + w + ' ') && w.length > bestLen) { best = k; bestLen = w.length; }
    }
  }
  return best;
}

/** "tomorrow" / "kesho" / "in 3 days" -> ISO date (YYYY-MM-DD) relative to `now`, in UTC+3 (Nairobi). Null when no date was said. */
function extractDueDate(prepared, now = new Date()) {
  const nairobi = new Date(now.getTime() + 3 * 3600 * 1000);
  const base = Date.UTC(nairobi.getUTCFullYear(), nairobi.getUTCMonth(), nairobi.getUTCDate());
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const DAY = 86400000;
  if (/ (?:day after tomorrow|keshokutwa) /.test(prepared)) return iso(base + 2 * DAY);
  if (/ (?:tomorrow|kesho) /.test(prepared)) return iso(base + DAY);
  if (/ (?:today|leo) /.test(prepared)) return iso(base);
  const inDays = /\b(?:in|baada ya)\s+(\d{1,3})\s+(?:days?|siku)\b/.exec(prepared);
  if (inDays) return iso(base + Number(inDays[1]) * DAY);
  return null;
}

const WEEKDAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, jumapili: 0, jumatatu: 1, jumanne: 2, jumatano: 3, alhamisi: 4, ijumaa: 5, jumamosi: 6 };

/**
 * Parse WHEN a reminder should fire, from what the person said (English / Kiswahili), in Nairobi time (UTC+3).
 * Understands: "in 2 hours", "baada ya masaa 2", "in 30 minutes", "tomorrow", "kesho", "friday", "at 8am", "at 14:30", "saa tatu asubuhi".
 * Only a date -> 09:00. Only a time -> today if still ahead, otherwise tomorrow. "at 8" with no am/pm: 1-6 = pm, 7-11 = am (the reply states the
 * exact time so the person can correct it). Swahili clock: saa moja = 07:00 ... saa tatu = 09:00 ... saa kumi na mbili = 18:00 (jioni/usiku -> pm).
 * Returns { date:'YYYY-MM-DD', time:'HH:MM', dueAt:ISO(UTC), label } or null when nothing about time was said (or it is in the past).
 */
function parseWhen(text, now = new Date()) {
  const p = prepare(text);
  const NAIROBI = 3 * 3600 * 1000, DAY = 86400000, nowMs = now.getTime();
  const fmt = (ms) => { const d = new Date(ms + NAIROBI); return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) }; };
  const done = (ms) => (ms > nowMs ? Object.assign(fmt(ms), { dueAt: new Date(ms).toISOString() }, { label: null }) : null);
  const rel = /\b(?:in|baada ya)\s+(?:masaa\s+|saa\s+)?(\d{1,3})\s*(hours?|hrs?|minutes?|mins?|masaa|saa|dakika)?\b/.exec(p);
  if (rel && (rel[2] || /baada ya\s+(?:masaa|saa)/.test(rel[0]))) {
    const n = Number(rel[1]), unit = rel[2] || 'saa', mins = /^(min|dakika)/.test(unit) ? n : n * 60;
    if (mins > 0 && mins <= 60 * 24 * 30) return done(nowMs + mins * 60000);
  }
  const base = Date.UTC(...(() => { const d = new Date(nowMs + NAIROBI); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; })()) - NAIROBI;   // Nairobi midnight as UTC ms
  let dayMs = null;
  const d0 = extractDueDate(p, now);
  if (d0) { const [y, m, d] = d0.split('-').map(Number); dayMs = Date.UTC(y, m - 1, d) - NAIROBI; }
  else {
    const wd = new RegExp(' (' + Object.keys(WEEKDAYS).join('|') + ')(?= )').exec(p);
    if (wd) { const today = new Date(nowMs + NAIROBI).getUTCDay(); let add = (WEEKDAYS[wd[1]] - today + 7) % 7; if (add === 0) add = 7; dayMs = base + add * DAY; }
  }
  let mins = null;
  const raw = String(text == null ? '' : text).toLowerCase();   // keep ':' (normalize() drops it)
  const en = /\b(\d{1,2}):(\d{2})\s*(am|pm)?/.exec(raw) || /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?!\d)/.exec(p);
  if (en) {
    let h = Number(en[1]); const m = Number(en[2] || 0);
    if (h <= 23 && m <= 59) { if (en[3]) { if (h > 12 || h === 0) h = -1; else h = (h % 12) + (en[3] === 'pm' ? 12 : 0); } else if (h >= 1 && h <= 6) h += 12; if (h >= 0) mins = h * 60 + m; }
  } else {
    const sw = /\bsaa\s+(\d{1,2})\b(?:\s+(asubuhi|mchana|jioni|usiku))?/.exec(p);
    if (sw) { const n = Number(sw[1]); if (n >= 1 && n <= 12) { let h = (n + 5) % 12 + 1; if (sw[2] === 'jioni' || sw[2] === 'usiku') { if (h < 12) h += 12; } else if (sw[2] === 'mchana' && h <= 3) h += 12; mins = h * 60; } }
  }
  if (dayMs == null && mins == null) return null;
  if (dayMs == null) { dayMs = base; if (base + mins * 60000 <= nowMs) dayMs = base + DAY; }
  return done(dayMs + (mins == null ? 9 * 60 : mins) * 60000);
}

module.exports = { normalize, prepare, numberWordsToDigits, extractAmount, extractPhone, extractPeriod, extractDueDate, parseWhen, PERIOD_WORDS };
