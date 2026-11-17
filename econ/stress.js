/* Seconds: Monte Carlo stress test of the unit economics.
   Simulates one city zone (about 5 km across, like Indiranagar) for a day, minute by minute, thousands of times,
   under normal conditions and under shocks. Uses the same money rules as server.js.
   Usage: node econ/stress.js [runsPerScenario]   ->  econ/results.json, demo/econ.json, and the table in ECONOMICS.md
   No dependencies. Seeded, so the numbers are reproducible. */
'use strict';
const fs = require('fs'), path = require('path');
const RUNS = +process.argv[2] || 400;

/* ---------- random numbers ---------- */
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
let R = rng(1);
const U = (a, b) => a + (b - a) * R();
const N = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const logN = (median, sd) => median * Math.exp(sd * N());
function gamma(k) { if (k < 1) return gamma(k + 1) * Math.pow(R(), 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d); for (;;) { let x, v; do { x = N(); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
const beta = (a, b) => { const x = gamma(a); return x / (x + gamma(b)); };
const poisson = l => { if (l > 50) return Math.max(0, Math.round(l + Math.sqrt(l) * N())); let k = 0, p = 1; const L = Math.exp(-l); do { k++; p *= R(); } while (p > L); return k - 1; };
const pick = w => { let s = R() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < w.length; i++) if ((s -= w[i]) < 0) return i; return w.length - 1; };

/* ---------- the money rules (same as server.js) ---------- */
const BASE = {
  cut: 0.15, feeBase: 27, feePerKm: 8, feeMin: 35, payBase: 30, payPerKm: 7, batchAdd: 15, batchWindow: 10, batchMax: 4,
  hubFee: 3, hubKirana: 2, hubExtra: 480, hubCap: 240, hubShare: 0.4, pointValue: 0.007, creditCap: 0.5, creditSold: 3, creditFree: 6, bakerBonus: 2, kgPer: 0.4, dumpPerKg: 12,
  fixedPerDay: 1800,                               // one part-time ops person, support, servers, SMS, card/UPI ops, marketing (₹ per zone per day)
  // the rest of the revenue stack (set to 0 in the "marketplace only" scenario)
  platformFee: 4,                                  // ₹ per PAID order, paid by the buyer (food apps charge ₹6-15); free food never pays it
  csrPerMeal: 8,                                   // ₹ per free portion, from a company CSR budget (Companies Act Sch. VII: eradicating hunger); pilot assumption
  sellers: 60, planShare: 0.35, planPrice: 799,    // seller plan: receipts, FSSAI donation register, credits, insights; 35% of a zone's 60 sellers at ₹799/month
  demand: 350, listings: 45, wtp: 1, deliveryPref: 0.4, riderCost: 1, feeFloor: 1.1, dutch: true, batching: true, hubs: true, supplyNight: 1, noShow: 0.07
};
const feeOf = (P, km, pay) => Math.max(P.feeMin, Math.round(P.feeBase + P.feePerKm * km), P.feeFloor ? Math.ceil(pay * P.feeFloor) : 0);
const payOf = (P, km) => Math.round((P.payBase + P.payPerKm * km) * P.riderCost);
const trip = km => Math.round(km / 18 * 60) + 5;

/* ---------- one day in one zone ---------- */
const DAY = 1020;                                  // minutes from 10:00 to 03:00
function day(P) {
  const L = [], nList = poisson(P.listings);
  for (let i = 0; i < nList; i++) {
    const type = pick([0.55, 0.3, 0.15]);         // cooked, bakery, other
    let at, win;
    if (type === 0) { at = R() < 0.45 ? 270 + 40 * N() : 720 + 40 * N(); win = U(120, 180); }
    else if (type === 1) { at = 570 + 60 * N(); win = U(180, 300); }
    else { at = U(360, 720); win = 240; }
    let qty = Math.min(80, Math.max(2, Math.round(logN(10, 0.6))));
    if (type === 0 && at > 600) qty = Math.round(qty * P.supplyNight);
    const mrp = Math.max(20, Math.round(logN(70, 0.45) / 5) * 5);
    L.push({ type, at: Math.max(0, Math.min(DAY - 120, at)), end: 0, win, qty, left: qty, mrp, start: Math.round(mrp * 0.5 / 5) * 5 || 5, chilled: false, seller: i, credits: 0, fees: 0 });
  }
  L.forEach(x => { x.end = x.at + x.win; });
  const price = (x, t) => {                       // descending price, free in the last hour
    const freeAt = x.end - 60; if (t >= freeAt || freeAt <= x.at) return 0;
    if (!P.dutch) return x.start;
    const v = Math.round(x.start * (freeAt - t) / (freeAt - x.at) / 5) * 5; return v < 5 ? 0 : Math.min(x.start, v);
  };
  // buyers arrive through the day: lunch, evening and late-night peaks
  const shape = t => 0.35 * Math.exp(-(((t - 210) / 60) ** 2)) + 0.45 * Math.exp(-(((t - 630) / 75) ** 2)) + 0.2 * Math.exp(-(((t - 760) / 60) ** 2));
  let norm = 0; for (let t = 0; t < DAY; t++) norm += shape(t);
  const orders = [], runs = [];
  let hubUsed = 0;
  for (let t = 0; t < DAY; t++) {
    // chill hubs: halfway through a cooked listing's window, if more than 40% is unsold, the seller may move it to a kirana fridge
    if (P.hubs) for (const x of L) if (!x.chilled && x.type === 0 && x.left > 0 && t === Math.round(x.at + x.win / 2) && x.left / x.qty > 0.4 && hubUsed + x.left <= P.hubCap && R() < P.hubShare) {
      const cur = price(x, t); x.chilled = true; hubUsed += x.left; x.start = cur; x.at = t; x.end += P.hubExtra; x.win = x.end - t;
    }
    const n = poisson(P.demand * shape(t) / norm);
    for (let b = 0; b < n; b++) {
      const open = L.filter(x => x.at <= t && t < x.end && x.left > 0); if (!open.length) continue;
      const w = beta(2, 3) * P.wtp, wantsDelivery = R() < P.deliveryPref;
      let best = null;
      for (let k = 0; k < Math.min(8, open.length); k++) {
        const x = open[Math.floor(R() * open.length)], km = x.chilled ? U(0.3, 2) : U(0.3, 4), p = price(x, t);
        const qty = Math.min(x.left, 1 + pick([0.5, 0.35, 0.15]));
        const deliver = wantsDelivery && km >= 1;
        const fee = deliver ? feeOf(P, km, payOf(P, km)) : 0;
        if (!deliver && km > 2.5 && !x.chilled) continue;              // walking or riding over is too far
        const surplus = (w * x.mrp - p) * qty - fee;
        if (surplus >= 0 && (!best || surplus > best.surplus)) best = { x, km, p, qty, deliver, surplus };
      }
      if (!best) continue;
      const { x, km, p, qty, deliver } = best;
      if (!deliver && R() < P.noShow) continue;                       // no-show: the food goes back, nothing earned
      x.left -= qty;
      const food = p * qty, commission = Math.round(food * P.cut), hub = x.chilled ? qty : 0;
      let rider = 0, fee = 0, batched = false;
      if (deliver) {
        const pay = payOf(P, km); fee = feeOf(P, km, pay);
        const run = P.batching && runs.find(r => r.listing === x && t - r.t0 <= P.batchWindow && r.n < P.batchMax);
        if (run) { rider = Math.round(P.batchAdd * P.riderCost); run.n++; run.pay += rider; run.min += trip(km) - 3; batched = true; }
        else { rider = pay; runs.push({ listing: x, t0: t, n: 1, pay, min: U(5, 15) + 5 + trip(km) }); }
      }
      const kg = qty * P.kgPer, credits = Math.round(kg * ((food ? P.creditSold : P.creditFree) + (x.type === 1 ? P.bakerBonus : 0)));
      const fees = commission + hub * (P.hubFee - P.hubKirana);
      const creditsCost = Math.min(credits, (commission) * P.creditCap), pointsCost = food * P.pointValue;
      const extra = food ? P.platformFee : P.csrPerMeal * qty;
      const margin = commission + hub * (P.hubFee - P.hubKirana) + fee - rider - pointsCost - creditsCost + extra;
      x.credits += credits; x.fees += fees;
      orders.push({ extra, pointsCost, creditsCost, hubNet: hub * (P.hubFee - P.hubKirana), food, commission, fee, rider, hub, margin, batched, deliver, saved: (x.mrp - p) * qty, kg, sellerNet: food - commission - hub * P.hubFee, dump: kg * P.dumpPerKg, free: !food });
    }
  }
  const listed = L.reduce((a, x) => a + x.qty, 0), sold = L.reduce((a, x) => a + x.qty - x.left, 0);
  const contribution = orders.reduce((a, o) => a + o.margin, 0), riderMin = runs.reduce((a, r) => a + r.min, 0), riderPay = runs.reduce((a, r) => a + r.pay, 0);
  const deliveries = orders.filter(o => o.deliver);
  return {
    orders: orders.length, gmv: orders.reduce((a, o) => a + o.food, 0), contribution, ebitda: contribution + P.sellers * P.planShare * P.planPrice / 30 - P.fixedPerDay,
    perOrder: orders.length ? contribution / orders.length : 0, minOrder: orders.length ? Math.min(...orders.map(o => o.margin)) : 0, loss: orders.filter(o => o.margin < -1e-9).length,
    waste: listed ? 1 - sold / listed : 0, deliveries: deliveries.length, batched: deliveries.filter(o => o.batched).length, riderHour: riderMin ? riderPay / riderMin * 60 : 0,
    sellerUplift: L.length ? orders.reduce((a, o) => a + o.sellerNet + o.dump, 0) / L.length : 0, buyerSaved: orders.length ? orders.reduce((a, o) => a + o.saved, 0) / orders.length : 0,
    lines: { commission: orders.reduce((a, o) => a + o.commission, 0), deliveryNet: orders.reduce((a, o) => a + o.fee - o.rider, 0), hubs: orders.reduce((a, o) => a + o.hubNet, 0),
      platformFee: orders.reduce((a, o) => a + (o.food ? o.extra : 0), 0), csr: orders.reduce((a, o) => a + (o.food ? 0 : o.extra), 0), plan: P.sellers * P.planShare * P.planPrice / 30,
      points: -orders.reduce((a, o) => a + o.pointsCost, 0), credits: -orders.reduce((a, o) => a + o.creditsCost, 0), fixed: -P.fixedPerDay },
    kg: orders.reduce((a, o) => a + o.kg, 0), freeShare: orders.length ? orders.filter(o => o.free).length / orders.length : 0
  };
}

/* ---------- scenarios ---------- */
const SCEN = [
  ['Base case', {}],
  ['Marketplace only (no fee, CSR or plan)', { platformFee: 0, csrPerMeal: 0, planShare: 0 }],
  ['Old rider pay (₹20 + ₹6/km, ₹29 fee)', { feeBase: 22, feePerKm: 7, feeMin: 29, payBase: 20, payPerKm: 6, batchAdd: 10 }],
  ['Demand halves', { demand: 175 }],
  ['Demand +50%', { demand: 525 }],
  ['Rain: deliveries ×1.8, rider pay ×1.3', { deliveryPref: 0.72, riderCost: 1.3 }],
  ['Rain without the fee floor', { deliveryPref: 0.72, riderCost: 1.3, feeFloor: 0 }],
  ['Event night: 2.5× late cooked surplus', { supplyNight: 2.5, demand: 420 }],
  ['Buyers 30% stingier', { wtp: 0.7 }],
  ['No batching', { batching: false }],
  ['No chill hubs', { hubs: false }],
  ['Flat 50% off (no falling price)', { dutch: false }],
  ['Take rate 10%', { cut: 0.10 }],
  ['Credits doubled', { creditSold: 6, creditFree: 12, bakerBonus: 4 }],
  ['Worst case: half demand, stingy, rain', { demand: 175, wtp: 0.7, deliveryPref: 0.72, riderCost: 1.3 }]
];
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const out = [];
SCEN.forEach(([name, over], si) => {
  R = rng(1000 + si);                                         // same seed per scenario: differences come from the rules
  const P = Object.assign({}, BASE, over), days = [];
  for (let i = 0; i < RUNS; i++) days.push(day(P));
  const col = k => days.map(d => d[k]), totalOrders = col('orders').reduce((a, b) => a + b, 0), loss = col('loss').reduce((a, b) => a + b, 0);
  const lines = {}; Object.keys(days[0].lines).forEach(k => { lines[k] = Math.round(mean(days.map(d => d.lines[k]))); });
  out.push({ name, lines, runs: RUNS, orders: Math.round(mean(col('orders'))), gmv: Math.round(mean(col('gmv'))), contribution: Math.round(mean(col('contribution'))), contributionP5: Math.round(q(col('contribution'), 0.05)),
    ebitda: Math.round(mean(col('ebitda'))), ebitdaP5: Math.round(q(col('ebitda'), 0.05)), profitableDays: Math.round(days.filter(d => d.ebitda > 0).length / RUNS * 100),
    perOrder: +mean(col('perOrder')).toFixed(2), worstOrder: +Math.min(...col('minOrder')).toFixed(2), lossOrdersPct: +(loss / Math.max(1, totalOrders) * 100).toFixed(2),
    waste: Math.round(mean(col('waste')) * 100), batchedPct: Math.round(col('batched').reduce((a, b) => a + b, 0) / Math.max(1, col('deliveries').reduce((a, b) => a + b, 0)) * 100),
    riderHour: Math.round(mean(col('riderHour').filter(Boolean))), sellerUplift: Math.round(mean(col('sellerUplift'))), buyerSaved: Math.round(mean(col('buyerSaved'))), kg: Math.round(mean(col('kg'))), freeShare: Math.round(mean(col('freeShare')) * 100) });
});

const result = { generated: new Date().toISOString(), runsPerScenario: RUNS, rules: BASE, scenarios: out };
fs.mkdirSync(path.join(__dirname), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(result, null, 1));
fs.writeFileSync(path.join(__dirname, '..', 'public', 'econ.json'), JSON.stringify(result));
const inr = n => (n < 0 ? '−₹' : '₹') + Math.abs(n).toLocaleString('en-IN');
const table = ['| Scenario | Orders/day | GMV/day | Contribution/day (mean · worst 5%) | After fixed costs (mean · worst 5%) | Profitable days | Margin/order (mean · worst) | Loss-making orders | Waste | Batched deliveries | Rider ₹/h |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...out.map(s => `| ${s.name} | ${s.orders} | ${inr(s.gmv)} | ${inr(s.contribution)} · ${inr(s.contributionP5)} | ${inr(s.ebitda)} · ${inr(s.ebitdaP5)} | ${s.profitableDays}% | ₹${s.perOrder} · ₹${s.worstOrder} | ${s.lossOrdersPct}% | ${s.waste}% | ${s.batchedPct}% | ${inr(s.riderHour)} |`)].join('\n');
const doc = path.join(__dirname, '..', 'ECONOMICS.md');
if (fs.existsSync(doc)) {
  const s = fs.readFileSync(doc, 'utf8'), a = s.indexOf('<!-- results -->'), b = s.indexOf('<!-- /results -->');
  if (a >= 0 && b > a) fs.writeFileSync(doc, s.slice(0, a + 16) + '\n\n' + `${RUNS} simulated days per scenario, seeded. Generated by \`node econ/stress.js\`.\n\n` + table + '\n\n' + s.slice(b));
}
console.log(table);
