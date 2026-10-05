// Builds board.json: actuals from FRED, consensus + calendar from the ForexFactory weekly feed,
// manual.json for series without a free API. Node 20+. Requires FRED_API_KEY.
import fs from 'node:fs/promises';

const KEY = (process.env.FRED_API_KEY || '').trim().replace(/^api_key=/i, '').replace(/^["']|["']$/g, '');
const OUT = process.env.BOARD_OUT || 'board.json';
const MANUAL = process.env.BOARD_MANUAL || 'manual.json';
if (!KEY) { console.error('FRED_API_KEY is not set'); process.exit(1); }
if (!/^[a-z0-9]{32}$/.test(KEY)) console.warn(`FRED_API_KEY looks malformed (length ${KEY.length}; expected 32 lowercase letters/digits).`);

// units: lin = level, pch = % change, pc1 = % change YoY, chg = change. scale converts to board units.
const SERIES = [
  { id: 'gdp',    series: 'A191RL1Q225SBEA', units: 'lin', src: 'BEA',            ff: /^(Advance |Prelim |Final )?GDP q\/q/i },
  { id: 'retail', series: 'RSAFS',           units: 'pch', src: 'Census Bureau',  ff: /^Retail Sales m\/m/i },
  { id: 'cpi',    series: 'CPIAUCNS',        units: 'pc1', src: 'BLS',            ff: /^CPI y\/y/i },
  { id: 'ppi',    series: 'PPIFIS',          units: 'pc1', src: 'BLS',            ff: /^(Final Demand )?PPI y\/y/i },
  { id: 'pce',    series: 'PCEPI',           units: 'pc1', src: 'BEA',            ff: /^(Headline )?PCE Price Index y\/y/i },
  { id: 'nfp',    series: 'PAYEMS',          units: 'chg', src: 'BLS',            ff: /^Non-?Farm (Employment Change|Payrolls)/i },
  { id: 'unemp',  series: 'UNRATE',          units: 'lin', src: 'BLS',            ff: /^Unemployment Rate/i },
  { id: 'claims', series: 'ICSA',            units: 'lin', src: 'Dept. of Labor', ff: /^(Unemployment|Initial Jobless) Claims/i, scale: 0.001 },
  { id: 'adp',    series: 'ADPMNUSNERSA',    units: 'chg', src: 'ADP',            ff: /^ADP Non-?Farm Employment Change/i, scale: 0.001 },
  { id: 'jolts',  series: 'JTSJOL',          units: 'lin', src: 'BLS',            ff: /^JOLTS Job Openings/i, scale: 0.001 },
];
const FF_ONLY = [
  { id: 'mpmi', src: 'ISM',              ff: /^ISM Manufacturing PMI/i },
  { id: 'spmi', src: 'ISM',              ff: /^ISM (Services|Non-Manufacturing) PMI/i },
  { id: 'conf', src: 'Conference Board', ff: /^CB Consumer Confidence/i },
];
const SECTION = [[/GDP|PMI|Retail|Confidence|Sentiment|Trade|Durable|Housing|Industrial/i, 'Growth'],
  [/CPI|PPI|PCE|Inflation|Price/i, 'Inflation'], [/Employment|Unemployment|Claims|JOLTS|Payroll|Earnings/i, 'Jobs'],
  [/FOMC|Fed|Rate/i, 'Rates']];

const now = new Date();
const fmtDay = d => new Date(d).toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'America/New_York' });
const fmtTime = d => new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' });
const num = s => { if (s == null || s === '') return null; const n = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; };
const round = (n, dp = 3) => +n.toFixed(dp);
const readJson = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')); } catch { return d; } };

async function fred(path, params) {
  const q = new URLSearchParams({ ...params, api_key: KEY, file_type: 'json' });
  const r = await fetch(`https://api.stlouisfed.org/fred/${path}?${q}`);
  if (!r.ok) {
    let msg = '';
    try { msg = (await r.json()).error_message || ''; } catch {}
    throw new Error(`FRED ${path} ${params.series_id}: ${r.status}${msg ? ' — ' + msg : ''}`);
  }
  return r.json();
}

// Exact date of the most recent release for a series (FRED release calendar).
async function releaseDate(seriesId) {
  const rel = await fred('series/release', { series_id: seriesId });
  const id = rel.releases?.[0]?.id;
  if (!id) return null;
  const d = await fred('release/dates', { release_id: id, sort_order: 'desc', limit: 10 });
  const today = now.toISOString().slice(0, 10);
  return d.release_dates.find(x => x.date <= today)?.date ?? null;
}

async function ffWeek(which) {
  try {
    const r = await fetch(`https://nfs.faireconomy.media/ff_calendar_${which}.json`, { headers: { 'User-Agent': 'macro-board/1.0' } });
    if (!r.ok) return [];
    return (await r.json()).filter(e => e.country === 'USD');
  } catch { return []; }
}

