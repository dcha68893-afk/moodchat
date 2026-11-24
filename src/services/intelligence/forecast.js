'use strict';
/**
 * NECPRA Intelligence: DUKA forecasting + anomaly maths. Pure functions, no database, no dependencies, deterministic.
 *
 * HONESTY RULES (brief section 5): every result carries a `confidence` label derived from how much real history exists, and when
 * there is too little history the functions return `forecast: null` with a reason instead of inventing a number.
 *   insufficient  < 14 days of history or < 5 days with sales   -> no forecast
 *   preliminary   >= 14 days and >= 5 sale-days                 -> shown, labelled "early estimate"
 *   moderate      >= 28 days and >= 12 sale-days
 *   good          >= 60 days and >= 30 sale-days
 * Method: trailing-mean level (last 28 days) x shrunk weekday factors; intervals from in-sample residual spread (about 80%).
 */

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const toMs = (d) => Date.parse(String(d).slice(0, 10) + 'T00:00:00Z');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => (a.length ? sum(a) / a.length : 0);
const sd = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map((x) => (x - m) * (x - m))) / (a.length - 1)); };
const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y), h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const round = (n, d = 2) => { const f = Math.pow(10, d); return Math.round(n * f) / f; };

/** rows: [{date:'YYYY-MM-DD', value:Number}] (duplicates summed) -> zero-filled daily array [{date, value}] from `from` to `to` inclusive. */
function dailySeries(rows, from, to) {
  const by = new Map();
  for (const r of rows || []) { const k = String(r.date).slice(0, 10); by.set(k, (by.get(k) || 0) + (Number(r.value) || 0)); }
  const start = toMs(from), end = toMs(to), out = [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return out;
  for (let t = start; t <= end; t += DAY) { const k = iso(t); out.push({ date: k, value: by.get(k) || 0 }); }
  return out;
}

function confidenceFor(series) {
  const days = series.length, saleDays = series.filter((p) => p.value > 0).length;
  if (days >= 60 && saleDays >= 30) return 'good';
  if (days >= 28 && saleDays >= 12) return 'moderate';
  if (days >= 14 && saleDays >= 5) return 'preliminary';
  return 'insufficient';
}

/** Weekday factors (0=Sun..6=Sat), shrunk toward 1 so a few odd days cannot dominate, then renormalised to average exactly 1. Only used with >= 21 days. */
function weekdayFactors(series) {
  const f = [1, 1, 1, 1, 1, 1, 1];
  if (series.length < 21) return f;
  const overall = mean(series.map((p) => p.value));
  if (overall <= 0) return f;
  const buckets = [[], [], [], [], [], [], []];
  for (const p of series) buckets[new Date(toMs(p.date)).getUTCDay()].push(p.value);
  for (let w = 0; w < 7; w++) { const n = buckets[w].length; if (!n) continue; const raw = mean(buckets[w]) / overall; const k = n / (n + 2); f[w] = 1 + k * (raw - 1); }
  const m = mean(f);
  return m > 0 ? f.map((x) => x / m) : f;
}

/**
 * Forecast the next `horizonDays` days from a zero-filled daily series.
 * @returns {{confidence:string, forecast:null|{perDay:Array<{date,expected}>, total:number, low:number, high:number, avgDaily:number}, reason?:string, basis:{days:number, saleDays:number}}}
 */
function forecastSeries(series, horizonDays = 7) {
  const basis = { days: series.length, saleDays: series.filter((p) => p.value > 0).length };
  const confidence = confidenceFor(series);
  if (confidence === 'insufficient') return { confidence, forecast: null, reason: 'Not enough sales history yet (need at least 14 days with sales on 5 of them).', basis };
  const factors = weekdayFactors(series);
  const wd = (d) => new Date(toMs(d)).getUTCDay();
  // Level = mean of the most recent WHOLE weeks (up to 4). A whole number of weeks contains every weekday equally often,
  // so the level is not biased by which weekdays happen to fall in the window.
  const weeks = Math.max(1, Math.min(4, Math.floor(series.length / 7)));
  const level = mean(series.slice(-weeks * 7).map((p) => p.value));
  const resid = series.slice(-weeks * 7).map((p) => p.value - level * factors[wd(p.date)]);
  const sigma = sd(resid);
  const last = toMs(series[series.length - 1].date);
  const perDay = [];
  for (let h = 1; h <= horizonDays; h++) { const d = iso(last + h * DAY); perDay.push({ date: d, expected: round(Math.max(0, level * factors[wd(d)])) }); }
  const total = sum(perDay.map((x) => x.expected));
  const spread = 1.28 * sigma * Math.sqrt(horizonDays);
  return { confidence, forecast: { perDay, total: round(total), low: round(Math.max(0, total - spread)), high: round(total + spread), avgDaily: round(total / horizonDays) }, basis };
}

/** Days of stock left at the forecast rate. null when demand is unknown or zero. */
function daysOfStock(stock, avgDaily) {
  if (!(avgDaily > 0)) return null;
  return round(Math.max(0, Number(stock) || 0) / avgDaily, 1);
}

/**
 * Reorder quantity covering (leadTime + coverDays) of demand plus a safety buffer, minus what is on hand.
 * @param {{stock:number, avgDaily:number, sigmaDaily?:number, leadTimeDays?:number, coverDays?:number, serviceZ?:number}} p
 */
function reorderQuantity(p) {
  const lead = p.leadTimeDays != null ? p.leadTimeDays : 2, cover = p.coverDays != null ? p.coverDays : 7, z = p.serviceZ != null ? p.serviceZ : 1.28;
  const avg = Number(p.avgDaily) || 0, sigma = Number(p.sigmaDaily) || 0, stock = Math.max(0, Number(p.stock) || 0);
  if (avg <= 0) return { qty: 0, reason: 'no_recent_demand' };
  const horizon = lead + cover;
  const need = avg * horizon + z * sigma * Math.sqrt(horizon);
  const qty = Math.max(0, Math.ceil(need - stock));
  return { qty, targetStock: round(need), daysOfStock: daysOfStock(stock, avg), reason: qty > 0 ? 'below_target' : 'sufficient' };
}

/**
 * Products that sell slowly relative to what is on the shelf.
 * @param {Array<{id,name,stock,soldQtyWindow:number,lastSoldDaysAgo:number|null,unitCost:number}>} products
 * @param {{windowDays?:number, coverDaysThreshold?:number}} opts
 */
function slowMovers(products, opts = {}) {
  const windowDays = opts.windowDays || 30, threshold = opts.coverDaysThreshold || 60;
  const out = [];
  for (const p of products || []) {
    const stock = Number(p.stock) || 0; if (stock <= 0) continue;
    const daily = (Number(p.soldQtyWindow) || 0) / windowDays;
    const cover = daily > 0 ? stock / daily : Infinity;
    const stale = p.lastSoldDaysAgo == null || p.lastSoldDaysAgo > windowDays;
    if (cover >= threshold || stale) out.push({ id: p.id, name: p.name, stock, soldQtyWindow: Number(p.soldQtyWindow) || 0, daysOfCover: Number.isFinite(cover) ? round(cover, 0) : null, lastSoldDaysAgo: p.lastSoldDaysAgo == null ? null : p.lastSoldDaysAgo, tiedUpCapital: round(stock * (Number(p.unitCost) || 0)) });
  }
  return out.sort((a, b) => b.tiedUpCapital - a.tiedUpCapital);
}

/**
 * Robust outlier detection (median / MAD), so one huge day does not hide itself by inflating the average.
 * @param {Array<{date,value}>} series  @param {{threshold?:number, minPoints?:number}} opts
 * @returns {Array<{date,value,expected,score,direction:'high'|'low'}>}
 */
function detectAnomalies(series, opts = {}) {
  const th = opts.threshold || 3.5, minPoints = opts.minPoints || 14;
  const vals = series.map((p) => p.value);
  if (vals.length < minPoints) return [];
  const wd = (d) => new Date(toMs(d)).getUTCDay();
  // With 4+ weeks, compare each day with the usual for ITS weekday (a shop closed on Sundays must not alert every Sunday).
  const useWeekday = series.length >= 28;
  const expectedFor = (i) => {
    if (!useWeekday) return median(vals);
    const same = []; for (let j = 0; j < series.length; j++) if (j !== i && wd(series[j].date) === wd(series[i].date)) same.push(vals[j]);
    return same.length >= 3 ? median(same) : median(vals);
  };
  const exp = series.map((_, i) => expectedFor(i));
  const resid = vals.map((v, i) => v - exp[i]);
  const mad = median(resid.map((r) => Math.abs(r - median(resid))));
  // floor the scale so a very regular shop is not flagged for tiny wobbles (at least 10% of a typical day, and at least 1 unit)
  const scale = Math.max(1.4826 * mad, 0.1 * Math.abs(median(vals)), 1);
  const out = [];
  for (let i = 0; i < series.length; i++) { const score = (resid[i] - median(resid)) / scale; if (Math.abs(score) >= th) out.push({ date: series[i].date, value: series[i].value, expected: round(exp[i]), score: round(score, 1), direction: score > 0 ? 'high' : 'low' }); }
  return out;
}

/** Compare two equal-length windows; returns the change and a plain-language direction. Pure arithmetic, no causes invented. */
function compareWindows(current, previous) {
  const c = sum(current), p = sum(previous);
  const change = c - p, pct = p > 0 ? (change / p) * 100 : null;
  return { current: round(c), previous: round(p), change: round(change), pct: pct == null ? null : round(pct, 1), direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat' };
}

module.exports = { dailySeries, confidenceFor, weekdayFactors, forecastSeries, daysOfStock, reorderQuantity, slowMovers, detectAnomalies, compareWindows, mean, sd, median, round };
