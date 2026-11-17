/* Seconds market: surplus food priced by the clock.
   Three kinds of people, three dashboards, one live system:
   - Seller (shop, bakery, kitchen): lists surplus with 2-3 photos; the price falls with the food clock and the last hour is free.
   - Buyer: sees what is near, getting cheaper every minute; orders, gets a pickup code, tracks the order.
   - Admin (Seconds): every shop, sales, waste, revenue, credits, and what each shop should change.
   Every action is pushed to every open page within a second (server-sent events). Talks to server.js. */
(() => {
  'use strict';
  const $ = (q, el) => (el || document).querySelector(q), $$ = (q, el) => Array.from((el || document).querySelectorAll(q));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = n => '₹' + Math.round(n || 0).toLocaleString('en-IN');
  const HERE = { lat: 12.9719, lon: 77.6412, label: 'Indiranagar' };
  const FOOD_E = { meal: '🍛', snack: '🥟', sweets: '🍬', bakery: '🥐', packed: '📦', fruit: '🍎' };
  const FOODS0 = { meal: { label: 'Cooked meals', min: 150, cooked: true }, snack: { label: 'Snacks', min: 240, cooked: true }, sweets: { label: 'Sweets', min: 480 }, bakery: { label: 'Bread and bakes', min: 720 }, packed: { label: 'Sealed packets', min: 1080 }, fruit: { label: 'Fruit and veg', min: 1440 } };
  const DIET = { veg: 'Veg', egg: 'Egg', nonveg: 'Non-veg' };
  const st = { q: '', mode: 'pickup', econ: null, me: null, d: null, demo: null, skew: 0, byId: new Map(), seen: null, open: null, sheet: null, filter: 'all', sort: 'deal', veg: false, sell: null, dirty: false };
  const now = () => Date.now() + st.skew;
  const foods = () => (st.d && st.d.foods) || FOODS0;
  const role = () => !st.me ? 'guest' : st.me.role === 'steward' ? 'admin' : st.me.kind === 'business' ? 'seller' : 'buyer';

  /* ---------- time ---------- */
  const clock = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  function left(ms) {
    if (ms <= 0) return 'expired';
    const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return h ? h + 'h ' + String(m).padStart(2, '0') + 'm' : m + ':' + String(x).padStart(2, '0');
  }
  const mins = m => m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60 ? m % 60 + ' min' : '') : Math.round(m) + ' min';
  function km(a, b) { const r = Math.PI / 180, x = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lon - a.lon) * r / 2) ** 2; return 12742 * Math.asin(Math.sqrt(x)) * 1.3; }
  const dist = p => { const k = km(HERE, p); return k < 1 ? Math.max(100, Math.round(k * 10) * 100) + ' m' : k.toFixed(1) + ' km'; };

  /* ---------- the price signal: same rule as the server. Falls in ₹5 steps with the clock, free in the last hour ---------- */
  function priceAt(p, t) {
    if (!p.price) return 0;
    const a = p.postedAt || p.createdAt, b = p.freeAt;
    if (t >= b || b <= a) return 0;
    const v = Math.round(p.price * (b - t) / (b - a) / 5) * 5;
    return v < 5 ? 0 : Math.min(p.price, v);
  }
  function nextDrop(p, t) {
    const cur = priceAt(p, t); if (!cur) return null;
    const a = p.postedAt || p.createdAt, b = p.freeAt, at = b - (cur - 2.5) / p.price * (b - a);
    return { at: Math.max(t, at), to: priceAt(p, Math.max(t, at) + 1000) };
  }
  const ref = p => p.mrp || p.price || 0;
  // the same delivery rules as the server: the buyer's fee is never below 1.1 × what the rider is paid
  const RIDER_PAY = k => Math.round(30 + 7 * k), DELIVERY_FEE = k => Math.max(35, Math.round(27 + 8 * k), Math.ceil(RIDER_PAY(k) * 1.1)), PLATFORM_FEE = 4;
  const offPct = (p, t) => { const r = ref(p); return r ? Math.round((1 - priceAt(p, t) / r) * 100) : 100; };
  function advice(p, t) {
    const cur = priceAt(p, t), nx = nextDrop(p, t);
    if (p.left <= 0) return { k: 'gone', t: 'Sold out' };
    if (!cur) return { k: 'free', t: 'FREE now · grab it before the clock runs out' };
    if (p.left <= 3) return { k: 'buy', t: 'BUY NOW · only ' + p.left + ' left' };
    if (nx && nx.at - t < 5 * 60e3 && p.left > 6) return { k: 'wait', t: 'WAIT · drops to ' + inr(nx.to) + ' in ' + left(nx.at - t) };
    return { k: 'buy', t: 'GOOD DEAL · ' + offPct(p, t) + '% below normal price' };
  }

  /* price chart: the step-down from listing to free, the normal price, and where we are now */
  function chart(p, w, h) {
    w = w || 320; h = h || 104;
    const a = p.postedAt || p.createdAt, b = p.safeUntil, top = Math.max(ref(p), p.price, 5), X = t => 8 + (t - a) / (b - a) * (w - 16), Y = v => h - 22 - v / top * (h - 36);
    let d = '', last = null;
    for (let i = 0; i <= 160; i++) { const t = a + (b - a) * i / 160, v = priceAt(p, t); d += (d ? (last !== v ? 'L' + X(t).toFixed(1) + ' ' + Y(last).toFixed(1) + 'L' : 'L') : 'M') + X(t).toFixed(1) + ' ' + Y(v).toFixed(1); last = v; }
    const t = Math.min(b, Math.max(a, now())), fx = X(p.price ? p.freeAt : a);
    return `<svg class="chart" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price falls from ${inr(p.price)} to free by ${clock(p.freeAt)}">
      <rect x="${fx.toFixed(1)}" y="6" width="${Math.max(0, X(b) - fx).toFixed(1)}" height="${h - 28}" rx="6" class="freez"/><text x="${((fx + X(b)) / 2).toFixed(1)}" y="20" class="freet">FREE</text>
      ${p.mrp ? `<line x1="8" x2="${w - 8}" y1="${Y(p.mrp)}" y2="${Y(p.mrp)}" class="mrpl"/><text x="${w - 10}" y="${Y(p.mrp) - 4}" class="mrpt">normal ${inr(p.mrp)}</text>` : ''}
      <path d="${d}" class="pl"/>
      <line x1="${X(t)}" x2="${X(t)}" y1="6" y2="${h - 22}" class="nowl"/><circle cx="${X(t)}" cy="${Y(priceAt(p, t))}" r="4.5" class="nowd"/>
      <text x="8" y="${h - 6}" class="ax">${clock(a)}</text>${p.price ? `<text x="${fx}" y="${h - 6}" class="ax" text-anchor="middle">${clock(p.freeAt)}</text>` : ''}<text x="${w - 8}" y="${h - 6}" class="ax" text-anchor="end">${clock(b)}</text></svg>`;
  }

  /* ---------- server ---------- */
  async function api(path, body) {
    const post = body !== undefined;
    const r = await fetch(path, { method: post ? 'POST' : 'GET', credentials: 'same-origin', headers: post ? { 'content-type': 'application/json', 'x-seconds': '1' } : {}, body: post ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
    return j;
  }
  let busy = null;
  function refresh() {
    if (busy) return busy;
    busy = (async () => {
      try {
        const d = await api('/api/nearby', { lat: HERE.lat, lon: HERE.lon });
        st.skew = d.now - Date.now(); st.d = d; st.me = d.me;
        const ids = new Set(d.posts.map(p => p.id)); st.fresh = st.seen ? new Set([...ids].filter(x => !st.seen.has(x))) : new Set(); st.seen = ids;
        st.byId = new Map(d.posts.map(p => [p.id, p]));
        render();
      } catch (e) { toast(e.message, 'bad'); } finally { busy = null; }
    })();
    return busy;
  }
  function toast(msg, kind) {
    const el = document.createElement('div'); el.className = 'toast ' + (kind || ''); el.innerHTML = msg; $('#toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), 3800); setTimeout(() => el.remove(), 4300);
  }

  /* ---------- pieces ---------- */
  const photo = (p, cls) => p.photo ? `<img class="${cls || ''}" src="${esc(p.photo)}" alt="Photo of ${esc(p.note || 'the food')}" loading="lazy">` : `<div class="noph ${cls || ''}"><span>${FOOD_E[p.cls] || '🍽️'}</span><small>sample listing · no photo</small></div>`;
  const dietDot = d => `<i class="diet ${d || 'veg'}" title="${DIET[d] || 'Veg'}"></i>`;
  const title = p => esc(p.note || (foods()[p.cls] || {}).label || 'Food');
  const isBaker = p => p.cls === 'bakery';
  function card(p) {
    return `<button class="lc${st.fresh && st.fresh.has(p.id) ? ' new' : ''}" data-act="open" data-id="${p.id}">
      <div class="lc-ph">${photo(p)}<span class="off" data-off="${p.id}"></span><span class="clk" data-left="${p.id}"></span>${p.photos && p.photos.length > 1 ? '<span class="cnt">📷 ' + p.photos.length + '</span>' : ''}</div>
      <div class="lc-bd"><div class="lc-t">${dietDot(p.diet)}${title(p)}</div>
        <div class="lc-s">${esc(p.giverName)}${isBaker(p) ? ' <em class="tag baker">baker</em>' : ''} · ${dist(p)}</div>
        <div class="lc-p"><b data-price="${p.id}"></b>${ref(p) ? '<s>' + inr(ref(p)) + '</s>' : ''}<span class="qty">${p.left} left</span></div>
        <div class="sig" data-sig="${p.id}"></div>
        <div class="life"><i data-bar="${p.id}"></i></div></div></button>`;
  }
  function riderPhase(c, t) {
    if (c.mode !== 'delivery') return null;
    if (c.deliveredAt || (c.deliverAt && t >= c.deliverAt)) return { k: 'delivered', f: 1 };
    if (c.status === 'collected') return { k: 'toBuyer', f: (t - c.collectedAt) / Math.max(1, c.deliverAt - c.collectedAt), eta: c.deliverAt };
    if (c.status !== 'held') return { k: 'ended', f: 0 };
    if (t < c.atShopAt) return { k: 'toShop', f: (t - c.createdAt) / Math.max(1, c.atShopAt - c.createdAt), eta: c.atShopAt };
    return { k: 'atShop', f: 1 };
  }
  const PHASE = { toShop: '🛵 heading to shop', atShop: '🏪 at the counter', toBuyer: '🛵 on the way', delivered: '✓ delivered', ended: 'cancelled' };
  function tracker(p, c) {
    const t = now(), ended = ['released', 'noshow', 'expired'].includes(c.status);
    let steps;
    if (c.mode === 'delivery') {
      const ph = riderPhase(c, t).k, order = ['toShop', 'atShop', 'toBuyer', 'delivered'], at = order.indexOf(ph);
      steps = [
        { k: 'Ordered and paid', s: 'price locked at ' + (c.price ? inr(c.price) : 'free'), at: c.createdAt, ok: true },
        { k: 'Rider ' + esc(c.riderName) + (c.batchOf ? ' (already heading there)' : ' assigned'), s: ph === 'toShop' ? 'reaches ' + esc(p.giverName) + ' in <b data-eta="' + c.atShopAt + '"></b>' : '', ok: at > 0, now: ph === 'toShop' },
        { k: 'At ' + esc(p.giverName) + "'s counter", s: ph === 'atShop' ? 'the shop scans the order and hands it over' : '', at: at > 0 ? c.atShopAt : null, ok: at > 1, now: ph === 'atShop' },
        { k: 'Picked up · on the way to you', s: ph === 'toBuyer' ? 'arrives in <b data-eta="' + c.deliverAt + '"></b> · safe till ' + clock(p.safeUntil) : '', at: c.collectedAt, ok: at > 2, now: ph === 'toBuyer' },
        { k: 'Delivered', s: at > 2 ? 'give the rider code ' + esc(c.code) : '', at: at === 3 ? (c.deliveredAt || c.deliverAt) : null, ok: at === 3 }
      ];
    } else {
      const done = c.status === 'collected';
      steps = [
        { k: 'Ordered', s: 'price locked at ' + (c.price ? inr(c.price) : 'free'), at: c.createdAt, ok: true },
        { k: 'Ready at ' + esc(p.giverName), s: done || ended ? '' : 'show code ' + esc(c.code || '') + ' · hold ends ' + clock(c.holdUntil), ok: done, now: c.status === 'held' },
        { k: 'Picked up', s: done ? 'code checked' + (c.paidBy && c.amount ? ' · paid by ' + esc(String(c.paidBy).toUpperCase()) : '') : '', at: c.collectedAt, ok: done }
      ];
    }
    if (ended) steps.push({ k: c.status === 'released' ? 'Cancelled' : c.status === 'noshow' ? 'Not collected in time' : 'Food clock ran out', s: 'the food went back on the market', ok: true, bad: true });
    return `<ol class="track">${steps.map(x => `<li class="${x.ok ? 'ok' : ''}${x.now ? ' now' : ''}${x.bad ? ' bad' : ''}"><i></i><div><b>${x.k}</b>${x.s ? '<small>' + x.s + '</small>' : ''}</div>${x.at ? '<time>' + clock(x.at) + '</time>' : ''}</li>`).join('')}</ol>`;
  }

  function evText(e) {
    const d = e.data || {}, a = '<b>' + esc(e.actorName) + '</b>';
    switch (e.type) {
      case 'posted': return '🆕 ' + a + ' listed ' + d.qty + ' · ' + esc(String(d.food || 'food').toLowerCase()) + (d.price ? ' from ' + inr(d.price) : ' free');
      case 'reserved': return (d.mode === 'delivery' ? '🛵 Someone ordered ' + d.qty + ' for delivery' + (d.batched ? ' · batched onto ' + esc(d.rider) + "'s run" : ' · rider ' + esc(d.rider || '')) : '🛒 Someone ordered ' + d.qty + ' to pick up') + (d.amount ? ' · ' + inr(d.amount) : ' · free');
      case 'rider at shop': return '🏪 Rider <b>' + esc(d.rider) + '</b> reached ' + esc(d.shop);
      case 'delivered': return '✅ ' + esc(d.rider) + ' delivered ' + d.qty + ' to ' + esc(d.to) + (d.minutesLeft != null ? ' · ' + mins(d.minutesLeft) + ' of safe time to spare' : '');
      case 'chilled': return '🧊 ' + a + ' moved ' + d.qty + ' portions to ' + esc(d.hub) + ' (+8 h on the clock)';
      case 'handed over': return '🤝 ' + a + ' handed ' + d.qty + (d.mode === 'delivery' ? ' to rider ' + esc(d.rider) + ' for ' + esc(d.to) : ' to ' + esc(d.to)) + (d.paid ? ' · ' + inr(d.paid) + ' paid' : '') + (d.credits ? ' · +' + inr(d.credits) + ' credits' : '') + (role() === 'admin' && d.margin != null ? ' · Seconds +' + inr(d.margin) : '');
      case 'expired': return '⌛ ' + d.lost + ' portions ran out of time';
      case 'released': return '↩️ ' + a + ' cancelled an order';
      case 'removed': return '🚫 Admin removed a listing';
      case 'closed': return '✔️ ' + a + ' ended a listing';
      case 'dropped at spot': return '✅ ' + a + ' fed ' + d.people + ' people at ' + esc(d.spot);
      default: return '• ' + a + ' ' + esc(e.type);
    }
  }

  /* ---------- pages ---------- */
  function topbar() {
    const r = role(), label = { seller: 'Seller', buyer: 'Buyer', admin: 'Admin', guest: '' }[r];
    return `<header class="top"><div class="brand"><svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="4"/><circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-dasharray="56 100" transform="rotate(-90 16 16)"/></svg>Seconds</div>
      ${label ? `<span class="rolepill ${r}">${label}</span>` : ''}<span class="live"><i></i>LIVE <b data-clock></b></span>
      ${st.me ? `<button class="me" data-act="logout" title="Sign out">${esc(r === 'admin' ? 'Seconds Admin' : st.me.name)} ⎋</button>` : ''}</header>`;
  }
  function render() {
    const a = document.activeElement;
    if (a && a.closest && a.closest('#root') && /INPUT|SELECT|TEXTAREA/.test(a.tagName) && a.value) { st.dirty = true; return; }   // never wipe what someone is typing
    st.dirty = false;
    const r = role();
    document.body.dataset.role = r;
    $('#root').innerHTML = topbar() + '<main class="wrap">' + (r === 'seller' ? sellerPage() : r === 'buyer' ? buyerPage() : r === 'admin' ? adminPage() : guestPage()) + '</main>';
    if (st.sheet === 'post') renderPost();
    tick(true); mountMaps();
  }

  function guestPage() {
    const demo = st.demo && st.demo.demo, E = st.econ && st.econ.scenarios, base = E && E[0], flat = E && E.find(s => /Flat/.test(s.name));
    return `<section class="hero"><span class="eyebrow"><i></i>Live in ${esc(HERE.label)}</span><h1>Surplus food,<br><em>priced by the clock.</em></h1>
      <p>Shops list what is left with real photos. The price falls every few minutes as the food clock runs down, and the last hour is free. People nearby eat well for less, a rider brings it in minutes, and nothing goes in the bin.</p>
      <div class="steps"><div><b>1</b><span><em>Sell</em> A bakery lists 12 mini pizzas with photos. ₹40, falling.</span></div><div><b>2</b><span><em>Order</em> Someone nearby orders at ₹35, picks up or gets it delivered.</span></div><div><b>3</b><span><em>Track</em> Live map, pickup codes, every step sealed in a record.</span></div></div>
      ${base ? `<div class="proof"><div><b>${base.orders}</b><span>orders a day per zone (simulated)</span></div><div><b>${flat ? flat.waste + '% → ' + base.waste + '%' : base.waste + '%'}</b><span>waste vs a flat discount</span></div><div><b>${base.lossOrdersPct}%</b><span>orders that lose money</span></div></div>` : ''}
      ${demo ? `<div class="pick"><button class="btn go" data-act="demo" data-name="Ravi">🍽️ I'm hungry <small>Buyer</small></button><button class="btn" data-act="demo" data-name="Corner Bakery">🥐 I have extra food <small>Seller</small></button><button class="btn" data-act="demo" data-name="Moderator">📊 Seconds admin <small>Admin</small></button></div>
        <p class="fine">One-tap demo accounts work only on the computer running the server. Or sign in below.</p>` : ''}
      <div class="auth"><form class="card form" data-form="login"><h3>Sign in</h3><input class="in" name="phone" inputmode="tel" placeholder="10-digit phone" required><input class="in" name="pin" type="password" inputmode="numeric" placeholder="6-digit PIN" required><p class="err"></p><button class="btn go" type="submit">Sign in</button></form>
      <form class="card form" data-form="signup"><h3>New here?</h3><input class="in" name="name" placeholder="Your name or shop name" required><input class="in" name="phone" inputmode="tel" placeholder="10-digit phone" required><input class="in" name="pin" type="password" inputmode="numeric" placeholder="Choose a 6-digit PIN" required>
        <select class="in" name="kind"><option value="person">I want to buy food</option><option value="business">I sell surplus food (shop, bakery, kitchen)</option></select><p class="err"></p><button class="btn" type="submit">Join</button></form></div></section>`;
  }

  /* buyer */
  const matches = p => { const q = (st.q || '').trim().toLowerCase(); return !q || [p.note, p.giverName, (foods()[p.cls] || {}).label, p.hub].join(' ').toLowerCase().includes(q); };
  function buyerList() {
    const d = st.d, t = now();
    let list = d.posts.filter(p => p.status === 'open' && p.left > 0 && !p.mine && p.safeUntil > t && !(p.myClaim && p.myClaim.status === 'held'));
    const fl = { all: () => true, free: p => priceAt(p, t) === 0, u20: p => priceAt(p, t) <= 20, u50: p => priceAt(p, t) <= 50 }[st.filter];
    list = list.filter(p => fl(p) && (!st.veg || p.diet === 'veg') && matches(p));
    list.sort(st.sort === 'deal' ? (a, b) => offPct(b, t) - offPct(a, t) : st.sort === 'soon' ? (a, b) => a.safeUntil - b.safeUntil : (a, b) => km(HERE, a) - km(HERE, b));
    return list;
  }
  function gridHtml() { const list = buyerList(); return list.length ? list.map(card).join('') : `<div class="empty">${st.q ? 'Nothing matches "' + esc(st.q) + '" right now.' : 'Nothing matches right now.'} New food appears here the moment a shop lists it.</div>`; }
  function buyerPage() {
    const d = st.d, t = now();
    const mine = d.posts.filter(p => p.myClaim && (p.myClaim.status === 'held' || (p.myClaim.collectedAt && t - p.myClaim.collectedAt < 3 * 3600e3)));
    const chip = (k, v, l) => `<button class="chip ${st[k] === v ? 'on' : ''}" data-act="set" data-k="${k}" data-v="${v}">${l}</button>`;
    const tr = d.trending || [];
    return `<div class="hello"><h1>Hungry, ${esc(st.me.name.split(' ')[0])}?</h1><p>Surplus food near ${esc(HERE.label)}, cheaper every minute. Last hour is free.</p></div>
      <div class="kpis small"><div><b>${buyerList().length}</b><span>deals near you</span></div><div class="cr"><b>${inr(d.saved)}</b><span>you saved</span></div><div><b>${d.points || 0}</b><span>points · redeem later</span></div></div>
      ${mine.length ? `<h2 class="sec">Your orders</h2>${mine.map(orderCard).join('')}` : ''}
      <div class="search"><span>🔎</span><input class="in" id="q" type="search" placeholder="Search pizza, biryani, croissant, a shop…" value="${esc(st.q || '')}" autocomplete="off"></div>
      ${tr.length ? `<div class="trend"><span>🔥 Ordered most near you</span>${tr.map(x => `<button class="chip" data-act="q" data-v="${esc(x.name)}">${FOOD_E[x.cls] || '🍽️'} ${esc(x.name)} <b>${x.qty}</b></button>`).join('')}</div>` : ''}
      <div class="filters">${chip('filter', 'all', 'All')}${chip('filter', 'free', 'Free now')}${chip('filter', 'u20', 'Under ₹20')}${chip('filter', 'u50', 'Under ₹50')}<button class="chip ${st.veg ? 'on' : ''}" data-act="veg">${dietDot('veg')} Veg</button>
        <span class="sortby">Sort ${chip('sort', 'deal', 'Best deal')}${chip('sort', 'soon', 'Ending soon')}${chip('sort', 'near', 'Nearest')}</span></div>
      <div class="grid" id="grid">${gridHtml()}</div>`;
  }
  function bill(p, c) {
    const fee = c.mode === 'delivery' ? c.deliveryFee : 0, plat = c.amount ? 4 : 0, total = c.amount + fee + plat;
    return `<div class="billrow"><span>${c.qty} × ${c.price ? inr(c.price) : 'free'}</span><span>${c.amount ? inr(c.amount) : 'FREE'}</span></div>${plat ? `<div class="billrow"><span>Platform fee</span><span>${inr(plat)}</span></div>` : ''}${fee ? `<div class="billrow"><span>Delivery (${c.km} km${c.batchOf ? ', shared rider' : ''})</span><span>${inr(fee)}</span></div>` : ''}
      <div class="billrow tot"><span>${c.mode === 'delivery' ? 'Paid by UPI' : c.status === 'held' && total ? 'Pay at pickup' : 'Total'}</span><span>${total ? inr(total) : 'FREE'}</span></div>${ref(p) ? `<div class="billrow save"><span>You save vs ${inr(ref(p))} each</span><span>${inr((ref(p) - c.price) * c.qty)}</span></div>` : ''}`;
  }
  function orderCard(p) {
    const c = p.myClaim, dl = c.mode === 'delivery', live = c.status === 'held' || (dl && !c.deliveredAt && !(c.deliverAt && now() >= c.deliverAt));
    return `<div class="card order${dl ? ' dl' : ''}"><div class="order-h"><button class="thumb" data-act="open" data-id="${p.id}">${photo(p)}</button><div><b>${title(p)}</b><small>${esc(p.giverName)} · ${esc(p.place || 'pickup point')} · ${dist(p)}</small></div>
      ${!dl && c.status === 'held' ? `<div class="code" title="Pickup code">${esc(c.code)}</div>` : dl ? `<span class="pill ${live ? 'on' : 'ok'}" data-phase="${c.id}"></span>` : '<span class="done">✓ picked up</span>'}</div>
      ${live ? `<div data-omap="${c.id}" class="omap-ph"></div>` : ''}
      <div class="ocols"><div>${tracker(p, c)}</div><div class="bill">${bill(p, c)}</div></div>
      ${!dl && c.status === 'held' ? `<div class="row"><span class="mute">Collect within <b data-hold="${c.holdUntil}"></b>${p.payUpi && c.amount ? ` · <a href="upi://pay?pa=${encodeURIComponent(p.payUpi)}&pn=${encodeURIComponent(p.giverName)}&am=${c.amount + 4}&cu=INR&tn=${encodeURIComponent('Seconds ' + p.id)}">Pay by UPI</a>` : ''}</span><button class="btn sm ghost" data-act="release" data-id="${c.id}">Cancel</button></div>` : ''}</div>`;
  }

  /* seller */
  function sellerPage() {
    const d = st.d, b = d.business || {}, due = b.due || {};
    const posts = d.posts.filter(p => p.mine), live = posts.filter(p => p.status === 'open'), ended = posts.filter(p => p.status !== 'open').slice(0, 6);
    const waiting = posts.flatMap(p => (p.claims || []).filter(c => c.status === 'held').map(c => ({ p, c })));
    const outNow = posts.flatMap(p => (p.claims || []).filter(c => c.mode === 'delivery' && c.status === 'collected' && !c.deliveredAt).map(c => ({ p, c })));
    return `<div class="hello"><h1>${esc(st.me.name)}</h1><p>Sell surplus before it becomes waste. Your price drops with the clock; the last hour goes free.</p></div>
      <button class="btn go big" data-act="sell">＋ Sell surplus food</button>
      <div class="kpis"><div class="hi"><b>${inr(b.sold)}</b><span>sales · 30 days</span></div><div><b>${inr(b.keep)}</b><span>you keep after 15%</span></div><div class="cr"><b>${inr(b.credits)}</b><span>rescue credits</span></div><div><b>${b.kg || 0} kg</b><span>kept out of the bin</span></div></div>
      ${waiting.length ? `<h2 class="sec">Orders to hand over <span class="badge">${waiting.length}</span></h2>${waiting.map(({ p, c }) => c.mode === 'delivery' ? riderCard(p, c) : `<form class="card pickup" data-form="handover" data-id="${p.id}"><div class="order-h"><div class="thumb">${photo(p)}</div><div><b>🚶 ${esc(c.takerName)} · ${c.qty} × ${title(p)}</b><small>Pickup · ${c.amount ? inr(c.amount) + ' to collect' : 'free'} · arriving in ~${c.etaMin} min · ${c.reliability && c.reliability.pct != null ? c.reliability.pct + '% reliable' : 'new buyer'}</small></div></div>
        <div class="row"><input class="in code-in" name="code" inputmode="numeric" maxlength="4" pattern="\\d{4}" placeholder="Code" required aria-label="Pickup code">${c.amount ? '<select class="in" name="paidBy"><option value="upi">Paid UPI</option><option value="cash">Paid cash</option></select>' : ''}<button class="btn go" type="submit">Hand over</button></div><p class="err"></p></form>`).join('')}` : ''}
      ${outNow.length ? `<h2 class="sec">Out for delivery</h2><div class="card">${outNow.map(({ p, c }) => `<div class="lrow"><b>🛵 ${esc(c.riderName)} → ${esc(c.takerName)} · ${c.qty} × ${title(p)}</b><span>arrives in <b data-eta="${c.deliverAt}"></b></span></div>`).join('')}</div>` : ''}
      <h2 class="sec">Live listings <span class="badge">${live.length}</span></h2>
      ${live.length ? '<div class="mylist">' + live.map(myListing).join('') + '</div>' : '<div class="empty">Nothing listed. Tap "Sell surplus food" when you have extra.</div>'}
      <div class="card credits"><h3>🌱 Rescue credits: ${inr(b.credits)}</h3><p>Every kg that leaves as food instead of waste earns credits: <b>₹3/kg sold</b>, <b>₹6/kg given free</b>, <b>+₹2/kg for bakers</b>. Credits pay up to half of your Seconds fee.</p>
        <table class="money"><tr><td>Seconds fee this month (15% of sales)</td><td>${inr(due.total)}</td></tr><tr><td>Credits applied (up to 50%)</td><td>− ${inr((due.total || 0) - (due.afterCredits || 0))}</td></tr><tr class="total"><td>You pay Seconds</td><td>${inr(due.afterCredits)}</td></tr><tr class="save"><td>Dumping charge avoided (up to ₹12/kg)</td><td>${inr(b.wasteFeeAvoided)}</td></tr></table></div>
      ${ended.length ? `<h2 class="sec">Earlier today</h2><div class="card">${ended.map(p => { const got = (p.claims || []).filter(c => c.status === 'collected'); return `<div class="lrow"><b>${title(p)}</b><span>${got.reduce((a, c) => a + c.qty, 0)}/${p.qty} sold · you got ${inr(got.reduce((a, c) => a + (c.econ ? c.econ.sellerNet : c.amount), 0))}${p.status === 'expired' && p.left ? ' · <em class="bad">' + p.left + ' wasted</em>' : ''}</span></div>`; }).join('')}</div>` : ''}`;
  }
  function riderCard(p, c) {
    return `<div class="card pickup dl"><div class="order-h"><div class="thumb">${photo(p)}</div><div><b>🛵 Delivery for ${esc(c.takerName)} · ${c.qty} × ${title(p)}</b><small>Rider ${esc(c.riderName)}${c.batchOf ? ' · same run as another order' : ''} · ${c.amount ? inr(c.amount) + ' paid in the app' : 'free'}</small></div></div>
      <div class="row"><span class="mute" data-riderwait="${c.atShopAt}"></span><button class="btn go" data-act="torider" data-id="${p.id}" data-claim="${c.id}" data-at="${c.atShopAt}">Hand to rider</button></div></div>`;
  }
  function myListing(p) {
    const got = (p.claims || []).filter(c => c.status === 'collected'), held = (p.claims || []).filter(c => c.status === 'held');
    const net = got.reduce((a, c) => a + (c.econ ? c.econ.sellerNet : c.amount * 0.85), 0), cred = got.reduce((a, c) => a + (c.credits || 0), 0);
    const canChill = !p.hub && !held.length && p.cls !== 'packed' && p.left > 0;
    return `<div class="card ml"><div class="ml-h"><button class="thumb" data-act="open" data-id="${p.id}">${photo(p)}</button><div class="ml-t"><b>${title(p)}</b><small>${p.left} of ${p.qty} left · ${held.length} on the way · listed ${clock(p.postedAt)}${p.hub ? ' · <em class="tag hub">🧊 ' + esc(p.hub) + '</em>' : ''}</small></div>
      <div class="ml-p"><b data-price="${p.id}"></b><span class="sig" data-sig="${p.id}"></span></div></div>
      ${chart(p, 340, 96).replace('class="chart"', `class="chart" data-chart="${p.id}"`)}
      <div class="row"><span class="mute">You got ${inr(net)} · credits ${inr(cred)} · safe <b data-left="${p.id}"></b></span>${canChill ? `<button class="btn sm" data-act="chill" data-id="${p.id}" title="Move to the nearest kirana fridge: +8 h, ₹3 a portion sold">🧊 Chill hub +8 h</button>` : ''}${held.length ? '' : `<button class="btn sm ghost" data-act="close" data-id="${p.id}">End</button>`}</div></div>`;
  }

  /* admin */
  function waterfall(e) {
    const rows = [['Commission (15%)', e.commission, '+'], ['Platform fee (₹4 paid orders)', e.platformFee, '+'], ['Delivery fees', e.delivery, '+'], ['Rider pay', -e.rider, '−'], ['Kirana hub share', e.hubSeconds, '+'], ['CSR for free meals', e.csr, '+'], ['Points (redeem later)', -e.pointsCost, '−'], ['Credits used', -e.creditsCost, '−']];
    const max = Math.max(1, ...rows.map(r => Math.abs(r[1])), e.margin);
    return `<div class="wf">${rows.map(([k, v]) => `<div class="wfr"><span>${k}</span><i class="${v < 0 ? 'neg' : 'pos'}" style="width:${(Math.abs(v) / max * 100).toFixed(1)}%"></i><b class="${v < 0 ? 'bad' : ''}">${v < 0 ? '−' : '+'}${inr(Math.abs(v))}</b></div>`).join('')}
      <div class="wfr tot"><span>Seconds keeps</span><i class="pos" style="width:${(Math.max(0, e.margin) / max * 100).toFixed(1)}%"></i><b>${inr(e.margin)}</b></div></div>`;
  }
  function stressPanel() {
    const E = st.econ; if (!E) return '';
    const S = E.scenarios, base = S[0], lines = base.lines, keys = [['commission', 'Commission'], ['platformFee', 'Platform fee'], ['csr', 'CSR'], ['plan', 'Seller plan'], ['deliveryNet', 'Delivery net'], ['hubs', 'Hub share']];
    const totalIn = keys.reduce((a, [k]) => a + Math.max(0, lines[k]), 0);
    return `<h2 class="sec">Stress test · ${E.runsPerScenario} simulated days per scenario</h2>
      <div class="card"><p class="mute" style="margin:0 0 8px">Where a zone's daily money comes from (base case): in ${inr(totalIn)}, out ${inr(-lines.fixed - lines.points - lines.credits)}.</p>
        <div class="stack">${keys.map(([k, l], i) => `<i style="flex:${Math.max(0, lines[k])};--h:${i}" title="${l}: ${inr(lines[k])}"><span>${l}<b>${inr(lines[k])}</b></span></i>`).join('')}</div>
        <div class="tbl"><table><thead><tr><th>Scenario</th><th>Orders/day</th><th>Profit/day after fixed costs</th><th>Worst 5% of days</th><th>Profitable days</th><th>Loss-making orders</th><th>Waste</th><th>Rider ₹/h</th></tr></thead><tbody>
        ${S.map(s => `<tr class="${s.lossOrdersPct > 0 ? 'warnrow' : ''}"><td>${esc(s.name)}</td><td>${s.orders}</td><td class="${s.ebitda < 0 ? 'bad' : 'okc'}">${s.ebitda < 0 ? '−' : ''}${inr(Math.abs(s.ebitda))}</td><td class="${s.ebitdaP5 < 0 ? 'bad' : ''}">${s.ebitdaP5 < 0 ? '−' : ''}${inr(Math.abs(s.ebitdaP5))}</td><td><span class="meter"><i style="width:${s.profitableDays}%"></i></span>${s.profitableDays}%</td><td class="${s.lossOrdersPct ? 'bad' : 'okc'}">${s.lossOrdersPct}%</td><td>${s.waste}%</td><td>${inr(s.riderHour)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }
  function adminPage() {
    const d = st.d, A = d.admin || { kpis: {}, shops: [] }, k = A.kpis, e = A.econ || {}, t = now();
    const live = d.posts.filter(p => p.status === 'open' && p.left > 0 && p.safeUntil > t).sort((a, b) => a.safeUntil - b.safeUntil);
    const sig = A.shops.filter(s => s.level !== 'ok');
    const tile = (v, l, c) => `<div class="${c || ''}"><b>${v}</b><span>${l}</span></div>`;
    return `<div class="hello"><h1>Seconds Admin</h1><p>Every shop, rider and kirana hub in ${esc(HERE.label)}, live. Totals for the last ${A.days || 7} days.</p></div>
      <div class="kpis">${tile(inr(k.gmv), 'food sold (GMV)', 'hi')}${tile(inr(e.margin || 0), 'Seconds kept (all lines)', 'cr')}${tile(e.orders ? inr(e.perOrder) : '–', 'per order')}${tile((e.lossOrders || 0) + ' of ' + (e.orders || 0), 'orders that lost money', e.lossOrders ? 'bad' : '')}
        ${tile(k.kg + ' kg', 'rescued from the bin')}${tile(k.wasteRate + '%', 'waste rate', k.wasteRate > 25 ? 'bad' : '')}${tile(e.deliveries ? Math.round(e.batched / e.deliveries * 100) + '%' : '–', 'deliveries batched')}${tile(inr(e.riderEarned || 0), 'riders earned')}${tile(inr(k.buyerSaved), 'buyers saved')}${tile(inr(k.credits), 'credits issued')}</div>
      <div class="cols"><div><h2 class="sec">Live city</h2><div data-amap="1" class="omap-ph big"></div><p class="legend"><span>🏪 shop</span><span>🧊 kirana chill hub</span><span>🛵 rider</span><span>🏠 delivery</span></p></div>
        <div><h2 class="sec">Unit economics · every finished order</h2><div class="card">${e.orders ? waterfall(e) : '<p class="mute">No finished orders yet. Each one shows up here with what everyone earned.</p>'}
          <p class="fine">Guardrails: delivery fee ≥ 1.1 × rider pay · credits cover ≤ 50% of a fee · points ≈ 0.7% of food · free food pays no fee. Worst order so far: <b>${inr(e.minMargin || 0)}</b>.</p></div></div></div>
      ${e.latest && e.latest.length ? `<h2 class="sec">Latest orders</h2><div class="card tbl"><table><thead><tr><th>Time</th><th>Item</th><th>Buyer</th><th>How</th><th>Food</th><th>Delivery − rider</th><th>Seller got</th><th>Seconds kept</th></tr></thead><tbody>${e.latest.map(o => `<tr><td>${clock(o.at)}</td><td>${esc(o.item)}</td><td>${esc(o.buyer)}</td><td>${o.mode === 'delivery' ? '🛵' + (o.batched ? ' batched' : '') : '🚶 pickup'}</td><td>${inr(o.food)}</td><td>${o.mode === 'delivery' ? inr(o.delivery) + ' − ' + inr(o.rider) : '–'}</td><td>${inr(o.sellerNet)}</td><td class="okc"><b>${inr(o.margin)}</b></td></tr>`).join('')}</tbody></table></div>` : ''}
      ${stressPanel()}
      ${sig.length ? `<h2 class="sec">Signals: what to change</h2><div class="signals">${sig.map(s => `<div class="sg ${s.level}"><b>${esc(s.name)}</b><span>${esc(s.signal)}</span></div>`).join('')}</div>` : ''}
      <h2 class="sec">Shops</h2><div class="card tbl"><table><thead><tr><th>Shop</th><th>Live</th><th>Sold</th><th>Free</th><th>Wasted</th><th>Sell-through</th><th>Avg off</th><th>Sells in</th><th>Revenue</th><th>Credits</th><th>Signal</th></tr></thead><tbody>
        ${A.shops.map(s => `<tr><td><b>${esc(s.name)}</b>${s.baker ? ' <em class="tag baker">baker</em>' : ''}</td><td>${s.live}</td><td>${s.sold}</td><td>${s.free}</td><td class="${s.wasted ? 'bad' : ''}">${s.wasted}</td><td>${s.sellThrough}%</td><td>${s.avgOff == null ? '–' : s.avgOff + '%'}</td><td>${s.minsToSell == null ? '–' : s.minsToSell + ' min'}</td><td>${inr(s.revenue)}</td><td>${inr(s.credits)}</td><td class="lvl ${s.level}">${esc(s.signal)}</td></tr>`).join('')}</tbody></table></div>
      <div class="cols"><div><h2 class="sec">Live listings <span class="badge">${live.length}</span></h2><div class="card">${live.map(p => `<div class="arow"><button class="thumb" data-act="open" data-id="${p.id}">${photo(p)}</button><div><b>${title(p)}</b><small>${esc(p.giverName)} · ${p.left}/${p.qty} left · <span data-left="${p.id}"></span>${p.hub ? ' · 🧊 ' + esc(p.hub) : ''}</small></div><b data-price="${p.id}"></b><button class="btn sm ghost" data-act="remove" data-id="${p.id}" title="Remove listing">✕</button></div>`).join('') || '<p class="mute">Nothing live.</p>'}</div></div>
        <div><h2 class="sec">Live activity</h2><div class="card feed">${(d.feed || []).slice(0, 14).map(e => `<div class="fe"><span>${evText(e)}</span><time>${clock(e.ts)}</time></div>`).join('') || '<p class="mute">Quiet.</p>'}</div>
        <p class="fine">${d.chain ? (d.chain.ok ? '🔒 Record intact · ' + d.chain.records + ' entries, each sealed to the one before' : '⚠️ Record broken at entry ' + d.chain.brokenAt) : ''}</p></div></div>`;
  }

  /* listing detail */
  function openPost(id) { st.open = id; st.sheet = 'post'; renderPost(); }
  function renderPost() {
    const p = st.byId.get(st.open), el = $('#sheet .card'), ae = document.activeElement;
    if (!p) { closeSheet(); return; }
    if (ae && ae.closest && ae.closest('#sheet') && ae.tagName === 'INPUT' && !$('#sheet').hidden && el.dataset.id === p.id) return;   // keep what the buyer is typing
    el.dataset.id = p.id;
    const r = role(), t = now(), c = p.myClaim, f = foods()[p.cls] || {};
    const pics = p.photos && p.photos.length ? `<div class="gal">${p.photos.map(u => `<img src="${esc(u)}" alt="Photo of ${title(p)}">`).join('')}</div>${p.photos.length > 1 ? '<p class="galhint">' + p.photos.length + ' photos · swipe</p>' : ''}` : photo(p, 'gal1');
    let action = '';
    if (r === 'buyer' && c && ['held', 'collected'].includes(c.status)) action = orderCard(p);
    else if (r === 'buyer' && p.status === 'open' && p.left > 0) action = `<form class="buy" data-form="order" data-id="${p.id}">
        <div class="seg mode"><button type="button" class="${st.mode === 'pickup' ? 'on' : ''}" data-act="mode" data-v="pickup">🚶 Pick up<small>${dist(p)} · ${p.hub ? 'at ' + esc(p.hub) : 'at the counter'}</small></button><button type="button" class="${st.mode === 'delivery' ? 'on' : ''}" data-act="mode" data-v="delivery">🛵 Deliver<small>about ${inr(DELIVERY_FEE(km(HERE, p)))} · rider in minutes</small></button></div>
        <div class="row"><div class="stepper"><button type="button" data-act="step" data-d="-1">−</button><input class="in" name="qty" type="number" min="1" max="${p.left}" value="${Math.min(2, p.left)}"><button type="button" data-act="step" data-d="1">+</button></div>
        <div class="total"><small data-each="${p.id}"></small><b data-total="${p.id}"></b></div></div><div class="billbox" data-bill="${p.id}"></div><p class="err"></p><button class="btn go big" type="submit">${st.mode === 'delivery' ? 'Order and pay · rider assigned now' : 'Order now · pay at pickup'}</button><p class="fine">The price is locked when you order. ${st.mode === 'delivery' ? 'Watch the rider live on the map.' : 'The exact pickup point and your code appear right after.'}</p></form>`;
    else if (r === 'buyer') action = '<div class="empty">Sold out.</div>';
    if (r === 'admin') action = `<button class="btn ghost" data-act="remove" data-id="${p.id}">Remove this listing</button>`;
    el.innerHTML = `<button class="x" data-act="close-sheet" aria-label="Close">✕</button>${pics}
      <h2>${dietDot(p.diet)}${title(p)}</h2><p class="mute">${esc(p.giverName)}${isBaker(p) ? ' <em class="tag baker">baker</em>' : ''} · ${dist(p)} · ${esc(f.label || '')} · listed ${clock(p.postedAt)}${p.sample ? ' · <em class="tag">sample</em>' : ''}</p>
      <div class="pricebox"><div class="pb-now"><b data-price="${p.id}"></b>${ref(p) ? '<s>' + inr(ref(p)) + '</s>' : ''}<span class="offbig" data-off="${p.id}"></span></div><div class="advice" data-adv="${p.id}"></div>
        ${chart(p).replace('class="chart"', `class="chart" data-chart="${p.id}"`)}
        <div class="facts"><span>🕒 safe for <b data-left="${p.id}"></b> · until ${clock(p.safeUntil)}</span>${p.price ? '<span>🆓 free from ' + clock(p.freeAt) + '</span>' : '<span>🆓 free all the way</span>'}<span>📦 ${p.left} of ${p.qty} left</span></div></div>
      ${action}`;
    $('#sheet').hidden = false; document.body.classList.add('noscroll'); tick(true); mountMaps();
  }
  function closeSheet() { $('#sheet').hidden = true; st.sheet = null; st.open = null; document.body.classList.remove('noscroll'); render(); }

  /* sell form */
  function openSell() {
    st.sell = { photos: [null, null, null], until: 120, cls: 'bakery', diet: 'veg', qty: 10, mrp: 60, price: 30, priceTouched: false, ago: 0, free: false, note: '' };
    st.sheet = 'sell'; drawSell(); $('#sheet').hidden = false; document.body.classList.add('noscroll');
  }
  function sellPreview() {
    const s = st.sell, F = foods(), f = F[s.cls], t = now(), safe = Math.min(f.min - (f.cooked ? s.ago : 0), s.until || 1e9) * 60e3;
    const price = s.free ? 0 : s.price, p = { price, mrp: s.mrp, postedAt: t, createdAt: t, safeUntil: t + safe, freeAt: price ? t + safe - 3600e3 : t };
    const steps = price ? Math.round(price / 5) : 0, every = steps ? (p.freeAt - t) / steps / 60e3 : 0;
    return `<div class="pv"><b>${price ? 'Starts at ' + inr(price) + (s.mrp ? ' (' + Math.round((1 - price / s.mrp) * 100) + '% off ' + inr(s.mrp) + ')' : '') : 'Free from the start'}</b>
      <span>${price ? 'Drops ₹5 about every ' + Math.max(1, Math.round(every)) + ' min · free from ' + clock(p.freeAt) : 'Buyers can order straight away'} · safe until ${clock(p.safeUntil)}</span></div>${chart(p)}`;
  }
  function drawSell() {
    const s = st.sell, F = foods(), n = s.photos.filter(Boolean).length;
    $('#sheet .card').innerHTML = `<button class="x" data-act="close-sheet" aria-label="Close">✕</button><h2>Sell surplus food</h2><p class="mute">Takes a minute. Buyers nearby see it instantly.</p>
      <form data-form="sell" class="sellf">
        <div class="field"><span>Photos <b class="${n >= 2 ? 'okc' : 'req'}">${n}/3 · at least 2 required</b></span><div class="slots">${s.photos.map((ph, i) => `<label class="slot${ph ? ' on' : ''}">${ph ? `<img src="${ph}" alt="">` : `<span>📷<small>${i < 2 ? 'Required' : 'Optional'}</small></span>`}<input type="file" accept="image/*" capture="environment" data-slot="${i}"></label>`).join('')}</div><small>Show the actual food: the tray, close up, the packaging.</small>${st.demo && st.demo.demo ? ' <button type="button" class="chip" data-act="samplepics">📷 Use sample photos (demo)</button>' : ''}</div>
        <label class="field"><span>What is it?</span><input class="in" name="note" maxlength="80" placeholder="e.g. Mini pizzas, untouched" value="${esc(s.note)}" required></label>
        <div class="field"><span>Category</span><div class="chips">${Object.entries(F).map(([k, f]) => `<button type="button" class="chip ${s.cls === k ? 'on' : ''}" data-act="sv" data-k="cls" data-v="${k}">${FOOD_E[k]} ${esc(f.label)}</button>`).join('')}</div></div>
        <div class="field"><span>Diet</span><div class="chips">${Object.entries(DIET).map(([k, l]) => `<button type="button" class="chip ${s.diet === k ? 'on' : ''}" data-act="sv" data-k="diet" data-v="${k}">${dietDot(k)} ${l}</button>`).join('')}</div></div>
        ${F[s.cls].cooked ? `<div class="field"><span>Cooked</span><div class="chips">${[[0, 'Just now'], [30, '30 min ago'], [60, '1 h ago'], [90, '1½ h ago']].map(([v, l]) => `<button type="button" class="chip ${s.ago === v ? 'on' : ''}" data-act="sv" data-k="ago" data-v="${v}">${l}</button>`).join('')}</div></div>` : ''}
        <div class="field"><span>Sell until</span><div class="chips">${[[90, '1½ h'], [120, '2 h'], [180, '3 h'], [0, 'Full safe time (' + Math.round(F[s.cls].min / 60) + ' h)']].map(([v, l]) => `<button type="button" class="chip ${s.until === v ? 'on' : ''}" data-act="sv" data-k="until" data-v="${v}">${l}</button>`).join('')}</div><small>When your shop closes or the food must go. The price falls to free 1 hour before.</small></div>
        <div class="three"><label class="field"><span>Portions</span><input class="in" name="qty" type="number" min="1" max="1000" value="${s.qty}"></label>
          <label class="field"><span>Normal price ₹</span><input class="in" name="mrp" type="number" min="0" max="2000" value="${s.mrp}"></label>
          <label class="field"><span>Start price ₹</span><input class="in" name="price" type="number" min="0" max="500" value="${s.free ? 0 : s.price}" ${s.free ? 'disabled' : ''}></label></div>
        <label class="check"><input type="checkbox" name="free" ${s.free ? 'checked' : ''}><span>Give it free (earns double credits)</span></label>
        <div class="field"><span>Price signal</span><div id="pv">${sellPreview()}</div></div>
        <label class="check"><input type="checkbox" name="hygiene" required><span><b>Safety checklist:</b> covered, clean hands, kept away from raw food, not reheated twice.</span></label>
        <p class="err"></p><button class="btn go big" type="submit">List it now</button></form>`;
  }
  function shrink(file) {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => { const k = Math.min(1, 1024 / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); let q = .8, d = c.toDataURL('image/jpeg', q); while (d.length > 880000 && q > .4) { q -= .1; d = c.toDataURL('image/jpeg', q); } URL.revokeObjectURL(url); res(d); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('That file is not a photo we can read.')); };
      img.src = url;
    });
  }

  /* ---------- maps: where the food is, where the rider is ---------- */
  const maps = new Map(), routes = new Map();
  const mapOk = () => !!(window.maplibregl && window.secondsMapStyle);
  function route(a, b) {
    const k = [a.lat, a.lon, b.lat, b.lon].map(v => (+v).toFixed(5)).join(',');
    if (!routes.has(k)) routes.set(k, (async () => {
      try { const j = await (await fetch(`https://router.project-osrm.org/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`)).json(); if (j.routes && j.routes[0]) return j.routes[0].geometry.coordinates; } catch (e) {}
      return [[a.lon, a.lat], [b.lon, b.lat]];
    })());
    return routes.get(k);
  }
  function along(cs, f) {
    f = Math.max(0, Math.min(1, f)); const seg = []; let total = 0;
    for (let i = 1; i < cs.length; i++) { const d = Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1]); seg.push(d); total += d; }
    let want = total * f;
    for (let i = 0; i < seg.length; i++) { if (want <= seg[i]) { const r = seg[i] ? want / seg[i] : 0; return [cs[i][0] + (cs[i + 1][0] - cs[i][0]) * r, cs[i][1] + (cs[i + 1][1] - cs[i][1]) * r]; } want -= seg[i]; }
    return cs[cs.length - 1];
  }
  const pinEl = (cls, html, title) => { const el = document.createElement('div'); el.className = 'mpin ' + cls; el.innerHTML = html; if (title) el.title = title; return el; };
  function newMap(el, center, zoom) {
    const map = new maplibregl.Map({ container: el, style: window.secondsMapStyle('dark'), center, zoom: zoom || 13.4, attributionControl: false, dragRotate: false, pitchWithRotate: false });
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    map.on('load', () => { map._ready = true; (map._q || []).forEach(f => f()); map._q = []; });
    return map;
  }
  function drawLines(m, id, feats) {
    const go = () => { const data = { type: 'FeatureCollection', features: feats }; if (m.map.getSource(id)) m.map.getSource(id).setData(data); else { m.map.addSource(id, { type: 'geojson', data }); m.map.addLayer({ id, type: 'line', source: id, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'c'], 'line-width': 4, 'line-opacity': 0.85 } }); } };
    if (m.map._ready) go(); else (m.map._q = m.map._q || []).push(go);   // isStyleLoaded() can read false while tiles stream in, so wait on our own flag
  }
  function claimLookup(cid) {
    for (const p of st.d.posts) { if (p.myClaim && p.myClaim.id === cid) return { p, c: p.myClaim }; const c = (p.claims || []).find(x => x.id === cid); if (c) return { p, c }; }
    return null;
  }
  function orderMap(cid) {
    let m = maps.get(cid); if (m) return m;
    const el = document.createElement('div'); el.className = 'omap'; m = { el, cid }; maps.set(cid, m);
    const f = claimLookup(cid); if (!f || !mapOk()) { el.innerHTML = '<p class="mute" style="padding:18px">Map is loading or offline.</p>'; return m; }
    const { p, c } = f, shop = { lat: p.lat, lon: p.lon }, home = c.buyerAt || HERE;
    m.map = newMap(el, [shop.lon, shop.lat], 13.6);
    new maplibregl.Marker({ element: pinEl('shop', '🏪', p.giverName) }).setLngLat([shop.lon, shop.lat]).addTo(m.map);
    new maplibregl.Marker({ element: pinEl('home', '🏠', 'You') }).setLngLat([home.lon, home.lat]).addTo(m.map);
    if (c.mode === 'delivery') m.rider = new maplibregl.Marker({ element: pinEl('rider', '🛵', c.riderName) }).setLngLat([c.riderFrom.lon, c.riderFrom.lat]).addTo(m.map);
    Promise.all(c.mode === 'delivery' ? [route(c.riderFrom, shop), route(shop, home)] : [route(home, shop)]).then(L => {
      m.legs = L; drawLines(m, 'legs', L.map((g, i) => ({ type: 'Feature', properties: { c: c.mode === 'delivery' && i === 0 ? '#ff8a3d' : '#4f9fe0' }, geometry: { type: 'LineString', coordinates: g } })));
      const b = new maplibregl.LngLatBounds(); L.flat().forEach(x => b.extend(x)); b.extend([home.lon, home.lat]); b.extend([shop.lon, shop.lat]); m.map.fitBounds(b, { padding: 48, duration: 0, maxZoom: 15.5 });
    });
    return m;
  }
  function adminMap() {
    let m = maps.get('admin');
    if (!m) {
      const el = document.createElement('div'); el.className = 'omap big'; m = { el, marks: new Map() }; maps.set('admin', m);
      if (!mapOk()) { el.innerHTML = '<p class="mute" style="padding:18px">Map is loading or offline.</p>'; return m; }
      m.map = newMap(el, [HERE.lon, HERE.lat], 12.8);
    }
    return m;
  }
  function syncAdminMap() {
    const m = maps.get('admin'); if (!m || !m.map || !st.d) return;
    const want = new Set(), t = now(), put = (id, cls, html, ll, title) => { want.add(id); let mk = m.marks.get(id); if (!mk) { mk = new maplibregl.Marker({ element: pinEl(cls, html, title) }).setLngLat(ll).addTo(m.map); m.marks.set(id, mk); } else { mk.setLngLat(ll); mk.getElement().innerHTML = html; } };
    (st.d.hubs || []).forEach(h => put(h.id, 'hub', '🧊<small>' + h.stored + '</small>', [h.lon, h.lat], h.name + ' · ' + h.stored + '/' + h.capacity + ' portions'));
    st.d.posts.filter(p => p.status === 'open' && p.left > 0 && !p.hub).forEach(p => put(p.id, 'shop', '🏪<small>' + (priceAt(p, t) ? inr(priceAt(p, t)) : 'free') + '</small>', [p.lon, p.lat], p.giverName + ': ' + (p.note || '')));
    const busy = new Set(), lines = [];
    st.d.posts.forEach(p => (p.claims || []).forEach(c => {
      const ph = riderPhase(c, t); if (!ph || ph.k === 'delivered' || ph.k === 'ended') return;
      busy.add(c.riderName); put('d' + c.id, 'home', '🏠', [c.buyerAt.lon, c.buyerAt.lat], c.takerName);
      const key = c.id; if (!m['r' + key]) { m['r' + key] = Promise.all([route(c.riderFrom, p), route(p, c.buyerAt)]).then(L => { m['L' + key] = L; }); }
      const L = m['L' + key], pos = !L ? [c.riderFrom.lon, c.riderFrom.lat] : ph.k === 'toShop' ? along(L[0], ph.f) : ph.k === 'atShop' ? [p.lon, p.lat] : along(L[1], ph.f);
      if (L) lines.push({ type: 'Feature', properties: { c: ph.k === 'toBuyer' ? '#4f9fe0' : '#ff8a3d' }, geometry: { type: 'LineString', coordinates: ph.k === 'toBuyer' ? L[1] : L[0].concat(L[1]) } });
      if (!c.batchOf) put('rider' + c.riderName, 'rider on', '🛵<small>' + esc(c.riderName) + '</small>', pos, c.riderName + ' · ' + PHASE[ph.k]);
    }));
    (st.d.riders || []).forEach(r => { if (!busy.has(r.name)) put('rider' + r.name, 'rider', '🛵<small>' + esc(r.name) + '</small>', [r.lon, r.lat], r.name + ' · free · ' + r.runs + ' runs, ' + inr(r.earned)); });
    for (const [id, mk] of m.marks) if (!want.has(id)) { mk.remove(); m.marks.delete(id); }
    drawLines(m, 'runs', lines);
  }
  function mountMaps() {
    $$('[data-omap]').forEach(ph => { const m = orderMap(ph.dataset.omap); ph.replaceWith(m.el); if (m.map) requestAnimationFrame(() => m.map.resize()); });
    $$('[data-amap]').forEach(ph => { const m = adminMap(); ph.replaceWith(m.el); if (m.map) requestAnimationFrame(() => m.map.resize()); syncAdminMap(); });
  }
  function moveRiders() {
    const t = now();
    for (const [key, m] of maps) {
      if (key === 'admin') continue;
      if (!m.rider || !m.legs) continue;
      const f = claimLookup(key); if (!f) continue;
      const ph = riderPhase(f.c, t); if (!ph) continue;
      const shop = [f.p.lon, f.p.lat], home = f.c.buyerAt ? [f.c.buyerAt.lon, f.c.buyerAt.lat] : [HERE.lon, HERE.lat];
      m.rider.setLngLat(ph.k === 'toShop' ? along(m.legs[0], ph.f) : ph.k === 'atShop' ? shop : ph.k === 'toBuyer' ? along(m.legs[1], ph.f) : home);
    }
    if (maps.get('admin')) syncAdminMap();
  }

  /* ---------- the clock: everything that changes with time, every second ---------- */
  function tick(force) {
    const t = now();
    $$('[data-clock]').forEach(el => { el.textContent = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' }); });
    $$('[data-price]').forEach(el => { const p = st.byId.get(el.dataset.price); if (p) { const v = priceAt(p, t); const s = v ? inr(v) : 'FREE'; if (el.textContent !== s) { if (el.textContent && !force) { el.classList.remove('drop'); void el.offsetWidth; el.classList.add('drop'); } el.textContent = s; } el.classList.toggle('free', !v); } });
    $$('[data-off]').forEach(el => { const p = st.byId.get(el.dataset.off); if (p) { const o = offPct(p, t); el.textContent = ref(p) ? (o >= 100 ? 'FREE' : '−' + o + '%') : 'FREE'; } });
    $$('[data-left]').forEach(el => { const p = st.byId.get(el.dataset.left); if (p) { el.textContent = left(p.safeUntil - t); el.classList.toggle('hot', p.safeUntil - t < 30 * 60e3); } });
    $$('[data-bar]').forEach(el => { const p = st.byId.get(el.dataset.bar); if (p) el.style.width = (Math.max(0, Math.min(1, (p.safeUntil - t) / (p.safeUntil - p.createdAt))) * 100).toFixed(1) + '%'; });
    $$('[data-sig]').forEach(el => { const p = st.byId.get(el.dataset.sig); if (!p) return; const nx = nextDrop(p, t); el.innerHTML = nx ? '▼ ' + inr(nx.to) + ' in ' + left(nx.at - t) : p.price || p.mrp ? '<b>FREE</b> until ' + clock(p.safeUntil) : 'free'; });
    $$('[data-adv]').forEach(el => { const p = st.byId.get(el.dataset.adv); if (p) { const a = advice(p, t); el.className = 'advice ' + a.k; el.textContent = a.t; } });
    $$('[data-hold]').forEach(el => { el.textContent = left(+el.dataset.hold - t); });
    $$('form[data-form=order]').forEach(f => {
      const p = st.byId.get(f.dataset.id); if (!p) return;
      const q = Math.max(0, parseInt(f.qty.value, 10) || 0), v = priceAt(p, t), food = q * v, plat = food ? PLATFORM_FEE : 0, k = km(HERE, p), fee = st.mode === 'delivery' ? DELIVERY_FEE(k) : 0, total = food + plat + fee;
      $('[data-each]', f).textContent = q + ' × ' + (v ? inr(v) : 'free'); $('[data-total]', f).textContent = total ? inr(total) : 'FREE';
      const html = `<div class="billrow"><span>Food · ${q} × ${v ? inr(v) : 'free'}</span><span>${food ? inr(food) : 'FREE'}</span></div>${plat ? `<div class="billrow"><span>Platform fee (paid orders only)</span><span>${inr(plat)}</span></div>` : ''}${fee ? `<div class="billrow"><span>Delivery · about ${k.toFixed(1)} km · rider earns about ${inr(RIDER_PAY(k))}</span><span>${inr(fee)}</span></div>` : ''}<div class="billrow tot"><span>You pay</span><span>${total ? inr(total) : 'FREE'}</span></div>${ref(p) ? `<div class="billrow save"><span>You save · +${Math.floor(food / 10)} points</span><span>${inr(ref(p) * q - food)}</span></div>` : ''}`;
      const bx = $('[data-bill]', f); if (bx && bx.innerHTML !== html) bx.innerHTML = html;
    });
    $$('[data-eta]').forEach(el => { el.textContent = left(Math.max(0, +el.dataset.eta - t)); });
    $$('[data-phase]').forEach(el => { const f = claimLookup(el.dataset.phase); if (f) { const ph = riderPhase(f.c, t); el.textContent = PHASE[ph.k] + (ph.eta ? ' · ' + left(ph.eta - t) : ''); el.className = 'pill ' + (ph.k === 'delivered' ? 'ok' : 'on'); } });
    $$('[data-act=torider]').forEach(b => { const ok = t >= +b.dataset.at, w = b.parentElement.querySelector('[data-riderwait]'); b.disabled = !ok; if (w) w.innerHTML = ok ? '✅ Rider is at your counter: the order is scanned, hand it over' : '🛵 Rider arrives in <b>' + left(+b.dataset.at - t) + '</b>'; });
    if (st.d) moveRiders();
    if (force || !(Math.floor(t / 1000) % 5)) $$('[data-chart]').forEach(el => { const p = st.byId.get(el.dataset.chart); if (p) { const w = +el.getAttribute('viewBox').split(' ')[2], h = +el.getAttribute('viewBox').split(' ')[3]; el.outerHTML = chart(p, w, h).replace('class="chart"', `class="chart" data-chart="${p.id}"`); } });
  }
  setInterval(() => tick(false), 1000);

  /* ---------- actions ---------- */
  const ACT = {
    async demo(el) { await api('/api/demo-login', { phone: st.demo.accounts.find(a => a.name === el.dataset.name).phone }); await refresh(); },
    async logout() { await api('/api/logout', {}); st.me = null; await refresh(); },
    open(el) { openPost(el.dataset.id); },
    'close-sheet'() { closeSheet(); },
    set(el) { st[el.dataset.k] = el.dataset.v; render(); },
    veg() { st.veg = !st.veg; render(); },
    sell() { openSell(); },
    async samplepics() {
      // demo only: load two pre-made pictures into the photo slots, through the same shrink-to-JPEG path as a real upload
      keepTyped(); const pick = { bakery: 'pizza', meal: 'biryani', sweets: 'laddu', fruit: 'banana', snack: 'pizza', packed: 'croissant' }[st.sell.cls] || 'pizza';
      for (let i = 0; i < 3; i++) { let r = await fetch('/samples/' + pick + '-' + (i + 1) + '.jpg'); if (!r.ok) r = await fetch('/samples/' + pick + '-' + (i + 1) + '.svg'); if (!r.ok) continue; const b = await r.blob(); st.sell.photos[i] = await shrink(new File([b], pick, { type: b.type })); }
      if (!st.sell.note) st.sell.note = { pizza: 'Mini pizzas, untouched', biryani: 'Chicken biryani, full trays', laddu: 'Laddu boxes', banana: 'Bananas and apples', croissant: 'Butter croissants' }[pick];
      drawSell();
    },
    mode(el) { st.mode = el.dataset.v; const f = $('form[data-form=order]'), q = f && f.qty.value; renderPost(); const g = $('form[data-form=order]'); if (g && q) g.qty.value = q; tick(true); },
    q(el) { st.q = el.dataset.v; render(); },
    async torider(el) { await api('/api/posts/' + el.dataset.id + '/handover', { claimId: el.dataset.claim }); toast('🛵 Handed to the rider. The buyer can watch it on the map.'); refresh(); },
    async chill(el) { const j = await api('/api/posts/' + el.dataset.id + '/chill', {}); toast('🧊 Moved to ' + esc(j.post.hub) + '. 8 more hours on the clock; the kirana is now the pickup point.'); refresh(); },
    sv(el) { const v = el.dataset.v; st.sell[el.dataset.k] = el.dataset.k === 'ago' || el.dataset.k === 'until' ? +v : v; keepTyped(); drawSell(); },
    step(el) { const i = el.parentElement.querySelector('input'); i.value = Math.max(+i.min || 1, Math.min(+i.max || 999, (parseInt(i.value, 10) || 0) + +el.dataset.d)); tick(true); },
    async release(el) { await api('/api/claims/' + el.dataset.id + '/release', {}); toast('Order cancelled. The food is back on the market.'); refresh(); },
    async close(el) { if (!el.dataset.id) return closeSheet(); await api('/api/posts/' + el.dataset.id + '/close', {}); toast('Listing ended.'); refresh(); },
    async remove(el) { await api('/api/posts/' + el.dataset.id + '/remove', { note: 'Removed by admin' }); toast('Listing removed.'); closeSheet(); refresh(); }
  };
  function keepTyped() { const f = $('form[data-form=sell]'); if (!f) return; const s = st.sell; s.note = f.note.value; s.qty = +f.qty.value || 1; s.mrp = +f.mrp.value || 0; if (!s.free) s.price = +f.price.value || 0; }
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]'); if (!el) return;
    const f = ACT[el.dataset.act]; if (!f) return;
    if (el.tagName === 'A') return;
    e.preventDefault();
    try { await f(el); } catch (x) { toast(x.message, 'bad'); }
  });
  document.addEventListener('input', e => {
    if (e.target.id === 'q') { st.q = e.target.value; const g = $('#grid'); if (g) { g.innerHTML = gridHtml(); tick(true); } return; }
    const f = e.target.closest('form[data-form=sell]');
    if (f) {
      const s = st.sell; keepTyped();
      if (e.target.name === 'price') s.priceTouched = true;
      if (e.target.name === 'mrp' && !s.priceTouched && !s.free) { s.price = Math.max(5, Math.round(s.mrp * 0.5 / 5) * 5); f.price.value = s.price; }
      if (e.target.name === 'free') { s.free = e.target.checked; drawSell(); return; }
      $('#pv').innerHTML = sellPreview();
    }
    if (e.target.closest('form[data-form=order]')) tick(true);
  });
  document.addEventListener('change', async e => {
    const inp = e.target.closest('input[data-slot]'); if (!inp || !inp.files[0]) return;
    try { keepTyped(); st.sell.photos[+inp.dataset.slot] = await shrink(inp.files[0]); drawSell(); } catch (x) { toast(x.message, 'bad'); }
  });
  document.addEventListener('focusout', () => setTimeout(() => { if (st.dirty && !(document.activeElement && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName))) render(); }, 50));
  const FORMS = {
    async login(v) { await api('/api/login', { phone: v.phone, pin: v.pin }); await refresh(); },
    async signup(v) { await api('/api/signup', { name: v.name, phone: v.phone, pin: v.pin, kind: v.kind }); await refresh(); },
    async order(v, f) { const j = await api('/api/posts/' + f.dataset.id + '/claim', { qty: v.qty, mode: st.mode, lat: HERE.lat, lon: HERE.lon }); const c = j.post.myClaim; toast(c.mode === 'delivery' ? '🛵 Ordered. ' + esc(c.riderName) + (c.batchOf ? ' is already heading there and will bring yours too' : ' is on the way to the shop') : '🎟️ Ordered. Your pickup code is <b>' + esc(c.code) + '</b>'); await refresh(); },
    async handover(v, f) { await api('/api/posts/' + f.dataset.id + '/handover', { code: v.code, paidBy: v.paidBy }); toast('🤝 Handed over. Credits added.'); f.reset(); f.querySelector('input').blur(); await refresh(); },
    async sell(v) {
      keepTyped(); const s = st.sell, photos = s.photos.filter(Boolean);
      if (photos.length < 2) throw new Error('Add at least 2 photos of the food.');
      await api('/api/posts', { photos, note: s.note, cls: s.cls, diet: s.diet, qty: s.qty, mrp: s.mrp, price: s.free ? 0 : s.price, cookedMinutesAgo: s.ago, untilMinutes: s.until || undefined, hygiene: v.hygiene === 'on', lat: HERE.lat + 0.0105, lon: HERE.lon + 0.0072, place: st.me.name + ', front counter' });
      closeSheet(); toast('🆕 Listed. Buyers nearby can see it now.'); await refresh();
    }
  };
  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]'); if (!f) return; e.preventDefault();
    const v = Object.fromEntries(new FormData(f)), btn = $('[type=submit]', f), err = $('.err', f);
    if (err) err.textContent = ''; if (btn) btn.disabled = true;
    try { await FORMS[f.dataset.form](v, f); } catch (x) { if (err && err.isConnected) err.textContent = x.message; else toast(x.message, 'bad'); } finally { if (btn) btn.disabled = false; }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet(); });

  /* ---------- live: every action reaches every open page ---------- */
  let liveT = null;
  function listen() {
    const es = new EventSource('/api/events');
    es.onmessage = m => {
      let e; try { e = JSON.parse(m.data); } catch (x) { return; }
      if (st.me && e.actor !== st.me.id && e.type !== 'settings' && e.type !== 'joined') toast(evText(e), 'live');
      clearTimeout(liveT); liveT = setTimeout(refresh, 150);
    };
  }

  /* ---------- start ---------- */
  (async () => {
    try { st.demo = await api('/api/demo'); } catch (e) { st.demo = { demo: false }; }
    if (st.demo.persona) {
      document.title = 'Seconds · ' + (st.demo.persona.name === 'Moderator' ? 'Admin' : st.demo.persona.name);
      const d = await api('/api/nearby', { lat: HERE.lat, lon: HERE.lon }).catch(() => null);
      if (!d || !d.me) await api('/api/demo-login', { phone: st.demo.persona.phone }).catch(() => {});
    }
    fetch('/econ.json').then(r => r.json()).then(j => { st.econ = j; if (role() === 'admin' || role() === 'guest') render(); }).catch(() => {});
    await refresh(); listen();
  })();
})();