const prev = await readJson(OUT, { indicators: {} });
const manual = await readJson(MANUAL, {});
const events = [...await ffWeek('thisweek'), ...await ffWeek('nextweek')];
const indicators = {};

function withForecast(id, re, base) {
  const cur = prev.indicators?.[id] || {};
  let forecast = cur.forecast ?? null, pending = cur.pending ?? null;
  const ev = events.filter(e => re.test(e.title)).sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  const f = ev ? num(ev.forecast) : null;
  if (f != null) {
    if (new Date(ev.date) > now) pending = { forecast: f, eventDate: ev.date };
    else { forecast = f; pending = null; }
  }
  if (pending && new Date(pending.eventDate) <= now) { forecast = pending.forecast; pending = null; }
  return { ...cur, ...base, forecast, pending };
}

for (const s of SERIES) {
  try {
    const [obs, released] = await Promise.all([
      fred('series/observations', { series_id: s.series, units: s.units, sort_order: 'desc', limit: 3 }),
      releaseDate(s.series),
    ]);
    const o = obs.observations.find(x => x.value !== '.');
    const actual = round(parseFloat(o.value) * (s.scale ?? 1));
    indicators[s.id] = withForecast(s.id, s.ff, { actual, date: released ? fmtDay(released + 'T12:00:00Z') : prev.indicators?.[s.id]?.date, src: s.src, period: o.date });
  } catch (e) {
    console.warn(e.message);
    if (prev.indicators?.[s.id]) indicators[s.id] = prev.indicators[s.id];
  }
}
for (const s of FF_ONLY) indicators[s.id] = withForecast(s.id, s.ff, { src: s.src });

// 2Y Treasury yield vs its 21-day average (the "forecast" column for this row).
try {
  const obs = await fred('series/observations', { series_id: 'DGS2', sort_order: 'desc', limit: 40 });
  const vals = obs.observations.filter(x => x.value !== '.');
  const sma = vals.slice(0, 21).reduce((t, x) => t + parseFloat(x.value), 0) / Math.min(21, vals.length);
  indicators.y2 = { actual: round(parseFloat(vals[0].value), 2), forecast: round(sma, 2), date: fmtDay(vals[0].date + 'T12:00:00Z'), src: 'Treasury · vs 21-day avg' };
} catch (e) {
  console.warn(e.message);
  if (prev.indicators?.y2) indicators.y2 = prev.indicators.y2;
}

// Risk sentiment: daily FRED gauges, each scored +1 risk-on / −1 risk-off / 0 flat vs its 20-day average.
async function daily(id, limit = 45) {
  const o = await fred('series/observations', { series_id: id, sort_order: 'desc', limit });
  return o.observations.filter(x => x.value !== '.').map(x => ({ date: x.date, v: parseFloat(x.value) }));
}
const avg = a => a.reduce((t, x) => t + x, 0) / a.length;
const vsAvg = (rows, higherIsOn, band = 0.01) => {
  const last = rows[0].v, ref = avg(rows.slice(0, 20).map(r => r.v));
  const d = last / ref - 1;
  return { last, ref, signal: Math.abs(d) < band ? 0 : (d > 0) === higherIsOn ? 1 : -1, date: rows[0].date };
};
let risk = prev.risk || null;
try {
  const [vix, hy, sp, curve] = await Promise.all(['VIXCLS', 'BAMLH0A0HYM2', 'SP500', 'T10Y2Y'].map(id => daily(id)));
  // AUD/JPY daily from Frankfurter (ECB reference rates, ~16:00 CET each business day, no key).
  const start = new Date(now - 60 * 864e5).toISOString().slice(0, 10);
  const fx = await (await fetch(`https://api.frankfurter.dev/v1/${start}..?base=AUD&symbols=JPY`)).json();
  const audjpy = Object.entries(fx.rates).map(([date, r]) => ({ date, v: r.JPY })).sort((a, b) => b.date.localeCompare(a.date));
  const g = [];
  const v = vsAvg(vix, false, 0.03); if (v.last >= 25) v.signal = -1;
  g.push({ id: 'vix', name: 'VIX', note: 'Equity volatility', value: v.last.toFixed(1), ref: v.ref.toFixed(1), signal: v.signal, weight: 1 });
  const h = vsAvg(hy, false, 0.015);
  g.push({ id: 'hy', name: 'High-yield spread', note: 'Credit stress', value: h.last.toFixed(2) + '%', ref: h.ref.toFixed(2) + '%', signal: h.signal, weight: 1 });
  const s = vsAvg(sp, true, 0.005);
  g.push({ id: 'spx', name: 'S&P 500', note: 'Equities', value: Math.round(s.last).toLocaleString('en-US'), ref: Math.round(s.ref).toLocaleString('en-US'), signal: s.signal, weight: 1 });
  const a = vsAvg(audjpy, true, 0.005);
  g.push({ id: 'audjpy', name: 'AUD/JPY', note: 'FX risk barometer', value: a.last.toFixed(2), ref: a.ref.toFixed(2), signal: a.signal, weight: 1 });
  const cNow = curve[0].v, c20 = curve[Math.min(20, curve.length - 1)].v, cd = cNow - c20;
  g.push({ id: 'curve', name: '10y–2y curve', note: 'Change over 20 days', value: cNow.toFixed(2) + '%', ref: c20.toFixed(2) + '%', signal: Math.abs(cd) < 0.05 ? 0 : cd > 0 ? 1 : -1, weight: 0.5 });
  const score = round(g.reduce((t, x) => t + x.signal * x.weight, 0) / g.reduce((t, x) => t + x.weight, 0), 2);
  risk = { score, label: score > 0.3 ? 'Risk-on' : score < -0.3 ? 'Risk-off' : 'Mixed', asOf: fmtDay(vix[0].date + 'T12:00:00Z'), gauges: g };
} catch (e) { console.warn('Risk gauges:', e.message); }

