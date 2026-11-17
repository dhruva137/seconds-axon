/* End-to-end test of the server: entry, giving, reserving, the pickup code, spots, privacy and the ledger.
   Uses a throwaway data folder. Usage: node tests/api.test.js */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tminus-test-'));
process.env.SECONDS_DATA = dir;
const app = require('../server.js');
let base, passed = 0, failedN = 0;
const ok = (cond, name) => { if (cond) passed++; else { failedN++; console.log('FAIL  ' + name); } };
function client() {
  let cookie = '';
  return async (url, body, opts) => {
    const method = body === undefined ? 'GET' : 'POST';
    const headers = Object.assign({ cookie }, method === 'POST' ? { 'content-type': 'application/json', 'x-seconds': '1' } : {}, (opts || {}).headers);
    const r = await fetch(base + url, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    let json = {}; try { json = await r.json(); } catch (e) {}
    return { status: r.status, json, setCookie: set };
  };
}
const PHOTO = 'data:image/jpeg;base64,' + Buffer.alloc(600, 7).toString('base64');   // stands in for a real photo
const HERE = { lat: 48.8566, lon: 2.3522 };          // deliberately not India: the app must not assume a city
const at = (dLat, dLon) => ({ lat: HERE.lat + dLat, lon: HERE.lon + dLon });

(async () => {
  app.init();
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + app.server.address().port;
  const seed = JSON.parse(fs.readFileSync(path.join(dir, 'seed.json'), 'utf8')), pin = seed.pin, phone = n => seed.accounts.find(a => a.name === n).phone;

  // --- looking without an account
  const anon = client(), look = await anon('/api/nearby', HERE);
  ok(look.status === 200 && look.json.me === null, 'anyone can look at what is nearby');
  ok(look.json.posts.length >= 4 && look.json.spots.length >= 5, 'demo mode places sample food and spots near the viewer, wherever they are');
  ok(look.json.posts.every(p => !p.exact && p.place === null && !p.claims && Math.abs(p.lat * 400 - Math.round(p.lat * 400)) < 1e-6), 'strangers see an approximate location only');
  ok((await anon('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 10, cls: 'cooked', ...HERE })).status === 401, 'giving needs an account');
  ok((await anon('/../server.js')).status === 404 && (await anon('/..%2f..%2fserver.js')).status === 404, 'no path traversal');
  ok((await anon('/%E0%A4%A')).status === 400, 'a malformed URL does not crash the server');
  ok((await fetch(base + '/api/nearby', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status === 400, 'POST without the app header is refused (cross-site guard)');

  // --- entry
  ok(!JSON.stringify((await anon('/api/demo')).json).includes(pin), 'the demo list does not expose the PIN');
  const wrong = client();
  ok((await wrong('/api/login', { phone: phone('Asha'), pin: pin === '000000' ? '111111' : '000000' })).status === 401, 'wrong PIN refused');
  let last; for (let i = 0; i < 6; i++) last = await wrong('/api/login', { phone: phone('Moderator'), pin: '31415' + i });
  ok(last.status === 429, 'sixth wrong attempt is locked out');
  const asha = client(), li = await asha('/api/login', { phone: phone('Asha'), pin });
  ok(li.status === 200 && /HttpOnly/.test(li.setCookie) && /SameSite=Strict/.test(li.setCookie), 'PIN sign-in works, cookie is HttpOnly and SameSite=Strict');
  ok(!fs.readFileSync(path.join(dir, 'db.json'), 'utf8').includes(pin), 'PIN is not stored in the database');
  const ravi = client(), farhan = client(), mod = client();
  ok((await ravi('/api/demo-login', { phone: phone('Ravi') })).status === 200, 'demo entry works without a PIN');
  await farhan('/api/demo-login', { phone: phone('Farhan') }); await mod('/api/demo-login', { phone: phone('Moderator') });
  const nu = client();
  ok((await nu('/api/signup', { name: 'Zed', phone: '9811111111', pin: '111111' })).status === 400, 'sign-up rejects a trivial PIN');
  ok((await nu('/api/signup', { name: '<i>Zed</i>', phone: '9811111111', pin: '482913' })).status === 200, 'anyone can sign up');
  ok((await client()('/api/demo-login', { phone: '9811111111' })).status === 403, 'demo entry refuses real accounts');
  ok(!(await nu('/api/nearby', HERE)).json.me.name.includes('<'), 'markup is stripped from names');

  // --- giving
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 10, cls: 'cooked' })).status === 400, 'a post needs a location');
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 0, cls: 'cooked', ...HERE })).status === 400, 'a post needs a quantity');
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 10, cls: 'soup', ...HERE })).status === 400, 'an unknown kind of food is refused');
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 10, cls: 'cooked', cookedMinutesAgo: 130, ...HERE })).status === 409, 'food with almost no safe time left is refused');
  const exact = at(0.00123, 0.00177), made = await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 20, cls: 'cooked', note: 'Dal and rice', place: '12 Rue Test', ...exact });
  const P = made.json.post;
  ok((await asha('/api/posts', { hygiene: true, qty: 4, cls: 'packed', ...HERE })).status === 400, 'a post needs photos of the food');
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO], qty: 4, cls: 'packed', ...HERE })).status === 400, 'one photo is not enough: at least two');
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, 'data:image/jpeg;base64,AAAA'], qty: 4, cls: 'packed', ...HERE })).status === 400, 'a broken photo is refused');
  ok(P.photos.length === 2 && P.photos[1] === '/photos/' + P.id + '-1.jpg' && (await fetch(base + P.photos[1])).headers.get('content-type') === 'image/jpeg', 'the photos are stored and shown with the post');
  ok((await anon('/photos/../db.json')).status === 404, 'photos cannot reach other files');
  ok(made.status === 200 && Math.round((P.safeUntil - P.createdAt) / 60000) === 150, 'cooked food gets a 2 h 30 clock');
  ok(Math.round((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 5, cls: 'packed', ...HERE })).json.post.safeUntil / 60000 - Date.now() / 60000) === 1080, 'packed food gets an 18 h clock');

  const fruit = (await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 3, cls: 'fruit', diet: 'nonveg', ...HERE })).json.post;
  ok(fruit && Math.round((fruit.safeUntil - fruit.createdAt) / 60000) === 1440 && fruit.diet === 'nonveg', 'each food type has its own clock and a diet tag');
  await asha(`/api/posts/${fruit.id}/close`, {});

  // --- the hunger clock and the matching rule
  const hungry = app.db.spots.filter(s => s.sample)[0], others = app.db.spots.filter(s => s !== hungry);
  others.forEach(s => { s.lastFedAt = Date.now() - 30 * 60000; }); hungry.lastFedAt = Date.now() - 10 * 3600e3;
  ok(app.bestSpot(app.db.posts.find(p => p.id === P.id), Date.now()).id === hungry.id, 'food is suggested for the spot that has gone hungry longest');
  const farSpot = { id: 'Sfar', name: 'Far away', kind: 'gathering', people: 500, lat: HERE.lat + 0.3, lon: HERE.lon, vouches: [], meals: 0, lastFedAt: Date.now() - 20 * 3600e3, createdAt: 0 };
  app.db.spots.push(farSpot);
  ok(app.bestSpot(app.db.posts.find(p => p.id === P.id), Date.now()).id !== 'Sfar', 'a spot the food cannot reach in time is never suggested');
  app.db.spots.pop();
  ok((await ravi('/api/nearby', HERE)).json.posts.find(p => p.id === P.id).suggest.id === hungry.id, 'the suggestion is shown on the post');

  // --- privacy before and after reserving
  const seen = (await ravi('/api/nearby', HERE)).json.posts.find(p => p.id === P.id);
  ok(seen && !seen.exact && seen.lat !== exact.lat && seen.place === null, 'a stranger sees the post without the exact address');

  // --- reserving
  ok((await asha(`/api/posts/${P.id}/claim`, { qty: 5, ...HERE })).status === 403, 'you cannot reserve your own food');
  ok((await ravi(`/api/posts/${P.id}/claim`, { qty: 50, ...HERE })).status === 409, 'you cannot reserve more than is left');
  ok((await ravi(`/api/posts/${P.id}/claim`, { qty: 5, lat: HERE.lat + 0.6, lon: HERE.lon })).status === 409, 'someone too far to arrive inside the clock cannot reserve');
  const res1 = await ravi(`/api/posts/${P.id}/claim`, { qty: 8, ...HERE }), mine = res1.json.post;
  ok(res1.status === 200 && mine.left === 12 && /^\d{4}$/.test(mine.myClaim.code) && mine.exact && mine.lat === exact.lat && mine.place === '12 Rue Test', 'reserving gives a 4-digit code and reveals the exact address');
  ok((await ravi(`/api/posts/${P.id}/claim`, { qty: 2, ...HERE })).status === 409, 'one reservation per post');
  const giverView = (await asha('/api/nearby', HERE)).json.posts.find(p => p.id === P.id);
  ok(giverView.claims.length === 1 && giverView.claims[0].takerName === 'Ravi' && !JSON.stringify(giverView).includes('"code"'), 'the giver sees who is coming but never the code');
  ok(!JSON.stringify((await farhan('/api/nearby', HERE)).json).includes('"code"'), 'nobody else sees the code');

  // --- handover by code
  ok((await ravi(`/api/posts/${P.id}/handover`, { code: mine.myClaim.code })).status === 403, 'only the giver confirms a handover');
  ok((await asha(`/api/posts/${P.id}/handover`, { code: mine.myClaim.code === '0000' ? '1111' : '0000' })).status === 400, 'a wrong code is refused');
  const ho = await asha(`/api/posts/${P.id}/handover`, { code: mine.myClaim.code });
  ok(ho.status === 200 && ho.json.post.claims[0].status === 'collected', 'the right code completes the handover');
  ok((await asha(`/api/posts/${P.id}/handover`, { code: mine.myClaim.code })).status === 400, 'a code works once');

  // --- carrying to a spot
  const spots = (await farhan('/api/nearby', HERE)).json.spots, spot = spots.slice().sort((x, y) => Math.hypot(x.lat - HERE.lat, x.lon - HERE.lon) - Math.hypot(y.lat - HERE.lat, y.lon - HERE.lon))[0];
  const c2 = await farhan(`/api/posts/${P.id}/claim`, { qty: 12, spotId: spot.id, ...HERE });
  ok(c2.status === 200 && c2.json.post.myClaim.spotName === spot.name && c2.json.post.left === 0, 'food can be reserved to carry to a spot');
  ok((await farhan(`/api/claims/${c2.json.post.myClaim.id}/drop`, { people: 12 })).status === 409, 'cannot drop before collecting');
  await asha(`/api/posts/${P.id}/handover`, { code: c2.json.post.myClaim.code });
  ok((await ravi(`/api/claims/${c2.json.post.myClaim.id}/drop`, { people: 12 })).status === 403, 'only the carrier records the drop');
  ok((await farhan(`/api/claims/${c2.json.post.myClaim.id}/drop`, { people: 11, lat: spot.lat, lon: spot.lon })).status === 200, 'the carrier records how many people were fed');
  const after = (await farhan('/api/nearby', HERE)).json;
  ok(after.spots.find(s => s.id === spot.id).meals === 12 && after.taken === 12, 'the spot and the carrier get credit');
  ok(app.db.posts.find(p => p.id === P.id).status === 'gone', 'a post with nothing left closes itself');

  // --- limits that stop hoarding
  const a = (await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 4, cls: 'packed', ...HERE })).json.post, b = (await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 4, cls: 'packed', ...HERE })).json.post, c = (await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 4, cls: 'packed', ...HERE })).json.post;
  await ravi(`/api/posts/${a.id}/claim`, { qty: 1, ...HERE }); await ravi(`/api/posts/${b.id}/claim`, { qty: 1, ...HERE });
  ok((await ravi(`/api/posts/${c.id}/claim`, { qty: 1, ...HERE })).status === 409, 'two reservations at a time');
  const rc = app.db.posts.find(p => p.id === a.id).claims[0];
  ok((await ravi(`/api/claims/${rc.id}/release`, {})).status === 200 && app.db.posts.find(p => p.id === a.id).left === 4, 'releasing a reservation puts the food back');
  const hold = app.db.posts.find(p => p.id === b.id).claims[0]; hold.holdUntil = Date.now() - 1000; app.sweep();
  ok(hold.status === 'noshow' && app.db.posts.find(p => p.id === b.id).left === 4 && app.db.users.find(u => u.name === 'Ravi').strikes === 1, 'a no-show releases the food and costs a strike');
  let cap = 0; for (let i = 0; i < 6; i++) { cap = (await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 4, cls: 'packed', ...HERE })).status; if (cap !== 200) break; }
  ok(cap === 409 && app.db.posts.filter(p => p.giverName === 'Asha' && p.status === 'open' && !p.sample).length === 5, 'five open posts per person');

  // --- the clock is enforced by the server
  const d = (await nu('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 6, cls: 'cooked', ...HERE })).json.post, dc = (await farhan(`/api/posts/${d.id}/claim`, { qty: 6, ...HERE })).json.post.myClaim;
  app.db.posts.find(p => p.id === d.id).safeUntil = Date.now() - 1000;
  ok((await nu(`/api/posts/${d.id}/handover`, { code: dc.code })).status === 409, 'no handover after the clock runs out');
  app.sweep(); ok(app.db.posts.find(p => p.id === d.id).status === 'expired' && app.db.users.find(u => u.name === 'Farhan').strikes === 0, 'expired food is marked lost, and the taker is not blamed');

  // --- spots and moderation
  ok((await ravi('/api/spots', { name: 'Under the flyover', kind: 'gathering', people: 30, hours: 'nights', ...at(0.05, 0.05) })).status === 200, 'anyone can add a spot');
  ok((await ravi('/api/spots', { name: 'Same place again', kind: 'gathering', people: 30, ...at(0.05, 0.05) })).status === 409, 'no duplicate spot in the same place');
  const sp = app.db.spots.find(s => s.name === 'Under the flyover');
  await farhan(`/api/spots/${sp.id}/vouch`, {}); ok(sp.vouches.length === 2, 'others can vouch that people wait there');
  ok((await ravi(`/api/spots/${sp.id}/remove`, {})).status === 403 && (await mod(`/api/spots/${sp.id}/remove`, {})).status === 200, 'only a moderator removes a spot');
  ok((await ravi(`/api/posts/${c.id}/remove`, {})).status === 403 && (await mod(`/api/posts/${c.id}/remove`, {})).status === 200, 'only a moderator removes a post');
  ok((await ravi('/api/nearby', HERE)).json.ledger === undefined && (await mod('/api/nearby', HERE)).json.chain.ok, 'only the moderator sees the ledger, and its chain verifies');
  const e = app.db.ledger.find(x => x.type === 'handed over'); e.data.qty = 999;
  ok(app.verifyChain().ok === false, 'editing an old record breaks the chain');

  // --- the money: a falling price for businesses, free food for spots, paid runs, receipts
  ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 5, cls: 'packed', price: 20, ...HERE })).status === 403, 'only a business can sell food');
  const bakery = client(); await bakery('/api/demo-login', { phone: phone('Corner Bakery') });
  ok((await bakery('/api/me/settings', { upi: 'not a upi' })).status === 400 && (await bakery('/api/me/settings', { upi: 'cornerbakery@okbank' })).status === 200, 'a business can set a UPI ID, and nonsense is refused');
  ok((await bakery('/api/posts', { qty: 5, cls: 'packed', ...HERE })).status === 400, 'a post needs the safety checklist confirmed');
  const sale = (await bakery('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 20, cls: 'bakery', diet: 'egg', price: 30, ...HERE })).json.post;
  ok(sale && sale.price === 30 && sale.priceNow === 30, 'a business can sell cheap first');
  const salePost = app.db.posts.find(x => x.id === sale.id), t = Date.now();
  salePost.postedAt = t - 100 * 60000; salePost.safeUntil = t + 110 * 60000;          // 150 min of selling window, 50 left before the free hour
  ok((await ravi('/api/nearby', HERE)).json.posts.find(x => x.id === sale.id).priceNow === 10, 'the price falls with the clock');
  const bought = (await ravi(`/api/posts/${sale.id}/claim`, { qty: 2, ...HERE })).json.post.myClaim;
  ok(bought.amount === 20, 'a buyer pays the price at the time of reserving');
  ok((await ravi('/api/nearby', HERE)).json.posts.find(x => x.id === sale.id).payUpi === 'cornerbakery@okbank', 'the buyer gets the seller UPI ID to pay directly');
  const hungrySpot = app.db.spots.find(x => x.sample);
  const run = (await farhan(`/api/posts/${sale.id}/claim`, { qty: 10, spotId: hungrySpot.id, ...HERE })).json.post.myClaim;
  ok(run && run.amount === 0, 'food carried to a spot is never sold');
  await bakery(`/api/posts/${sale.id}/handover`, { code: bought.code, paidBy: 'upi' }); await bakery(`/api/posts/${sale.id}/handover`, { code: run.code });
  ok(salePost.claims.find(c => c.id === bought.id).paidBy === 'upi', 'the seller records how they were paid');
  ok((await farhan(`/api/claims/${run.id}/drop`, { people: 10, ...HERE })).status === 409, 'a drop is only recorded by someone standing at the spot');
  await farhan(`/api/claims/${run.id}/drop`, { people: 10, lat: hungrySpot.lat, lon: hungrySpot.lon });
  const ran = salePost.claims.find(c => c.id === run.id);
  ok(ran.payout >= 30 && ran.fee === Math.round(10 * 0.4 * 6), 'a run to a spot pays the carrier and bills the business per kg');
  ok((await farhan('/api/nearby', HERE)).json.earned >= ran.payout, 'carriers see what they earned');
  const giverSees = (await bakery('/api/nearby', HERE)).json.posts.find(x => x.id === sale.id);
  ok(giverSees.claims.every(c => c.reliability && 'pct' in c.reliability), 'givers see how reliable each taker is');
  const bill = (await bakery('/api/receipt?days=30')).json;
  ok(bill.totals.handed === 12 && bill.totals.kg === 4.8 && bill.totals.wasteFeeAvoided === Math.round(4.8 * 12) && bill.totals.sold === 20 && bill.totals.fee === ran.fee && bill.lines.find(l => l.id === sale.id).record, 'the business receipt adds up and points into the record');
  ok(bill.due.total === bill.due.pickupFees + Math.round(20 * 0.15), 'the statement adds pickup fees and 15% of sales');
  ok(bill.due.credits > 0 && bill.due.afterCredits === Math.max(0, Math.round(bill.due.total - Math.min(bill.due.credits, bill.due.total * 0.5))) && salePost.claims.find(c => c.id === bought.id).credits === Math.round(0.8 * (3 + 2)), 'a baker earns rescue credits that pay down at most half the fee');
  ok((await bakery('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 5, cls: 'bakery', price: 90, mrp: 60, ...HERE })).status === 400, 'the start price must be below the normal price');
  const adm = (await mod('/api/nearby', HERE)).json.admin;
  ok(adm && adm.kpis.gmv >= 20 && adm.shops.some(s => s.name === 'Corner Bakery' && s.revenue >= 20 && s.signal) && (await ravi('/api/nearby', HERE)).json.admin === undefined, 'only the admin sees every shop, the market totals and a signal per shop');
  ok((await ravi('/api/nearby', HERE)).json.saved >= 0, 'buyers see what they saved');
  const reg = (await bakery('/api/register?days=30')).json.rows;
  ok(reg.length === 2 && reg.some(r => /for /.test(r.receivedBy) && r.recipientType.startsWith('spot')) && reg.every(r => r.donor === 'Corner Bakery' && r.batch === sale.id && r.checklist === 'confirmed'), 'the donation register has one row per handover, as FSSAI asks donors to keep');
  ok((await ravi('/api/payouts')).status === 403 && (await mod('/api/payouts')).json.payouts.some(x => x.name === 'Farhan' && x.amount >= ran.payout), 'only the moderator sees what carriers are owed');
  const hall = client(); await hall('/api/demo-login', { phone: phone('Lakshmi Hall') }); await hall('/api/me/location', { ...HERE, place: 'Hall gate' });
  const sms = text => client()('/api/sms', { from: '+91' + phone('Lakshmi Hall'), text });
  ok(/^Seconds: send/.test((await sms('help')).json.reply) && /^Posted 50 cooked meals/.test((await sms('50 meal veg 20')).json.reply) && /left/.test((await sms('status')).json.reply), 'a business can post and check status by SMS');
  ok(/not registered/.test((await client()('/api/sms', { from: '9999999999', text: 'help' })).json.reply), 'SMS from unknown numbers is refused');
  ok((await client()('/api/signup', { name: 'Cafe One', phone: '9822222222', pin: '582913', kind: 'business' })).json.me.kind === 'business', 'a business can sign up');

  // --- delivery, batching, chill hubs, points and the margin on every order
  const dsale = (await bakery('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 10, cls: 'bakery', price: 40, mrp: 80, ...at(0.012, 0.01) })).json.post;
  const d1 = (await ravi(`/api/posts/${dsale.id}/claim`, { qty: 2, mode: 'delivery', ...HERE })).json.post.myClaim;
  ok(d1 && d1.mode === 'delivery' && d1.deliveryFee > d1.riderPay && d1.riderName && d1.atShopAt > Date.now(), 'a delivery order gets a rider, and the buyer fee is above the rider pay');
  const zed2 = client(); await zed2('/api/login', { phone: '9811111111', pin: '482913' });
  const d2 = (await zed2(`/api/posts/${dsale.id}/claim`, { qty: 1, mode: 'delivery', ...at(0.004, 0.002) })).json.post.myClaim;
  ok(d2 && d2.batchOf === d1.id && d2.riderName === d1.riderName && d2.riderPay === 15, 'a second order to the same shop joins the same rider for a small add-on (batching)');
  ok((await bakery(`/api/posts/${dsale.id}/handover`, { claimId: d1.id })).status === 409, 'the seller cannot hand over before the rider is at the counter');
  const dpost = app.db.posts.find(x => x.id === dsale.id); dpost.claims.forEach(c => { if (c.atShopAt) c.atShopAt = Date.now() - 1; });
  ok((await bakery(`/api/posts/${dsale.id}/handover`, { claimId: d1.id })).status === 200 && (await bakery(`/api/posts/${dsale.id}/handover`, { claimId: d2.id })).status === 200, 'the seller hands both orders to the rider');
  const e1 = dpost.claims.find(c => c.id === d1.id).econ, e2 = dpost.claims.find(c => c.id === d2.id).econ;
  ok(e1.margin > 0 && e2.margin > e1.margin - e1.commission && e1.delivery - e1.rider > 0 && app.db.users.find(u => u.name === 'Ravi').points >= 8, 'each order shows a positive margin, batching earns more, and the buyer earns points');
  dpost.claims.forEach(c => { if (c.deliverAt) c.deliverAt = Date.now() - 1; }); app.sweep();
  ok(dpost.claims.filter(c => c.mode === 'delivery').every(c => c.deliveredAt), 'deliveries complete on time');
  const csale = (await bakery('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 6, cls: 'meal', price: 50, mrp: 100, ...HERE })).json.post;
  const ch = (await bakery(`/api/posts/${csale.id}/chill`, {})).json.post;
  ok(ch && ch.hub && ch.safeUntil - csale.safeUntil === 480 * 60000 && ch.priceNow <= 50, 'moving food to a kirana chill hub adds 8 hours, keeps the price falling, and makes the kirana the pickup point');
  const admE = (await mod('/api/nearby', HERE)).json.admin.econ;
  ok(admE.orders > 0 && admE.lossOrders === 0 && admE.minMargin >= 0 && admE.batched >= 1, 'across every order the admin sees, not one lost money');

  // --- history, feed and the welcome-back digest
  const hist = (await asha('/api/nearby', HERE)).json;
  ok(hist.history.some(e => e.type === 'handed over') && hist.history.some(e => e.type === 'posted'), 'each person sees their own history');
  ok(hist.feed.length > 0 && hist.feed.filter(e => e.type === 'reserved').every(e => e.actorName === 'Someone'), 'the public feed hides who reserved food');
  app.db.users.find(u => u.name === 'Ravi').lastSeen = Date.now() - 3600e3;
  const back = await client()('/api/login', { phone: phone('Ravi'), pin });
  ok(back.status === 200 && back.json.digest && back.json.digest.handed > 0, 'signing in shows what happened nearby while you were away');

  // --- the demo story runs end to end through the real actions
  const st = client(), steps = ['start', 'spots', 'neighbour', 'carrier', 'handover', 'drop', 'lastcall', 'summary'];
  let sres; for (const s of steps) { sres = await st('/api/demo/story', { step: s, ...HERE }); if (sres.status !== 200) { console.log('story step failed', s, sres.json); break; } }
  ok(sres.status === 200 && sres.json.posted === 120 && sres.json.handed === 120 && sres.json.wasted === 0 && sres.json.spotsFed === 2 && sres.json.peopleFed === 116, 'the demo story moves 120 meals to people and two spots, nothing wasted');

  // --- live updates: an open page hears about a new post without asking
  const ctl = new AbortController(), stream = await fetch(base + '/api/events', { signal: ctl.signal }), reader = stream.body.getReader(), dec = new TextDecoder();
  ok(/event-stream/.test(stream.headers.get('content-type')), 'pages can subscribe to live updates');
  const heard = (async () => { let txt = ''; const until = Date.now() + 3000; while (Date.now() < until) { const { value, done } = await reader.read(); if (done) break; txt += dec.decode(value); if (/"type":"posted"/.test(txt)) return txt; } return txt; })();
  await nu('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 3, cls: 'fruit', ...HERE });
  const got = await heard; ctl.abort();
  ok(/"type":"posted"/.test(got) && /"actorName":"[^"]*Zed/.test(got), 'a new post reaches every open page within a moment');
  ok(/^sid_\d+=/.test(li.setCookie), 'each port keeps its own session cookie');

  await asha('/api/logout', {}); ok((await asha('/api/posts', { hygiene: true, photos: [PHOTO, PHOTO], qty: 3, cls: 'packed', ...HERE })).status === 401, 'signed out');
  console.log(`${passed} passed, ${failedN} failed`);
  app.server.close(); fs.rmSync(dir, { recursive: true, force: true });
  process.exit(failedN ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
