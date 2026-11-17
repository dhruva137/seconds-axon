/* Seconds server: a live market for surplus food, priced by the clock.
   Sellers list surplus with 2-3 photos; the price falls in ₹5 steps along the food's safety clock and is free in the
   last hour. Buyers order for pickup (one-time code) or delivery (nearest free rider, batched runs). Kirana chill hubs
   extend the clock. Every order carries its own P&L, and every action is sealed into a SHA-256 hash chain.
   One process, one port, Node.js standard library only. Run: node server.js, then open http://localhost:4173
   Env: PORT (4173), HOST (127.0.0.1), SECONDS_DEMO=0 to switch off sample data and one-tap demo sign-in. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 4173, HOST = process.env.HOST || '127.0.0.1';
// Each port keeps its own session cookie (browsers share cookies across ports on the same host).
const DEMO = (process.env.SECONDS_DEMO || process.env.TMINUS_DEMO) !== '0';
const PUBLIC = path.join(__dirname, 'public'), DATA = process.env.SECONDS_DATA || process.env.TMINUS_DATA || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA, 'db.json'), SEED_FILE = path.join(DATA, 'seed.json');
const SESSION_MS = 12 * 3600e3, MIN = 60e3, HOUR = 3600e3;
// Safe minutes from the moment food is ready. Cooked food follows the strict end of FSSAI's 4-6 h room-temperature window, tightened for rice.
const FOODS = {
  meal: { label: 'Cooked meals', min: 150, cooked: true },
  snack: { label: 'Snacks', min: 240, cooked: true },
  sweets: { label: 'Sweets', min: 480 },
  bakery: { label: 'Bread and bakes', min: 720 },
  packed: { label: 'Sealed packets', min: 1080 },
  fruit: { label: 'Fruit and veg', min: 1440 }
};
const DIETS = ['veg', 'egg', 'nonveg'];
const MARGIN_MIN = 10, NEAR_KM = 15, MAX_HOLDS = 2, STRIKES_OUT = 3, KG_PER_MEAL = 0.4;
// The money. Businesses may sell surplus cheap first; the price falls with the food clock and is zero in the last hour,
// when whatever is left goes free to spots. Pickups to spots are paid for by the business per kg (half Bengaluru's
// wet-waste fee) and pay the carrier per run. In this prototype no money moves; amounts are recorded, not charged.
const PLATFORM_UPI = process.env.SECONDS_UPI || null;          // where businesses pay their monthly statement; unset in the prototype
const DROP_RADIUS_KM = 0.5;                                      // a drop is only recorded by someone standing at the spot
const UPI_RE = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63}$/i;
const FREE_LAST_MIN = 60, PLATFORM_CUT = 0.15, PICKUP_FEE_PER_KG = 6, WASTE_FEE_PER_KG = 12, CO2E_PER_KG = 2.5, RUN_BASE = 30, RUN_PER_KM = 10;
const KINDS = ['gathering', 'kitchen', 'fridge'];
const PHOTOS = path.join(DATA, 'photos'), PHOTO_MAX = 700 * 1024, MIN_PHOTOS = 2, MAX_PHOTOS = 3;   // every post carries 2-3 photos of the food: data/photos/<post>-<n>.jpg
// Rescue credits: a seller earns rupees of credit for every kg that leaves as food instead of going in the bin,
// double when it is given free, plus a bonus for bakers (bread cannot be kept overnight). Credits pay down the Seconds fee.
const CREDIT_SOLD_PER_KG = 3, CREDIT_FREE_PER_KG = 6, CREDIT_BAKER_BONUS_PER_KG = 2;
// Delivery, riders, kirana chill hubs and points. Each rule is set so that no single order can lose money (ECONOMICS.md):
// the buyer's delivery fee is always above the rider's pay; a rider who adds an order to a run already going to that shop
// is paid a smaller add-on (batching); credits can cover at most half of a seller's fee; points cost under 1% of food.
const RIDER_PAY = km => Math.round(30 + 7 * km);                        // what the rider earns for a solo run (about ₹100 an hour on the road, see econ/stress.js)
const DELIVERY_FEE = km => Math.max(35, Math.round(27 + 8 * km), Math.ceil(RIDER_PAY(km) * 1.1));   // what the buyer pays; never below 1.1 × the rider's pay
const RIDER_BATCH_ADD = 15, BATCH_WINDOW_MIN = 10, BATCH_MAX = 4;        // one more order on a run already heading to the same shop
const HUB_FEE = 3, HUB_KIRANA = 2, CHILL_EXTRA_MIN = 480;               // per portion sold from a kirana chill hub: ₹2 to the kirana, ₹1 to Seconds; chilled food gets +8 h
const POINT_PER_RUPEES = 10, POINT_VALUE = 0.1, POINT_REDEEM = 0.7;     // buyers earn 1 point per ₹10 (worth ₹0.10, redeem later); about 70% ever get redeemed
const CREDIT_FEE_CAP = 0.5;                                              // credits pay at most half of a seller's Seconds fee
const PLATFORM_FEE = 4, CSR_PER_MEAL = 8, PLAN_PRICE = 799;             // ₹4 per paid order (buyer); ₹8 per free portion from a CSR sponsor (pilot assumption); seller plan ₹799/month
const RIDER_NAMES = ['Farhan', 'Imran', 'Kavya', 'Sameer'];
const LEG_MS = DEMO ? { toShop: 20e3, toBuyer: 35e3 } : null;            // demo mode plays a whole delivery in under a minute
const round2 = v => Math.round(v * 100) / 100;
const SAMPLE_PHOTO = path.join(PUBLIC, 'sample-food.jpg');          // optional: a real photo used for the demo story's post

/* ---------- storage ---------- */
let db = { users: [], posts: [], spots: [], hubs: [], riders: [], ledger: [], seq: 1 };
function save() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex'); }
function makeUser(u, pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const user = Object.assign({ id: 'u' + db.seq++, role: 'member', kind: 'person', strikes: 0, lat: null, lon: null, place: null, createdAt: Date.now(), lastSeen: null }, u, { salt, hash: hashPin(pin, salt) });
  db.users.push(user); return user;
}
function init() {
  fs.mkdirSync(DATA, { recursive: true }); fs.mkdirSync(PHOTOS, { recursive: true });
  if (fs.existsSync(DB_FILE)) { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); db.hubs = db.hubs || []; db.riders = db.riders || []; return; }
  const pin = String(crypto.randomInt(0, 1e6)).padStart(6, '0');   // generated once, kept only in data/seed.json
  const seed = [
    { name: 'Asha', about: 'cooks at home, lives nearby' }, { name: 'Ravi', about: 'student, walks home past the shelter' }, { name: 'Lakshmi Hall', about: 'wedding hall', kind: 'business' },
    { name: 'Farhan', about: 'has a car, carries food to spots' }, { name: 'Moderator', about: 'keeps posts and spots honest', role: 'steward' },
    { name: 'Corner Bakery', about: 'bakery, sells leftovers cheap', kind: 'business', upi: 'cornerbakery.demo@seconds' }
  ].map((u, i) => Object.assign(u, { phone: '90000000' + String(i + 1).padStart(2, '0') }));
  seed.forEach(u => makeUser(u, pin));
  fs.writeFileSync(SEED_FILE, JSON.stringify({ note: 'Demo accounts for local use. Delete data/ to regenerate.', pin, accounts: seed.map(u => ({ name: u.name, about: u.about, phone: u.phone, role: u.role || 'member', kind: u.kind || 'person' })) }, null, 1));
  save();
}
const seededPhones = () => fs.existsSync(SEED_FILE) ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')).accounts : [];