// COT positioning: CFTC Legacy futures-only report, non-commercial (large speculator) net positions.
const COT_CODES = { '099741': 'EUR', '096742': 'GBP', '097741': 'JPY', '092741': 'CHF', '090741': 'CAD', '232741': 'AUD', '112741': 'NZD', '098662': 'USD' };
let cot = prev.cot || null;
try {
  const since = new Date(now - 3 * 365 * 864e5).toISOString().slice(0, 10);
  const where = `cftc_contract_market_code in(${Object.keys(COT_CODES).map(c => `'${c}'`).join(',')}) AND report_date_as_yyyy_mm_dd >= '${since}'`;
  const q = new URLSearchParams({ $where: where, $select: 'cftc_contract_market_code,report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all', $order: 'report_date_as_yyyy_mm_dd DESC', $limit: '5000' });
  const rows = await (await fetch(`https://publicreporting.cftc.gov/resource/6dca-aqww.json?${q}`)).json();
  const by = {};
  for (const r of rows) {
    const ccy = COT_CODES[r.cftc_contract_market_code];
    (by[ccy] ||= []).push({ date: r.report_date_as_yyyy_mm_dd.slice(0, 10), net: +r.noncomm_positions_long_all - +r.noncomm_positions_short_all });
  }
  const ccys = Object.values(COT_CODES).filter(c => by[c]?.length).map(ccy => {
    const h = by[ccy];
    const net = h[0].net, chg = h[1] ? net - h[1].net : 0;
    const pct = Math.round((h.filter(x => x.net <= net).length / h.length) * 100);
    return { ccy, net, chg, pct };
  });
  if (ccys.length) cot = { asOf: fmtDay(by[ccys[0].ccy][0].date + 'T12:00:00Z'), ccys };
} catch (e) { console.warn('COT:', e.message); }

// High-impact USD events no row picked up — check these to tune the ff regexes.
const allRe = [...SERIES, ...FF_ONLY].map(s => s.ff);
const unmatched = [...new Set(events.filter(e => e.impact === 'High' && !allRe.some(re => re.test(e.title))).map(e => e.title))];
if (unmatched.length) console.log('Unmatched high-impact events:', unmatched.join(' | '));
const missingForecast = Object.entries(indicators).filter(([, v]) => v.forecast == null).map(([k]) => k);
if (missingForecast.length) console.log('Rows without a forecast (set in manual.json):', missingForecast.join(', '));

for (const [id, o] of Object.entries(manual)) if (!id.startsWith('_')) indicators[id] = { ...indicators[id], ...o };

const upcoming = events
  .filter(e => new Date(e.date) > now && (e.impact === 'High' || e.impact === 'Medium'))
  .sort((a, b) => new Date(a.date) - new Date(b.date))
  .slice(0, 8)
  .map(e => ({
    date: fmtDay(e.date), time: fmtTime(e.date), name: e.title,
    section: (SECTION.find(([re]) => re.test(e.title)) || [, 'Other'])[1],
    forecast: e.forecast || '—', previous: e.previous || '—',
  }));

const board = { updatedAt: now.toISOString(), indicators, upcoming: upcoming.length ? upcoming : prev.upcoming || [], risk, cot, unmatched, missingForecast };
await fs.writeFile(OUT, JSON.stringify(board, null, 2) + '\n');
console.log(`Wrote ${OUT}: ${Object.keys(indicators).length} indicators, ${board.upcoming.length} upcoming`);
