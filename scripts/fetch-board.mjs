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
const vsAvg = (rows, higherIsOn, band, n) => {
  const last = rows[0].v, ref = avg(rows.slice(0, n).map(r => r.v));
  const d = last / ref - 1;
  return { last, ref, signal: Math.abs(d) < band ? 0 : (d > 0) === higherIsOn ? 1 : -1 };
};
let risk = prev.risk || null;
try {
  const [vix, hy, sp, curve] = await Promise.all(['VIXCLS', 'BAMLH0A0HYM2', 'SP500', 'T10Y2Y'].map(id => daily(id)));
  // AUD/JPY daily from Frankfurter (ECB reference rates, ~16:00 CET each business day, no key).
  const start = new Date(now - 60 * 864e5).toISOString().slice(0, 10);
  const fx = await (await fetch(`https://api.frankfurter.dev/v1/${start}..?base=AUD&symbols=JPY`)).json();
  const audjpy = Object.entries(fx.rates).map(([date, r]) => ({ date, v: r.JPY })).sort((a, b) => b.date.localeCompare(a.date));
  // Each gauge scored twice: fast = vs 5-day average, slow = vs 20-day average.
  const mk = (id, name, note, rows, higherIsOn, band, fmt) => {
    const f = vsAvg(rows, higherIsOn, band, 5), s = vsAvg(rows, higherIsOn, band, 20);
    return { id, name, note, value: fmt(f.last), ref5: fmt(f.ref), ref20: fmt(s.ref), signalFast: f.signal, signalSlow: s.signal, weight: 1 };
  };
  const g = [
    mk('vix', 'VIX', 'Equity volatility', vix, false, 0.03, x => x.toFixed(1)),
    mk('hy', 'High-yield spread', 'Credit stress', hy, false, 0.015, x => x.toFixed(2) + '%'),
    mk('spx', 'S&P 500', 'Equities', sp, true, 0.005, x => Math.round(x).toLocaleString('en-US')),
    mk('audjpy', 'AUD/JPY', 'FX risk barometer', audjpy, true, 0.005, x => x.toFixed(2)),
  ];
  if (vix[0].v >= 25) { g[0].signalFast = -1; g[0].signalSlow = -1; }
  const back = n => curve[Math.min(n, curve.length - 1)].v;
  const cs = (d, band) => Math.abs(d) < band ? 0 : d > 0 ? 1 : -1;
  g.push({ id: 'curve', name: '10y–2y curve', note: 'Steepening = risk-on', value: curve[0].v.toFixed(2) + '%', ref5: back(5).toFixed(2) + '%', ref20: back(20).toFixed(2) + '%',
    signalFast: cs(curve[0].v - back(5), 0.03), signalSlow: cs(curve[0].v - back(20), 0.05), weight: 0.5 });
  const sc = k => round(g.reduce((t, x) => t + x[k] * x.weight, 0) / g.reduce((t, x) => t + x.weight, 0), 2);
  const lab = s => s > 0.3 ? 'Risk-on' : s < -0.3 ? 'Risk-off' : 'Mixed';
  const fast = sc('signalFast'), slow = sc('signalSlow');
  risk = { fast: { score: fast, label: lab(fast) }, slow: { score: slow, label: lab(slow) }, score: slow, label: lab(slow), asOf: fmtDay(vix[0].date + 'T12:00:00Z'), gauges: g };
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

// DXY rebuilt from ICE's formula using ECB rates (Frankfurter), with a 20-day EMA trend.
let dxy = prev.dxy || null;
try {
  const start = new Date(now - 120 * 864e5).toISOString().slice(0, 10);
  const fx = await (await fetch(`https://api.frankfurter.dev/v1/${start}..?base=USD&symbols=EUR,JPY,GBP,CAD,SEK,CHF`)).json();
  const series = Object.entries(fx.rates).sort(([a], [b]) => a.localeCompare(b)).map(([date, r]) => ({
    date,
    v: 50.14348112 * r.EUR ** 0.576 * r.JPY ** 0.136 * r.GBP ** 0.119 * r.CAD ** 0.091 * r.SEK ** 0.042 * r.CHF ** 0.036,
  }));
  const k = 2 / 21, emas = [];
  series.forEach((p, i) => emas.push(i === 0 ? p.v : p.v * k + emas[i - 1] * (1 - k)));
  const n = series.length - 1, value = series[n].v, ema = emas[n], emaPrev = emas[Math.max(0, n - 5)];
  const trend = value > ema && ema > emaPrev ? 1 : value < ema && ema < emaPrev ? -1 : 0;
  dxy = { value: round(value, 3), ema: round(ema, 3), emaPrev: round(emaPrev, 3), trend, asOf: fmtDay(series[n].date + 'T12:00:00Z') };
} catch (e) { console.warn('DXY:', e.message); }

const board = { updatedAt: now.toISOString(), indicators, upcoming: upcoming.length ? upcoming : prev.upcoming || [], risk, cot, dxy, unmatched, missingForecast };
await fs.writeFile(OUT, JSON.stringify(board, null, 2) + '\n');
console.log(`Wrote ${OUT}: ${Object.keys(indicators).length} indicators, ${board.upcoming.length} upcoming`);