/* ---------- record: every entry carries the hash of the one before it ---------- */
/* ---------- live updates: every open page hears about every action within a moment ---------- */
const listeners = new Set(); let pushTimer = null, lastEvent = null;
function announce(e) {
  lastEvent = { n: e.n, type: e.type, ref: e.ref, actor: e.actor, actorName: e.type === 'reserved' ? 'Someone' : e.actorName, data: e.type === 'settings' ? {} : e.data };
  if (pushTimer) return;
  pushTimer = setTimeout(() => { pushTimer = null; const msg = 'data: ' + JSON.stringify(lastEvent) + '\n\n'; for (const res of listeners) { try { res.write(msg); } catch (x) { listeners.delete(res); } } }, 120);
}
function record(type, ref, actor, data) {
  const prev = db.ledger.length ? db.ledger[db.ledger.length - 1].hash : 'genesis';
  const body = { n: db.ledger.length + 1, ts: Date.now(), type, ref, actor: actor ? actor.id : null, actorName: actor ? actor.name : 'System', data: data || {} };
  db.ledger.push(Object.assign(body, { prev, hash: crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex') }));
  announce(body);
}
function verifyChain() {
  let prev = 'genesis';
  for (const e of db.ledger) {
    const { prev: p, hash, ...body } = e;
    if (p !== prev || crypto.createHash('sha256').update(prev + JSON.stringify(body)).digest('hex') !== hash) return { ok: false, brokenAt: e.n };
    prev = hash;
  }
  return { ok: true, records: db.ledger.length };
}

/* ---------- geography ---------- */
const validPoint = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
function kmBetween(a, b) {                                      // great-circle distance x 1.3 for road detours; works at any latitude
  const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x)) * 1.3;
}
const tripMin = km => Math.round(km / 18 * 60) + 5;             // 18 km/h in city traffic, plus 5 minutes to find the door
const blur = v => Math.round(v * 400) / 400;                    // about 250 m: where food is, not whose door it is
function offset(p, km, bearing) { const d = km / 111; return { lat: p.lat + d * Math.cos(bearing), lon: p.lon + d * Math.sin(bearing) / Math.cos(p.lat * Math.PI / 180) }; }
const refPoint = ref => db.posts.find(p => p.id === ref) || db.spots.find(s => s.id === ref) || null;

/* ---------- the matching rule: the hungriest spot that the food can still reach in time ---------- */
const unfedMin = (s, now) => Math.min(24 * 60, Math.round((now - (s.lastFedAt || s.createdAt)) / MIN));
function bestSpot(post, now, exclude) {
  const leftMin = (post.safeUntil - now) / MIN; let best = null;
  for (const s of db.spots) {
    if (exclude && exclude.includes(s.id)) continue;
    const k = kmBetween(post, s); if (k > NEAR_KM) continue;
    const t = tripMin(k); if (t + MARGIN_MIN > leftMin) continue;          // never promise what the clock cannot keep
    const hungry = unfedMin(s, now), score = hungry * Math.log2(2 + s.people) / (1 + t / 30);
    if (!best || score > best.score) best = { score, id: s.id, name: s.name, people: s.people, unfedMin: hungry, km: Math.round(k * 10) / 10, tripMin: t };
  }
  if (best) delete best.score;
  return best;
}

/* ---------- price falls with the clock; free in the last hour ---------- */
function freeAt(p) { return p.price ? p.safeUntil - FREE_LAST_MIN * MIN : p.postedAt || p.createdAt; }
function priceNow(p, now) {
  if (!p.price) return 0;
  const start = p.postedAt || p.createdAt, end = freeAt(p);
  if (now >= end || end <= start) return 0;
  const v = Math.round(p.price * (end - now) / (end - start) / 5) * 5;   // steps of 5 rupees
  return v < 5 ? 0 : Math.min(p.price, v);
}
// how often someone actually collects what they reserve
function reliability(uid) {
  let done = 0, missed = 0;
  for (const p of db.posts) for (const c of p.claims) if (c.takerId === uid) { if (c.status === 'collected') done++; else if (c.status === 'noshow') missed++; }
  return { done, missed, pct: done + missed ? Math.round(done / (done + missed) * 100) : null };
}

/* ---------- sample data around wherever the viewer is (demo mode only) ---------- */
function seedAround(here) {
  const now = Date.now(), near = o => kmBetween(o, here) < NEAR_KM, r = (a, b) => a + Math.random() * (b - a);
  const by = n => db.users.find(m => m.name === n);
  let changed = false;
  if (!db.spots.some(near)) {
    [['Railway station gate', 'gathering', 40, 'evenings and nights', 9], ['Temple steps', 'gathering', 25, 'after 8 pm', 3], ['Bus stand shelter', 'gathering', 30, 'nights', 6], ['Night shelter', 'kitchen', 80, 'doors close 22:00', 4.5], ['Labour camp kitchen', 'kitchen', 110, 'until 23:00', 1.5], ['Community fridge', 'fridge', 60, 'open all night', 2]]
      .forEach((s, i) => { const p = offset(here, r(0.9, 3.6), i * 1.05 + r(0, 0.4)); db.spots.push({ id: 'S' + db.seq++, name: s[0], kind: s[1], people: s[2], hours: s[3], lat: p.lat, lon: p.lon, addedBy: null, addedByName: 'Sample', vouches: [], meals: 0, lastFedAt: now - s[4] * HOUR, sample: true, createdAt: now - 30 * 24 * HOUR }); });
    changed = true;
  }
  // kirana chill hubs: neighbourhood stores with a fridge that hold surplus, extend its clock and act as pickup points
  if (!db.hubs.some(near)) {
    [['Sri Ganesh Kirana', 0.9, 0.6], ['Fresh Point Kirana', 2.1, 2.4], ['Lakshmi Stores', 1.6, 4.3]].forEach(([name, k, b]) => { const p = offset(here, k, b); db.hubs.push({ id: 'H' + db.seq++, name, lat: p.lat, lon: p.lon, capacity: 80, stored: 0, earned: 0, sample: true }); });
    changed = true;
  }
  if (!db.riders.some(near)) { RIDER_NAMES.forEach((name, i) => { const p = offset(here, 0.8 + i * 0.5, i * 1.6 + 0.4); db.riders.push({ id: 'R' + db.seq++, name, lat: p.lat, lon: p.lon, runs: 0, earned: 0 }); }); changed = true; }
  if (!db.posts.some(p => p.status === 'open' && !p.story && near(p))) {
    [['Hotel Annapoorna', 18, 'meal', 'veg', 35, 'Chole chawal, lunch buffet', 40, 120, 'chole'], ['Cafe Brew', 24, 'bakery', 'egg', 0, 'Butter croissants from this morning', 35, 90, 'croissant'], ['Office canteen', 45, 'meal', 'nonveg', 20, 'Chicken biryani, lunch counter', 50, 160, 'biryani'], ['Fresh Mart', 12, 'fruit', 'veg', 0, 'Bananas and apples, slightly bruised', 15, 40, 'banana'], ['Sweet stall', 20, 'sweets', 'veg', 0, 'Mysore pak and laddu, boxed', 20, 60, 'laddu']]
      .forEach((x, i) => {
        const p = offset(here, r(0.5, 3.4), i * 1.3 + r(0, 0.5)), u = by(x[0]), made = now - x[4] * MIN;
        db.posts.push({ id: 'P' + db.seq++, giverId: u ? u.id : null, giverName: x[0], giverKind: 'business', qty: x[1], left: x[1], cls: x[2], diet: x[3], note: x[5], price: x[6], mrp: x[7], img: x[8], postedAt: now - x[4] * MIN, lat: p.lat, lon: p.lon, place: 'Front gate (sample pickup point)', createdAt: made, safeUntil: made + FOODS[x[2]].min * MIN, status: 'open', claims: [], sample: true });
      });
    changed = true;
  }
  return changed;
}

/* ---------- time: expire food, release reservations nobody came for ---------- */
function sweep() {
  const now = Date.now(); let changed = false;
  for (const p of db.posts) {
    for (const c of p.claims) if (c.mode === 'delivery' && c.status === 'collected' && !c.deliveredAt && c.deliverAt && now >= c.deliverAt) { delivered(p, c); changed = true; }
    for (const c of p.claims) if (c.status === 'held' && now > Math.min(c.holdUntil, p.safeUntil)) {
      c.status = now > p.safeUntil ? 'expired' : 'noshow'; changed = true;
      if (c.status === 'noshow') { p.left += c.qty; const u = db.users.find(x => x.id === c.takerId); if (u) { u.strikes = (u.strikes || 0) + 1; u.strikeAt = now; } record('no-show', p.id, null, { taker: c.takerName, qty: c.qty }); }
    }
    if (p.status === 'open' && now > p.safeUntil) { p.status = 'expired'; changed = true; if (p.left > 0 && !p.sample) record('expired', p.id, null, { lost: p.left, note: 'Clock ran out. Not handed over.' }); }
    if (p.status === 'open' && p.left <= 0 && !p.claims.some(c => c.status === 'held')) { p.status = 'gone'; changed = true; }
  }
  if (changed) save();
}

/* ---------- the actions, shared by the API and the demo story ---------- */
const bad = (msg, code) => Object.assign(new Error(msg), { code: code || 400 });
const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
const point = b => { const lat = Number(b.lat), lon = Number(b.lon); if (!validPoint(lat, lon)) throw bad('We need a location for this. Allow location access or type your area.'); return { lat, lon }; };
const photoFile = (id, i) => path.join(PHOTOS, id + '-' + i + '.jpg');
function savePhoto(id, i, data) {
  const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
  if (!m) return false;
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length < 100 || buf.length > PHOTO_MAX) return false;
  fs.mkdirSync(PHOTOS, { recursive: true }); fs.writeFileSync(photoFile(id, i), buf); return true;
}
function doPost(u, body, story, noPhoto) {
  const now = Date.now(), qty = parseInt(body.qty, 10), cls = body.cls === 'cooked' ? 'meal' : body.cls, food = FOODS[cls], p = point(body);
  if (!(qty >= 1 && qty <= 1000)) throw bad('Enter how many meals, from 1 to 1,000.');
  if (!food) throw bad('Choose what kind of food it is.');
  const diet = DIETS.includes(body.diet) ? body.diet : 'veg';
  const ago = food.cooked ? Math.max(0, Math.min(300, parseInt(body.cookedMinutesAgo, 10) || 0)) : 0;
  // the seller can end the listing sooner than the food's safe time, e.g. when the shop closes; never later
  const until = parseInt(body.untilMinutes, 10), safeMin = until >= 30 ? Math.min(food.min - ago, until) : food.min - ago;
  if (safeMin < 30) throw bad('This food has under 30 minutes of safe time left, so nobody can collect it in time. Please do not share it.', 409);
  // FSSAI's surplus-food rules make the donor responsible for safe handling up to handover; we record the giver's confirmation
  if (body.hygiene !== true) throw bad('Confirm the safety checklist: covered, handled with clean hands, kept away from raw food.');
  // photos of the actual food, so buyers can judge it before they come (SMS posts and the demo story are the exceptions)
  const photos = (Array.isArray(body.photos) ? body.photos : body.photo ? [body.photo] : []).slice(0, MAX_PHOTOS);
  if (!story && !noPhoto && photos.filter(x => /^data:image\//.test(String(x || ''))).length < MIN_PHOTOS) throw bad('Add ' + MIN_PHOTOS + ' to ' + MAX_PHOTOS + ' photos of the food so buyers can see exactly what they get.');
  if (db.posts.filter(x => x.giverId === u.id && x.status === 'open' && !x.sample).length >= 5) throw bad('You already have 5 open posts. Close one first.', 409);
  const price = Math.max(0, parseInt(body.price, 10) || 0);
  if (price && u.kind !== 'business') throw bad('Only business accounts can sell food. Share it free instead.', 403);
  if (price > 500) throw bad('Keep the price under 500 rupees a portion.');
  const mrp = Math.max(0, parseInt(body.mrp, 10) || 0);                 // the normal price, so buyers see the discount
  if (mrp > 2000) throw bad('Enter the normal price per portion, up to 2,000 rupees.');
  if (mrp && price > mrp) throw bad('The starting price should be below the normal price.');
  if (price && safeMin <= FREE_LAST_MIN + 15) throw bad('This food is close to its last hour, so it can only be shared free now.', 409);
  const post = { id: 'P' + db.seq++, giverId: u.id, giverName: u.name, giverKind: u.kind || 'person', qty, left: qty, cls, diet, price, mrp: mrp || null, note: clean(body.note, 120), lat: p.lat, lon: p.lon, place: clean(body.place, 80) || null, createdAt: now - ago * MIN, postedAt: now, safeUntil: now + safeMin * MIN, status: 'open', claims: [] };
  if (story) post.story = true;
  for (let i = 0; i < photos.length; i++) if (!savePhoto(post.id, i, photos[i])) throw bad('Photo ' + (i + 1) + ' could not be used. Try a JPEG under 700 KB.');
  if (!photos.length && story && fs.existsSync(SAMPLE_PHOTO)) { fs.mkdirSync(PHOTOS, { recursive: true }); fs.copyFileSync(SAMPLE_PHOTO, photoFile(post.id, 0)); }
  post.photos = 0; while (post.photos < MAX_PHOTOS && fs.existsSync(photoFile(post.id, post.photos))) post.photos++;
  db.posts.push(post); post.hygiene = true; record('posted', post.id, u, { qty, food: food.label, diet, safeMinutes: safeMin, price, checklist: 'confirmed', photos: post.photos, mrp: post.mrp }); save();
  return post;
}
function doClaim(u, post, body) {
  const now = Date.now();
  if (post.giverId === u.id) throw bad('This is your own post.', 403);
  if (post.status !== 'open' || now > post.safeUntil) throw bad('This food is no longer available.', 409);
  if (u.strikes >= STRIKES_OUT && now - (u.strikeAt || 0) < 24 * HOUR) throw bad('You reserved food ' + STRIKES_OUT + ' times without collecting it. Reserving is paused for a day.', 403);
  if (post.claims.some(c => c.takerId === u.id && c.status === 'held')) throw bad('You already have a reservation on this post.', 409);
  if (db.posts.reduce((a, x) => a + x.claims.filter(c => c.takerId === u.id && c.status === 'held').length, 0) >= MAX_HOLDS) throw bad('Collect or release your other reservations first. Two at a time keeps food from being held and wasted.', 409);
  const qty = parseInt(body.qty, 10); if (!(qty >= 1 && qty <= post.left)) throw bad(post.left > 0 ? 'Only ' + post.left + ' meals are left on this post.' : 'All of this food is already reserved.', 409);
  const from = body.lat == null ? (u.lat != null ? u : null) : point(body); if (!from) throw bad('We need your location to check you can reach it in time.');
  let spot = null; if (body.spotId) { spot = db.spots.find(s => s.id === body.spotId); if (!spot) throw bad('That spot no longer exists.', 404); }
  const mode = body.mode === 'delivery' && !spot ? 'delivery' : 'pickup';
  let dl = null;
  if (mode === 'delivery') {
    const km = kmBetween(post, from);
    if (km > 8) throw bad('Delivery is for addresses within 8 km. Pick it up instead.');
    // batching: an order joins a rider already heading to this shop (same post, within 10 minutes, not yet picked up)
    const batch = post.claims.find(c => c.mode === 'delivery' && c.status === 'held' && !c.batchOf && now - c.createdAt < BATCH_WINDOW_MIN * MIN && (c.batchSize || 1) < BATCH_MAX && now < c.atShopAt);
    const busy = new Set(db.posts.flatMap(p => p.claims.filter(c => c.mode === 'delivery' && (c.status === 'held' || (c.status === 'collected' && !c.deliveredAt))).map(c => c.riderId)));
    const rider = batch ? db.riders.find(r => r.id === batch.riderId) : db.riders.filter(r => !busy.has(r.id)).sort((a, b) => kmBetween(a, post) - kmBetween(b, post))[0];
    if (!rider) throw bad('All riders are busy right now. Pick it up yourself, or try again in a few minutes.', 409);
    const toShop = batch ? 0 : tripMin(kmBetween(rider, post)), toBuyer = tripMin(km);
    dl = { km, batch, rider, toShop, toBuyer };
  }
  const eta = dl ? dl.toShop + dl.toBuyer : tripMin(kmBetween(from, post)), onward = spot ? tripMin(kmBetween(post, spot)) : 0, leftMin = (post.safeUntil - now) / MIN;
  // the promise rule: no reservation unless the food can be collected (and carried on) inside its clock, with a margin
  if (eta + onward + MARGIN_MIN > leftMin) throw bad('You are about ' + (eta + onward) + ' minutes away and this food has ' + Math.floor(leftMin) + ' minutes of safe time left. Someone closer should take it.', 409);
  const each = spot ? 0 : priceNow(post, now);                              // food carried to a spot is never sold
  const claim = { id: 'C' + db.seq++, takerId: u.id, takerName: u.name, qty, price: each, amount: each * qty, code: String(crypto.randomInt(0, 10000)).padStart(4, '0'), createdAt: now, etaMin: eta, holdUntil: Math.min(post.safeUntil, now + Math.max(30, eta + 20) * MIN), status: 'held', spotId: spot ? spot.id : null, spotName: spot ? spot.name : null };
  if (dl) {
    const b = dl.batch;
    Object.assign(claim, { mode: 'delivery', km: round2(dl.km), deliveryFee: DELIVERY_FEE(dl.km), riderPay: b ? RIDER_BATCH_ADD : RIDER_PAY(dl.km), riderId: dl.rider.id, riderName: dl.rider.name,
      riderFrom: b ? b.riderFrom : { lat: dl.rider.lat, lon: dl.rider.lon }, buyerAt: { lat: from.lat, lon: from.lon }, batchOf: b ? b.id : null,
      atShopAt: b ? b.atShopAt : now + (LEG_MS ? LEG_MS.toShop : dl.toShop * MIN), legMs: LEG_MS ? LEG_MS.toBuyer : dl.toBuyer * MIN, toShopMin: dl.toShop, toBuyerMin: dl.toBuyer,
      holdUntil: Math.min(post.safeUntil, now + Math.max(60, dl.toShop + 30) * MIN) });
    if (b) b.batchSize = (b.batchSize || 1) + 1;
    else setTimeout(() => { if (claim.status === 'held') { record('rider at shop', post.id, null, { rider: claim.riderName, shop: post.giverName }); save(); } }, claim.atShopAt - now + 50).unref();
  } else claim.mode = 'pickup';
  post.claims.push(claim); post.left -= qty; record('reserved', post.id, u, { qty, etaMin: eta, forSpot: claim.spotName, amount: claim.amount, mode: claim.mode, deliveryFee: claim.deliveryFee || 0, batched: !!claim.batchOf, rider: claim.riderName || null }); save();
  return claim;
}
// what one finished order earned everyone; Seconds' margin can never go below zero under these rules
function claimEcon(post, c) {
  const food = c.amount || 0, commission = Math.round(food * PLATFORM_CUT), hubQty = post.hubId ? c.qty : 0;
  const delivery = c.mode === 'delivery' ? c.deliveryFee : 0, rider = c.mode === 'delivery' ? c.riderPay : 0;
  const points = Math.floor(food / POINT_PER_RUPEES), pointsCost = round2(points * POINT_VALUE * POINT_REDEEM);
  const creditsCost = round2(Math.min(c.credits || 0, (commission + (c.fee || 0)) * CREDIT_FEE_CAP));
  const platformFee = food ? PLATFORM_FEE : 0, csr = food ? 0 : c.qty * CSR_PER_MEAL;     // free food never pays a fee; a sponsor pays for it
  const hubSeconds = hubQty * (HUB_FEE - HUB_KIRANA), revenue = commission + hubSeconds + delivery - rider + platformFee + csr;
  return { platformFee, csr, food, commission, hubFee: hubQty * HUB_FEE, kirana: hubQty * HUB_KIRANA, hubSeconds, delivery, rider, batched: !!c.batchOf, points, pointsCost, credits: c.credits || 0, creditsCost,
    revenue, margin: round2(revenue - pointsCost - creditsCost), sellerNet: food - commission - hubQty * HUB_FEE, buyerPays: food + delivery + platformFee,
    buyerSaved: Math.max(0, ((post.mrp || post.price || 0) - (c.price || 0)) * c.qty), dumpAvoided: Math.round(c.qty * KG_PER_MEAL * WASTE_FEE_PER_KG) };
}
function delivered(post, c) {
  c.deliveredAt = c.deliverAt; const r = db.riders.find(x => x.id === c.riderId); if (r) { r.runs++; r.earned += c.riderPay; if (c.buyerAt) { r.lat = c.buyerAt.lat; r.lon = c.buyerAt.lon; } }
  record('delivered', post.id, null, { to: c.takerName, rider: c.riderName, qty: c.qty, minutesLeft: Math.round((post.safeUntil - c.deliverAt) / MIN) });
}
function doHandover(u, post, code, paidBy, claimId) {
  const now = Date.now();
  if (post.giverId !== u.id) throw bad('Only the person who posted the food can confirm a handover.', 403);
  if (now > post.safeUntil) throw bad('The safety clock has run out. Please do not hand this food over.', 409);
  let claim;
  if (claimId) {
    // a rider collecting a delivery: the rider's app has scanned the order at the counter, which needs the rider to be there
    claim = post.claims.find(c => c.id === claimId && c.status === 'held' && c.mode === 'delivery');
    if (!claim) return null;
    if (now < claim.atShopAt) throw bad('The rider is not at your counter yet.', 409);
    claim.paidBy = claim.amount ? 'upi' : null;                      // delivery orders are paid in the app when ordered
  } else {
    claim = post.claims.find(c => c.status === 'held' && c.code === String(code || '').trim());
    if (!claim) return null;
    if (claim.amount) claim.paidBy = ['upi', 'cash'].includes(paidBy) ? paidBy : 'unpaid';
  }
  const kg = claim.qty * KG_PER_MEAL;
  claim.credits = Math.round(kg * ((claim.amount ? CREDIT_SOLD_PER_KG : CREDIT_FREE_PER_KG) + (post.cls === 'bakery' ? CREDIT_BAKER_BONUS_PER_KG : 0)));
  claim.status = 'collected'; claim.collectedAt = now; claim.econ = claimEcon(post, claim);
  const buyer = db.users.find(x => x.id === claim.takerId); if (buyer) buyer.points = (buyer.points || 0) + claim.econ.points;
  if (post.hubId) { const h = db.hubs.find(x => x.id === post.hubId); if (h) { h.earned += claim.econ.kirana; h.stored = Math.max(0, h.stored - claim.qty); } }
  if (claim.mode === 'delivery') { claim.deliverAt = now + claim.legMs; setTimeout(() => { if (!claim.deliveredAt) { delivered(post, claim); save(); } }, claim.legMs + 50).unref(); }
  record('handed over', post.id, u, { mode: claim.mode, rider: claim.riderName || null, margin: claim.econ.margin, points: claim.econ.points, to: claim.takerName, qty: claim.qty, minutesLeft: Math.round((post.safeUntil - now) / MIN), paid: claim.amount || 0, paidBy: claim.paidBy || null, credits: claim.credits }); sweep(); save();
  return claim;
}
function doDrop(u, post, claim, people, at) {
  const now = Date.now();
  if (claim.takerId !== u.id) throw bad('That is not your reservation.', 403);
  if (claim.status !== 'collected' || !claim.spotId || claim.droppedAt) throw bad('There is nothing to drop off for this reservation.', 409);
  if (now > post.safeUntil) throw bad('The safety clock ran out on the way. Please do not serve this food.', 409);
  const target = db.spots.find(s => s.id === claim.spotId);
  if (target) {
    // counts are only as good as where they were made: the carrier has to be standing at the spot
    if (!at || !validPoint(Number(at.lat), Number(at.lon))) throw bad('We need your location to confirm you are at the spot.');
    const away = kmBetween({ lat: Number(at.lat), lon: Number(at.lon) }, target) / 1.3;
    if (away > DROP_RADIUS_KM) throw bad('You are about ' + (Math.round(away * 10) / 10) + ' km from ' + target.name + '. Record the drop when you are there.', 409);
  }
  people = parseInt(people, 10); if (!(people >= 0 && people <= claim.qty * 2)) throw bad('Enter how many people received food.');
  const spot = db.spots.find(s => s.id === claim.spotId), waited = spot ? unfedMin(spot, now) : null; claim.droppedAt = now; claim.people = people;
  if (spot) { spot.meals += claim.qty; spot.fedPeople = (spot.fedPeople || 0) + people; spot.lastFedAt = now; }
  // the carrier is paid per run; a business giver pays the pickup fee per kg, a person's food is paid from the sponsor pool
  const kg = Math.round(claim.qty * KG_PER_MEAL * 10) / 10;
  claim.payout = RUN_BASE + Math.round(RUN_PER_KM * (spot ? kmBetween(post, spot) : 0));
  claim.fee = post.giverKind === 'business' ? Math.round(kg * PICKUP_FEE_PER_KG) : 0;
  record('dropped at spot', post.id, u, { spot: claim.spotName, qty: claim.qty, people, waitedMinutes: waited, kg, payout: claim.payout, fee: claim.fee }); save();
}

/* ---------- the demo story: one evening, played through the real actions above ---------- */
const STORY = {};
function story(step, here) {
  const now = Date.now(), who = n => db.users.find(u => u.name === n);
  const hall = who('Lakshmi Hall'), asha = who('Asha'), farhan = who('Farhan'), ravi = who('Ravi');
  const post = STORY.postId && db.posts.find(p => p.id === STORY.postId);
  const spotOut = s => s && { id: s.id, name: s.name, people: s.people, lat: s.lat, lon: s.lon, unfedMin: unfedMin(s, now), kind: s.kind };
  if (step === 'start') {
    seedAround(here);
    db.posts = db.posts.filter(p => !p.story);
    for (const p of db.posts) for (const c of p.claims) if (c.status === 'held' && [asha, farhan, ravi].some(u => u && u.id === c.takerId)) { c.status = 'released'; p.left += c.qty; }
    [asha, farhan, ravi, hall].forEach(u => { if (u) u.strikes = 0; });
    const near = db.spots.filter(s => kmBetween(s, here) < NEAR_KM).sort((a, b) => kmBetween(a, here) - kmBetween(b, here));
    const station = near.find(s => /station/i.test(s.name)) || near.find(s => s.kind === 'gathering') || near[0];
    const shelter = near.find(s => /shelter/i.test(s.name) && s.kind === 'kitchen') || near.find(s => s.kind === 'kitchen' && s !== station) || near.find(s => s !== station);
    near.forEach((s, i) => { s.lastFedAt = now - (1 + (i % 3) * 0.7) * HOUR; });
    if (station) station.lastFedAt = now - (9 * 60 + 12) * MIN;
    if (shelter) shelter.lastFedAt = now - 270 * MIN;
    const at = station ? offset(here, 0.4, Math.atan2(station.lon - here.lon, station.lat - here.lat) + Math.PI) : offset(here, 0.4, 2.4);
    const p = doPost(hall, { qty: 120, cls: 'meal', diet: 'veg', cookedMinutesAgo: 25, hygiene: true, note: 'Wedding dinner: rice, dal, paneer curry, gulab jamun', place: 'Lakshmi Kalyana Mantapa, back service gate', lat: at.lat, lon: at.lon }, true);
    Object.assign(STORY, { postId: p.id, stationId: station && station.id, shelterId: shelter && shelter.id, here });
    return { post: { id: p.id, lat: p.lat, lon: p.lon, qty: p.qty, safeUntil: p.safeUntil }, station: spotOut(station), shelter: spotOut(shelter) };
  }
  if (!post) throw bad('Start the story first.', 409);
  if (step === 'spots') {
    const near = db.spots.filter(s => kmBetween(s, post) < NEAR_KM).map(s => spotOut(s)).sort((a, b) => b.unfedMin - a.unfedMin);
    return { spots: near, people: near.reduce((a, s) => a + s.people, 0) };
  }
  if (step === 'neighbour') {
    const from = offset(post, 0.6, 1.2), c = doClaim(asha, post, { qty: 4, lat: from.lat, lon: from.lon });
    STORY.asha = c.id; return { claim: { qty: c.qty, code: c.code, etaMin: c.etaMin }, from };
  }
  if (step === 'carrier') {
    const best = bestSpot(post, now), spot = db.spots.find(s => s.id === best.id), from = offset(post, 1.4, 4.0);
    const c = doClaim(farhan, post, { qty: 80, spotId: spot.id, lat: from.lat, lon: from.lon });
    STORY.farhan = c.id; STORY.farhanSpot = spot.id;
    return { claim: { qty: c.qty, code: c.code, etaMin: c.etaMin }, best, spot: spotOut(spot), from, left: post.left };
  }
  if (step === 'handover') {
    const out = [];
    for (const id of [STORY.asha, STORY.farhan]) { const c = post.claims.find(x => x.id === id); if (c && c.status === 'held') { doHandover(hall, post, c.code); out.push({ to: c.takerName, qty: c.qty, code: c.code }); } }
    return { handed: out, minutesLeft: Math.round((post.safeUntil - now) / MIN), left: post.left };
  }
  if (step === 'drop') {
    const c = post.claims.find(x => x.id === STORY.farhan), spot = db.spots.find(s => s.id === STORY.farhanSpot), waited = spot ? unfedMin(spot, now) : 0;
    if (c && !c.droppedAt) doDrop(farhan, post, c, 76, spot);
    return { spot: spotOut(spot), waitedMin: waited, people: 76, payout: c ? c.payout : 0, fee: c ? c.fee : 0 };
  }
  if (step === 'lastcall') {
    const rest = post.left, target = (STORY.shelterId && db.spots.find(s => s.id === STORY.shelterId && s.id !== STORY.farhanSpot)) || db.spots.find(s => s.id === (bestSpot(post, now, [STORY.farhanSpot]) || {}).id);
    if (rest > 0 && target) {
      const from = offset(post, 0.3, 5.5), c = doClaim(ravi, post, { qty: rest, spotId: target.id, lat: from.lat, lon: from.lon });
      doHandover(hall, post, c.code); doDrop(ravi, post, c, rest, target);
    }
    sweep();
    return { qty: rest, spot: spotOut(target), status: post.status };
  }
  if (step === 'summary') {
    const got = post.claims.filter(c => c.status === 'collected'), refs = db.ledger.filter(e => e.ref === post.id || (STORY.farhanSpot && e.ref === STORY.farhanSpot));
    const kg = Math.round(got.reduce((a, c) => a + c.qty, 0) * KG_PER_MEAL * 10) / 10;
    return { kg, wasteFeeAvoided: Math.round(kg * WASTE_FEE_PER_KG), co2e: Math.round(kg * CO2E_PER_KG), pickupFee: got.reduce((a, c) => a + (c.fee || 0), 0), payouts: got.reduce((a, c) => a + (c.payout || 0), 0), farhanEarned: (got.find(c => c.takerName === 'Farhan') || {}).payout || 0,
      posted: post.qty, handed: got.reduce((a, c) => a + c.qty, 0), wasted: post.status === 'expired' ? post.left : 0, peopleFed: got.reduce((a, c) => a + (c.people || 0), 0) + got.filter(c => !c.spotId).reduce((a, c) => a + c.qty, 0), spotsFed: new Set(got.filter(c => c.droppedAt).map(c => c.spotId)).size, minutesLeft: Math.round((post.safeUntil - now) / MIN), records: refs.length, chain: verifyChain() };
  }
  throw bad('Unknown story step.');
}

/* ---------- the receipt a business can file: what left its kitchen, where it went, what it saved ---------- */
function receipt(u, days) {
  const now = Date.now(), from = now - days * 24 * HOUR, round = v => Math.round(v * 10) / 10;
  const lines = db.posts.filter(p => p.giverId === u.id && (p.postedAt || p.createdAt) >= from).map(p => {
    const got = p.claims.filter(c => c.status === 'collected'), toSpots = got.filter(c => c.spotId);
    const handed = got.reduce((a, c) => a + c.qty, 0), kg = round(handed * KG_PER_MEAL);
    const sold = got.reduce((a, c) => a + (c.amount || 0), 0);
    const last = [...db.ledger].reverse().find(e => e.ref === p.id);
    const credits = got.reduce((a, c) => a + (c.credits || 0), 0);
    return { id: p.id, credits, date: p.postedAt || p.createdAt, food: (FOODS[p.cls] || {}).label, qty: p.qty, handed, toSpots: toSpots.reduce((a, c) => a + c.qty, 0),
      people: toSpots.reduce((a, c) => a + (c.people || 0), 0), kg, sold, keep: Math.round(sold * (1 - PLATFORM_CUT)), fee: got.reduce((a, c) => a + (c.fee || 0), 0),
      lost: p.status === 'expired' ? p.left : 0, record: last ? last.hash : null };
  });
  const sum = k => round(lines.reduce((a, l) => a + l[k], 0));
  const kg = sum('kg');
  return { business: u.name, kind: u.kind || 'person', days, from, to: now, lines,
    totals: { credits: sum('credits'), posted: sum('qty'), handed: sum('handed'), toSpots: sum('toSpots'), people: sum('people'), kg, lost: sum('lost'), sold: sum('sold'), keep: sum('keep'), fee: sum('fee'),
      wasteFeeAvoided: Math.round(kg * WASTE_FEE_PER_KG), co2e: round(kg * CO2E_PER_KG) },
    rates: { kgPerPortion: KG_PER_MEAL, wasteFeePerKg: WASTE_FEE_PER_KG, pickupFeePerKg: PICKUP_FEE_PER_KG, co2ePerKg: CO2E_PER_KG, platformCut: PLATFORM_CUT },
    due: { pickupFees: sum('fee'), commission: Math.round(sum('sold') * PLATFORM_CUT), total: Math.round(sum('fee') + sum('sold') * PLATFORM_CUT), credits: sum('credits'),
      afterCredits: Math.max(0, Math.round((sum('fee') + sum('sold') * PLATFORM_CUT) - Math.min(sum('credits'), (sum('fee') + sum('sold') * PLATFORM_CUT) * CREDIT_FEE_CAP))), creditCap: CREDIT_FEE_CAP, payTo: PLATFORM_UPI },
    chain: verifyChain() };
}
// The donation register FSSAI's Recovery and Distribution of Surplus Food Regulations 2019 ask donors to keep (Schedule II):
// who gave, to whom, when, what, how much. One row per handover, built from the record.
function register(u, days) {
  const from = Date.now() - days * 24 * HOUR, rows = [];
  for (const p of db.posts) {
    if (p.giverId !== u.id || (p.postedAt || p.createdAt) < from) continue;
    for (const c of p.claims) if (c.status === 'collected') rows.push({
      donatedAt: c.collectedAt, donor: p.giverName, donorAddress: p.place || '', food: (FOODS[p.cls] || {}).label, diet: p.diet || 'veg', batch: p.id, quantity: c.qty, unit: 'portions',
      kg: Math.round(c.qty * KG_PER_MEAL * 10) / 10, receivedBy: c.spotName ? c.takerName + ' for ' + c.spotName : c.takerName, recipientType: c.spotName ? 'spot (people in need)' : 'individual',
      peopleFed: c.people || '', safeUntil: p.safeUntil, minutesLeftAtHandover: Math.round((p.safeUntil - c.collectedAt) / MIN), sold: c.amount ? 'yes' : 'no', checklist: p.hygiene ? 'confirmed' : '' });
  }
  return rows.sort((a, b) => a.donatedAt - b.donatedAt);
}
// what each carrier is owed for runs to spots, for a weekly UPI bulk payout
function payouts() {
  const by = new Map();
  for (const p of db.posts) for (const c of p.claims) if (c.payout) {
    const u = db.users.find(x => x.id === c.takerId), o = by.get(c.takerId) || { name: c.takerName, upi: u && u.upi || null, runs: 0, amount: 0 };
    o.runs++; o.amount += c.payout; by.set(c.takerId, o);
  }
  return [...by.values()].sort((a, b) => b.amount - a.amount);
}
// SMS intake for phones without a browser. Messages look like "120 meal veg 25" (portions, food, diet, minutes since cooked).
function smsCommand(u, text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t || t === 'help') return 'Seconds: send "<portions> <food> <veg|egg|nonveg> <minutes since cooked>", e.g. "120 meal veg 25". Foods: ' + Object.keys(FOODS).join(', ') + '. Send STATUS to see your open posts.';
  if (t === 'status') {
    const open = db.posts.filter(p => p.giverId === u.id && p.status === 'open');
    return open.length ? open.map(p => p.id + ': ' + p.left + ' of ' + p.qty + ' left, ' + p.claims.filter(c => c.status === 'held').length + ' on the way').join('; ') : 'You have no open posts.';
  }
  const m = /^(?:share )?(\d{1,4}) ([a-z]+)(?: (veg|egg|nonveg|non-veg))?(?: (\d{1,3}))?$/.exec(t);
  if (!m) return 'Sorry, we did not understand. Send HELP.';
  const cls = Object.keys(FOODS).find(k => k === m[2] || k + 's' === m[2]) || (m[2] === 'cooked' ? 'meal' : null);
  if (!cls) return 'Unknown food "' + m[2] + '". Use one of: ' + Object.keys(FOODS).join(', ') + '.';
  if (u.lat == null) return 'Set your pickup location once in the app first; SMS posts use your saved location.';
  const post = doPost(u, { qty: m[1], cls, diet: (m[3] || 'veg').replace('-', ''), cookedMinutesAgo: m[4] || 0, hygiene: true, lat: u.lat, lon: u.lon, place: u.place, note: 'Posted by SMS' }, false, true);
  return 'Posted ' + post.qty + ' ' + FOODS[cls].label.toLowerCase() + ' (' + post.id + '), safe until ' + new Date(post.safeUntil).toTimeString().slice(0, 5) + '. Reply STATUS any time.';
}

/* ---------- sessions ---------- */
const sessions = new Map(), fails = new Map();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const sidName = () => 'sid_' + PORT;
const sidOf = req => { const m = new RegExp('(?:^|;\\s*)' + sidName(req) + '=([a-f0-9]{64})').exec(req.headers.cookie || ''); return m ? m[1] : null; };
function sessionUser(req) {
  const m = sidOf(req) && [null, sidOf(req)];
  if (!m) return null;
  const s = sessions.get(sha(m[1]));
  if (!s || s.exp < Date.now()) { if (s) sessions.delete(sha(m[1])); return null; }
  return db.users.find(u => u.id === s.uid) || null;
}
function startSession(res, user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(sha(token), { uid: user.id, exp: Date.now() + SESSION_MS });
  res.setHeader('Set-Cookie', `${sidName(res.req)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}`);
}
function throttled(key) { const f = fails.get(key); return f && f.n >= 5 && Date.now() - f.at < 10 * MIN; }
function failed(key) { const f = fails.get(key); if (!f || Date.now() - f.at > 10 * MIN) fails.set(key, { n: 1, at: Date.now() }); else f.n++; }

/* ---------- what each person is allowed to see ---------- */
const me = u => u && ({ id: u.id, name: u.name, phone: u.phone, role: u.role, kind: u.kind || 'person', points: u.points || 0, upi: u.upi || null, lat: u.lat, lon: u.lon, place: u.place, strikes: u.strikes || 0, since: u.createdAt });
function postView(p, u, now) {
  const mine = u && p.giverId === u.id, myClaim = u && p.claims.find(c => c.takerId === u.id && ['held', 'collected'].includes(c.status));
  const exact = mine || myClaim || (u && u.role === 'steward');
  const out = { id: p.id, giverName: p.giverName, qty: p.qty, left: p.left, cls: p.cls, diet: p.diet || 'veg', note: p.note, createdAt: p.createdAt, safeUntil: p.safeUntil, status: p.status, sample: !!p.sample, story: !!p.story, mine: !!mine, giverKind: p.giverKind || 'person', price: p.price || 0, priceNow: priceNow(p, now), freeAt: freeAt(p),
    lat: exact ? p.lat : blur(p.lat), lon: exact ? p.lon : blur(p.lon), exact: !!exact, place: exact ? p.place : null, mrp: p.mrp || null, postedAt: p.postedAt || p.createdAt,
    photos: p.img ? samplePhotos(p.img) : Array.from({ length: p.photos || 0 }, (_, i) => '/photos/' + p.id + '-' + i + '.jpg'),
    hub: p.hubId ? (db.hubs.find(h => h.id === p.hubId) || {}).name || null : null, chilledAt: p.chilledAt || null };
  out.photo = out.photos[0] || null;
  if (p.status === 'open' && p.left > 0) out.suggest = bestSpot(p, now);
  if (mine || (u && u.role === 'steward')) out.claims = p.claims.map(c => ({ id: c.id, mode: c.mode || 'pickup', riderName: c.riderName || null, riderFrom: c.riderFrom || null, buyerAt: c.buyerAt || null, atShopAt: c.atShopAt || null, deliverAt: c.deliverAt || null, deliveredAt: c.deliveredAt || null, batchOf: c.batchOf || null, deliveryFee: c.deliveryFee || 0, riderPay: c.riderPay || 0, econ: c.econ || null, takerName: c.takerName, qty: c.qty, status: c.status, holdUntil: c.holdUntil, etaMin: c.etaMin, spotName: c.spotName, createdAt: c.createdAt, collectedAt: c.collectedAt, droppedAt: c.droppedAt || null, people: c.people || 0, paidBy: c.paidBy || null, amount: c.amount || 0, fee: c.fee || 0, credits: c.credits || 0, price: c.price || 0, reliability: reliability(c.takerId) }));   // never the code
  if (myClaim) { out.myClaim = myClaim; if (myClaim.amount) { const g = db.users.find(x => x.id === p.giverId); out.payUpi = g && g.upi || null; } }
  return out;
}
const PUBLIC_EVENTS = { delivered: 1, chilled: 1, 'rider at shop': 1, posted: 1, 'handed over': 1, 'dropped at spot': 1, 'spot added': 1, reserved: 1, expired: 1 };
function eventView(e) {
  const r = refPoint(e.ref), out = { n: e.n, ts: e.ts, type: e.type, ref: e.ref, actorName: e.actorName, data: e.data };
  if (r) { out.title = r.giverName ? r.giverName + ' · ' + (FOODS[r.cls] ? FOODS[r.cls].label : 'food') : r.name; out.cls = r.cls; }
  return out;
}
function stateFor(u, at) {
  sweep();
  const now = Date.now();
  const here = at && validPoint(at.lat, at.lon) ? at : (u && u.lat != null ? u : null);
  if (here && DEMO && seedAround(here)) save();
  if (u && (!u.lastSeen || now - u.lastSeen > 5 * MIN)) { u.lastSeen = now; save(); }
  const near = o => !here || (o && kmBetween(o, here) <= NEAR_KM), day = now - 24 * HOUR;
  const mineP = p => u && (p.giverId === u.id || p.claims.some(c => c.takerId === u.id));
  const posts = db.posts.filter(p => (p.status === 'open' && near(p)) || (mineP(p) && p.createdAt > day) || (p.story && p.createdAt > day && near(p))).map(p => postView(p, u, now));
  const spots = db.spots.filter(near).map(s => ({ id: s.id, name: s.name, kind: s.kind, people: s.people, hours: s.hours, lat: s.lat, lon: s.lon, vouches: s.vouches.length, vouched: !!(u && s.vouches.includes(u.id)), meals: s.meals, fedPeople: s.fedPeople || 0, lastFedAt: s.lastFedAt, unfedMin: unfedMin(s, now), sample: !!s.sample, addedByName: s.addedByName }));
  const todays = db.posts.filter(p => p.createdAt > day && near(p)), done = todays.flatMap(p => p.claims.filter(c => c.status === 'collected'));
  const open = posts.filter(p => p.status === 'open');
  const out = { now, me: me(u), posts, spots, foods: FOODS,
    stats: { open: open.length, mealsOpen: open.reduce((a, p) => a + p.left, 0), mealsShared: done.reduce((a, c) => a + c.qty, 0), handovers: done.length, peopleFed: done.reduce((a, c) => a + (c.people || 0), 0), spotsFed: new Set(done.filter(c => c.droppedAt).map(c => c.spotId)).size, kgSaved: Math.round(done.reduce((a, c) => a + c.qty, 0) * KG_PER_MEAL), lost: todays.filter(p => p.status === 'expired' && !p.sample).reduce((a, p) => a + p.left, 0) },
    hubs: db.hubs.filter(near).map(h => ({ id: h.id, name: h.name, lat: h.lat, lon: h.lon, capacity: h.capacity, stored: h.stored, earned: h.earned })),
    trending: trending(here, now),
    feed: db.ledger.slice(-400).filter(e => PUBLIC_EVENTS[e.type] && e.ts > day && near(refPoint(e.ref))).slice(-30).reverse().map(e => { const v = eventView(e); if (e.type === 'reserved') v.actorName = 'Someone'; return v; }) };   // who is taking food stays private
  if (u) {
    // givers see everything on their own posts; takers see only their own steps and the handover to them
    const mineEv = e => { if (e.actor === u.id) return true; const p = e.ref[0] === 'P' && db.posts.find(x => x.id === e.ref); return !!p && (p.giverId === u.id || (e.type === 'handed over' && e.data.to === u.name && p.claims.some(c => c.takerId === u.id))); };
    out.given = db.posts.filter(p => p.giverId === u.id).reduce((a, p) => a + p.claims.filter(c => c.status === 'collected').reduce((x, c) => x + c.qty, 0), 0);
    out.taken = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.status === 'collected').reduce((x, c) => x + c.qty, 0), 0);
    out.fed = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.droppedAt).reduce((x, c) => x + (c.people || 0), 0), 0);
    out.earned = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.payout).reduce((x, c) => x + c.payout, 0), 0);
    out.runs = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.payout).length, 0);
    out.reliability = reliability(u.id);
    if (u.kind === 'business') { const r = receipt(u, 30); out.business = Object.assign({}, r.totals, { due: r.due }); }
    // what a buyer saved against the normal price
    out.points = u.points || 0;
    out.saved = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.status === 'collected').reduce((x, c) => x + Math.max(0, ((p.mrp || p.price || 0) - (c.price || 0)) * c.qty), 0), 0);
    out.spent = db.posts.reduce((a, p) => a + p.claims.filter(c => c.takerId === u.id && c.status === 'collected').reduce((x, c) => x + (c.amount || 0), 0), 0);
    out.history = db.ledger.filter(mineEv).slice(-120).reverse().map(eventView);
  }
  if (u && u.role === 'steward') { out.ledger = db.ledger.slice(-200).reverse(); out.chain = verifyChain(); out.payouts = payouts(); out.admin = adminView(here, now); out.riders = db.riders.filter(near).map(r => ({ id: r.id, name: r.name, lat: r.lat, lon: r.lon, runs: r.runs, earned: r.earned })); }
  return out;
}
// sample listings show real photos from demo/samples/<item>-<n>.jpg when there are any (see demo/samples/CREDITS.md), else the drawn pictures
const samplePhotos = k => { const jpg = [1, 2, 3].filter(n => fs.existsSync(path.join(PUBLIC, 'samples', k + '-' + n + '.jpg'))).map(n => '/samples/' + k + '-' + n + '.jpg'); return jpg.length ? jpg : fs.existsSync(path.join(PUBLIC, 'samples', k + '-1.svg')) ? [1, 2].map(n => '/samples/' + k + '-' + n + '.svg') : []; };
// what people near here are ordering right now
function trending(here, now) {
  const by = new Map();
  for (const e of db.ledger.slice(-600)) {
    if (e.type !== 'reserved' || now - e.ts > 6 * HOUR) continue;
    const p = db.posts.find(x => x.id === e.ref); if (!p || (here && kmBetween(p, here) > NEAR_KM)) continue;
    const k = (p.note || '').split(',')[0].trim() || (FOODS[p.cls] || {}).label; const o = by.get(k) || { name: k, cls: p.cls, qty: 0, orders: 0 }; o.qty += e.data.qty || 0; o.orders++; by.set(k, o);
  }
  return [...by.values()].sort((a, b) => b.qty - a.qty).slice(0, 6);
}
// The admin's view of the whole market: every shop, what sold, what was wasted, and what to change
function adminView(here, now) {
  const from = now - 7 * 24 * HOUR, near = o => !here || kmBetween(o, here) <= NEAR_KM;
  const posts = db.posts.filter(p => (p.postedAt || p.createdAt) >= from && near(p) && !p.story);
  const shops = new Map(), K = { gmv: 0, cut: 0, credits: 0, kg: 0, handed: 0, posted: 0, wasted: 0, live: 0, orders: 0, buyers: new Set(), saved: 0 };
  for (const p of posts) {
    const s = shops.get(p.giverName) || { name: p.giverName, kind: p.giverKind || 'person', baker: false, listings: 0, live: 0, posted: 0, sold: 0, free: 0, wasted: 0, revenue: 0, credits: 0, offSum: 0, offN: 0, minsToSell: [], lateListings: 0 };
    s.listings++; s.posted += p.qty; s.baker = s.baker || p.cls === 'bakery';
    if (p.status === 'open') { s.live++; K.live++; }
    if (p.status === 'expired') s.wasted += p.left;
    if ((p.safeUntil - (p.postedAt || p.createdAt)) / MIN < 90) s.lateListings++;
    for (const c of p.claims) {
      if (c.status === 'held') { K.orders++; K.buyers.add(c.takerId); }
      if (c.status !== 'collected') continue;
      K.buyers.add(c.takerId);
      if (c.amount) { s.sold += c.qty; s.revenue += c.amount; } else s.free += c.qty;
      s.credits += c.credits || 0;
      const ref = p.mrp || p.price; if (ref) { s.offSum += (1 - (c.price || 0) / ref) * c.qty; s.offN += c.qty; K.saved += (ref - (c.price || 0)) * c.qty; }
      s.minsToSell.push((c.createdAt - (p.postedAt || p.createdAt)) / MIN);
    }
    shops.set(p.giverName, s);
  }
  const rows = [...shops.values()].map(s => {
    const handed = s.sold + s.free, through = s.posted ? handed / s.posted : 0, off = s.offN ? s.offSum / s.offN : null;
    const fast = s.minsToSell.length ? s.minsToSell.reduce((a, b) => a + b, 0) / s.minsToSell.length : null;
    let signal = 'On track', level = 'ok';
    if (s.wasted && s.wasted / s.posted > 0.3) { signal = 'Wastes ' + Math.round(s.wasted / s.posted * 100) + '%: start lower or list earlier'; level = 'bad'; }
    else if (s.lateListings > s.listings / 2) { signal = 'Lists late: post 2-3 h before closing for more sales'; level = 'warn'; }
    else if (fast != null && fast < 10 && off != null && off < 0.4) { signal = 'Sells in ' + Math.round(fast) + ' min: start price can go up'; level = 'up'; }
    else if (s.baker && !s.credits) { signal = 'Baker: enrol for rescue credits'; level = 'warn'; }
    K.gmv += s.revenue; K.credits += s.credits; K.handed += handed; K.posted += s.posted; K.wasted += s.wasted;
    return { name: s.name, kind: s.kind, baker: s.baker, listings: s.listings, live: s.live, posted: s.posted, sold: s.sold, free: s.free, wasted: s.wasted, sellThrough: Math.round(through * 100),
      revenue: s.revenue, credits: s.credits, avgOff: off == null ? null : Math.round(off * 100), minsToSell: fast == null ? null : Math.round(fast), signal, level };
  }).sort((a, b) => b.posted - a.posted);
  K.cut = Math.round(K.gmv * PLATFORM_CUT); K.kg = Math.round(K.handed * KG_PER_MEAL * 10) / 10;
  // unit economics over every finished order: what came in, what went out, and the margin left for Seconds
  const done = posts.flatMap(p => p.claims.filter(c => c.econ).map(c => Object.assign({ id: c.id, at: c.collectedAt, item: p.note, shop: p.giverName, buyer: c.takerName, mode: c.mode || 'pickup', qty: c.qty }, c.econ)));
  const S = k => round2(done.reduce((a, x) => a + (x[k] || 0), 0)), deliveries = done.filter(x => x.mode === 'delivery');
  const econ = { platformFee: S('platformFee'), csr: S('csr'), orders: done.length, food: S('food'), commission: S('commission'), delivery: S('delivery'), rider: S('rider'), hubSeconds: S('hubSeconds'), kirana: S('kirana'), pointsCost: S('pointsCost'), creditsCost: S('creditsCost'),
    revenue: S('revenue'), margin: S('margin'), perOrder: done.length ? round2(S('margin') / done.length) : 0, minMargin: done.length ? Math.min(...done.map(x => x.margin)) : 0, lossOrders: done.filter(x => x.margin < 0).length,
    deliveries: deliveries.length, batched: deliveries.filter(x => x.batched).length, riderEarned: S('rider'), sellerNet: S('sellerNet'), buyerSaved: S('buyerSaved'), dumpAvoided: S('dumpAvoided'),
    latest: done.sort((a, b) => b.at - a.at).slice(0, 8) };
  return { days: 7, econ, shops: rows, kpis: { gmv: K.gmv, revenue: K.cut, credits: K.credits, net: K.cut - K.credits, kg: K.kg, handed: K.handed, posted: K.posted, wasted: K.wasted,
    wasteRate: K.posted ? Math.round(K.wasted / K.posted * 100) : 0, live: K.live, orders: K.orders, buyers: K.buyers.size, buyerSaved: Math.round(K.saved), dumpAvoided: Math.round(K.kg * WASTE_FEE_PER_KG) },
    rates: { platformFee: PLATFORM_FEE, csrPerMeal: CSR_PER_MEAL, planPrice: PLAN_PRICE, deliveryFee: '₹35 or ₹27 + ₹8/km (≥ 1.1 × rider pay)', riderPay: '₹30 + ₹7/km, +₹15 per batched order', hubFee: HUB_FEE, hubKirana: HUB_KIRANA, pointValue: POINT_VALUE, pointRedeem: POINT_REDEEM, creditCap: CREDIT_FEE_CAP, cut: PLATFORM_CUT, creditSold: CREDIT_SOLD_PER_KG, creditFree: CREDIT_FREE_PER_KG, bakerBonus: CREDIT_BAKER_BONUS_PER_KG, kgPerPortion: KG_PER_MEAL } };
}
// "While you were away": what happened near this person since their last visit
function digest(u) {
  const since = u.lastSeen || u.createdAt, near = o => u.lat == null || (o && kmBetween(o, u) <= NEAR_KM);
  const ev = db.ledger.filter(e => e.ts > since && near(refPoint(e.ref)));
  const sum = (t, k) => ev.filter(e => e.type === t).reduce((a, e) => a + (e.data[k] || 0), 0);
  return { since, posted: sum('posted', 'qty'), handed: sum('handed over', 'qty'), people: sum('dropped at spot', 'people'), spots: new Set(ev.filter(e => e.type === 'dropped at spot').map(e => e.data.spot)).size };
}
function signedIn(res, u) { const d = digest(u); startSession(res, u); return { me: me(u), digest: d }; }

/* ---------- http ---------- */
const TYPES = { '.jpg': 'image/jpeg', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > (limit || 10240)) { reject(bad('Request too large.', 413)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(bad('Send JSON.')); } });
  });
}

async function api(req, res, url) {
  const route = req.method + ' ' + url.pathname, ip = req.socket.remoteAddress, local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
  if (req.method === 'POST' && (req.headers['x-seconds'] !== '1' || !/^application\/json/.test(req.headers['content-type'] || ''))) return send(res, 400, { error: 'Bad request.' });   // cross-site forms cannot send these
  const body = req.method === 'POST' ? await readBody(req, route === 'POST /api/posts' ? 3 * 1024 * 1024 : 10240) : {};   // posts carry 2-3 photos

  if (route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n'); listeners.add(res);
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25000);
    req.on('close', () => { clearInterval(beat); listeners.delete(res); });
    return;
  }
  if (route === 'GET /api/demo') {
    if (!(DEMO && local)) return send(res, 200, { demo: false });
    const accounts = seededPhones();
    return send(res, 200, { demo: true, accounts: accounts.map(a => ({ name: a.name, about: a.about, phone: a.phone, role: a.role, kind: a.kind })) });
  }
  if (route === 'POST /api/demo-login') {
    // one-tap entry for demos: only in demo mode, only from this machine, only for the seeded demo accounts
    const u = DEMO && local && seededPhones().some(a => a.phone === body.phone) && db.users.find(x => x.phone === body.phone);
    if (!u) return send(res, 403, { error: 'Demo entry is switched off, or that is not a demo account.' });
    return send(res, 200, signedIn(res, u));
  }
  if (route === 'POST /api/sms') {
    // called by an SMS gateway with a shared secret; in demo mode it can be tried from this computer
    const secret = process.env.SECONDS_SMS_SECRET, okCall = (secret && req.headers['x-sms-secret'] === secret) || (DEMO && local);
    if (!okCall) return send(res, 403, { error: 'SMS intake is not enabled.' });
    const from = clean(body.from, 15).replace(/\D/g, '').slice(-10), u = db.users.find(x => x.phone === from);
    if (!u) return send(res, 200, { reply: 'This number is not registered with Seconds. Join at the website first.' });
    try { return send(res, 200, { reply: smsCommand(u, body.text) }); } catch (e) { return send(res, 200, { reply: 'Not posted: ' + e.message }); }
  }
  if (route === 'POST /api/demo/story') {
    if (!(DEMO && local)) return send(res, 403, { error: 'The demo story only runs in demo mode on this computer.' });
    return send(res, 200, story(String(body.step || ''), point(body)));
  }
  if (route === 'POST /api/login') {
    const phone = clean(body.phone, 15).replace(/\D/g, ''), key = phone + '|' + ip;
    if (throttled(key)) return send(res, 429, { error: 'Too many wrong attempts. Try again in 10 minutes.' });
    const u = db.users.find(x => x.phone === phone);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPin(body.pin || '', u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!u) hashPin(body.pin || '', 'no-such-user-salt');                            // same work either way
    if (!ok) { failed(key); return send(res, 401, { error: 'That phone number and PIN do not match.' }); }
    fails.delete(key); return send(res, 200, signedIn(res, u));
  }
  if (route === 'POST /api/signup') {
    const phone = clean(body.phone, 15).replace(/\D/g, ''), name = clean(body.name, 40), pin = String(body.pin || '');
    if (name.length < 2) return send(res, 400, { error: 'Enter your name.' });
    if (!/^\d{10}$/.test(phone)) return send(res, 400, { error: 'Enter a 10-digit phone number.' });
    if (!/^\d{6}$/.test(pin) || /^(\d)\1{5}$/.test(pin) || pin === '123456') return send(res, 400, { error: 'Choose a 6-digit PIN that is not a simple pattern.' });
    if (db.users.some(x => x.phone === phone)) return send(res, 409, { error: 'An account with this phone number already exists. Sign in instead.' });
    const u = makeUser({ name, phone, kind: body.kind === 'business' ? 'business' : 'person' }, pin); record('joined', u.id, u, { kind: u.kind }); save(); startSession(res, u);
    return send(res, 200, { me: me(u), digest: null });
  }
  // anyone can look at what is nearby; exact addresses and codes stay hidden
  if (route === 'POST /api/nearby') return send(res, 200, stateFor(sessionUser(req), body.lat == null ? null : point(body)));

  const u = sessionUser(req);
  if (!u) return send(res, 401, { error: 'Sign in first.' });
  const now = Date.now();
  if (route === 'POST /api/logout') { const t = sidOf(req); if (t) sessions.delete(sha(t)); res.setHeader('Set-Cookie', sidName(req) + '=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return send(res, 200, {}); }
  if (route === 'POST /api/me/location') { const p = point(body); u.lat = p.lat; u.lon = p.lon; u.place = clean(body.place, 80) || null; save(); return send(res, 200, { me: me(u) }); }

  if (route === 'POST /api/me/settings') {
    const upi = clean(body.upi, 300).toLowerCase();
    if (upi && !UPI_RE.test(upi)) throw bad('That does not look like a UPI ID, e.g. name@bank.');
    u.upi = upi || null; record('settings', u.id, u, { upi: u.upi ? 'set' : 'cleared' }); save(); return send(res, 200, { me: me(u) });
  }
  if (route === 'GET /api/register') return send(res, 200, { rows: register(u, Math.max(1, Math.min(366, parseInt(url.searchParams.get('days'), 10) || 30))) });
  if (route === 'GET /api/payouts') { if (u.role !== 'steward') throw bad('Only a moderator can see payouts.', 403); return send(res, 200, { payouts: payouts() }); }
  if (route === 'GET /api/receipt') return send(res, 200, receipt(u, Math.max(1, Math.min(366, parseInt(url.searchParams.get('days'), 10) || 30))));
  if (route === 'POST /api/posts') return send(res, 200, { post: postView(doPost(u, body), u, now) });
  let m = /^\/api\/posts\/(P\d+)\/(claim|handover|close|remove|chill)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    sweep();
    const post = db.posts.find(x => x.id === m[1]); if (!post) throw bad('That post no longer exists.', 404);
    if (m[2] === 'claim') { doClaim(u, post, body); return send(res, 200, { post: postView(post, u, now) }); }
    if (m[2] === 'handover') {
      const key = post.id + '|' + ip; if (throttled(key)) throw bad('Too many wrong codes. Wait 10 minutes.', 429);
      if (!doHandover(u, post, body.code, body.paidBy, body.claimId ? String(body.claimId) : null)) { failed(key); throw bad(body.claimId ? 'That delivery is not waiting for a rider.' : 'That code does not match a reservation on this post.', 400); }
      return send(res, 200, { post: postView(post, u, now) });
    }
    if (m[2] === 'chill') {
      // move unsold food to the nearest kirana chill hub: the fridge adds 8 hours, the kirana becomes the pickup point and earns ₹2 a portion sold
      if (post.giverId !== u.id) throw bad('Only the seller can move this listing.', 403);
      if (post.status !== 'open' || post.hubId) throw bad('This listing is already at a hub or no longer open.', 409);
      if (post.claims.some(c => c.status === 'held')) throw bad('Hand over the orders on the way first.', 409);
      if (post.cls === 'packed') throw bad('Sealed packets do not need chilling.', 409);
      const hub = db.hubs.filter(h => kmBetween(h, post) < 6 && h.stored + post.left <= h.capacity).sort((a, b) => kmBetween(a, post) - kmBetween(b, post))[0];
      if (!hub) throw bad('No chill hub nearby has room right now.', 409);
      const cur = priceNow(post, now); post.price = cur; post.postedAt = now;               // the price carries on from where it was, over a longer clock
      post.safeUntil += CHILL_EXTRA_MIN * MIN; post.hubId = hub.id; post.chilledAt = now; post.lat = hub.lat; post.lon = hub.lon; post.place = hub.name + ' (Seconds chill hub)';
      hub.stored += post.left; record('chilled', post.id, u, { hub: hub.name, qty: post.left, extraMinutes: CHILL_EXTRA_MIN }); save();
      return send(res, 200, { post: postView(post, u, now) });
    }
    if (m[2] === 'close') { if (post.giverId !== u.id) throw bad('Only the person who posted it can close it.', 403); if (post.claims.some(c => c.status === 'held')) throw bad('Someone has a reservation on this. Hand it over, or wait for the reservation to lapse.', 409); post.status = 'gone'; post.left = 0; record('closed', post.id, u); save(); return send(res, 200, {}); }
    if (u.role !== 'steward') throw bad('Only a moderator can remove a post.', 403);
    post.status = 'removed'; post.left = 0; post.claims.forEach(c => { if (c.status === 'held') c.status = 'released'; }); record('removed', post.id, u, { note: clean(body.note, 120) }); save(); return send(res, 200, {});
  }
  m = /^\/api\/claims\/(C\d+)\/(release|drop)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const post = db.posts.find(p => p.claims.some(c => c.id === m[1])), claim = post && post.claims.find(c => c.id === m[1]);
    if (!claim || claim.takerId !== u.id) throw bad('That is not your reservation.', 403);
    if (m[2] === 'release') { if (claim.status !== 'held') throw bad('This reservation is already finished.', 409); claim.status = 'released'; post.left += claim.qty; record('released', post.id, u, { qty: claim.qty }); save(); return send(res, 200, {}); }
    doDrop(u, post, claim, body.people, body.lat == null ? null : { lat: body.lat, lon: body.lon }); return send(res, 200, {});
  }
  if (route === 'POST /api/spots') {
    const p = point(body), name = clean(body.name, 50), kind = KINDS.includes(body.kind) ? body.kind : 'gathering', people = parseInt(body.people, 10);
    if (name.length < 3) throw bad('Give the spot a name people will recognise.');
    if (!(people >= 1 && people <= 2000)) throw bad('About how many people are usually there?');
    if (db.spots.some(s => kmBetween(s, p) < 0.08)) throw bad('There is already a spot right here. Vouch for that one instead.', 409);
    const spot = { id: 'S' + db.seq++, name, kind, people, hours: clean(body.hours, 40), lat: p.lat, lon: p.lon, addedBy: u.id, addedByName: u.name, vouches: [u.id], meals: 0, lastFedAt: null, createdAt: now };
    db.spots.push(spot); record('spot added', spot.id, u, { name, kind, people }); save(); return send(res, 200, { spot: { id: spot.id } });
  }
  m = /^\/api\/spots\/(S\d+)\/(vouch|remove)$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    const spot = db.spots.find(s => s.id === m[1]); if (!spot) throw bad('That spot no longer exists.', 404);
    if (m[2] === 'vouch') { const i = spot.vouches.indexOf(u.id); if (i < 0) spot.vouches.push(u.id); else spot.vouches.splice(i, 1); save(); return send(res, 200, {}); }
    if (u.role !== 'steward') throw bad('Only a moderator can remove a spot.', 403);
    db.spots = db.spots.filter(s => s !== spot); record('spot removed', spot.id, u, { name: spot.name }); save(); return send(res, 200, {});
  }
  return send(res, 404, { error: 'Not found.' });
}

const CSP = "default-src 'self'; script-src 'self' https://unpkg.com; worker-src blob:; child-src blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://tiles.openfreemap.org https://router.project-osrm.org https://photon.komoot.io; frame-ancestors 'none'";
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', CSP); res.setHeader('Permissions-Policy', 'geolocation=(self)');
  let url;
  try { url = new URL(req.url, 'http://x'); } catch (e) { res.writeHead(400); return res.end(); }
  if (url.pathname.startsWith('/api/')) return api(req, res, url).catch(e => send(res, e.code >= 400 && e.code < 500 ? e.code : 500, { error: e.code ? e.message : 'Something went wrong on the server.' }));
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  const ph = /^\/photos\/(P\d+-[0-2])\.jpg$/.exec(url.pathname);
  if (ph) return fs.readFile(path.join(PHOTOS, ph[1] + '.jpg'), (err, buf) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' }); res.end(buf); });
  let rel; try { rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || !TYPES[path.extname(file)]) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, (err, buf) => { if (err) { res.writeHead(404); return res.end('Not found'); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)], 'Cache-Control': 'no-cache' }); res.end(buf); });
});

if (require.main === module) {
  init();
  setInterval(sweep, 30e3).unref();
  server.listen(PORT, HOST, () => console.log(`Seconds is running at http://localhost:${PORT}` + (DEMO ? '  (demo mode: sample listings and one-tap demo accounts on this computer)' : '')));
}
module.exports = { server, init, verifyChain, sweep, bestSpot, get db() { return db; } };
