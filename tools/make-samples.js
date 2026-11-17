/* Draws the sample listing pictures (flat illustrations, two views per item) into this folder.
   Run once: node tools/make-samples.js. Writes public/samples/<item>-1.svg and -2.svg. */
'use strict';
const fs = require('fs'), path = require('path');
const W = 800, H = 600;
const rnd = (seed => () => (seed = (seed * 16807) % 2147483647) / 2147483647)(7);
const wrap = (bg, body, label) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><radialGradient id="v" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".45"/></radialGradient><filter id="s"><feDropShadow dx="0" dy="10" stdDeviation="12" flood-opacity=".35"/></filter></defs><rect width="${W}" height="${H}" fill="${bg}"/>${body}<rect width="${W}" height="${H}" fill="url(#v)"/><text x="${W - 18}" y="${H - 16}" text-anchor="end" font-family="sans-serif" font-size="15" fill="#fff" fill-opacity=".55">${label} · sample picture</text></svg>`;
const wood = (c1, c2) => { let s = ''; for (let y = 0; y < H; y += 40) s += `<rect y="${y}" width="${W}" height="40" fill="${(y / 40) % 2 ? c1 : c2}"/>`; return s; };
const dots = (n, cx, cy, r, R, fill, rr) => { let s = ''; for (let i = 0; i < n; i++) { const a = rnd() * 6.283, d = Math.sqrt(rnd()) * R; s += `<circle cx="${(cx + Math.cos(a) * d).toFixed(1)}" cy="${(cy + Math.sin(a) * d).toFixed(1)}" r="${(r * (0.7 + rnd() * 0.6)).toFixed(1)}" fill="${fill}"${rr ? ` opacity="${rr}"` : ''}/>`; } return s; };
const plate = (cx, cy, r) => `<g filter="url(#s)"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#f4f1ea"/><circle cx="${cx}" cy="${cy}" r="${r * 0.82}" fill="#e9e4da"/></g>`;
const pizza = (cx, cy, r) => `<g filter="url(#s)"><circle cx="${cx}" cy="${cy}" r="${r}" fill="#d9963f"/><circle cx="${cx}" cy="${cy}" r="${r * 0.86}" fill="#f2c45a"/>${dots(7, cx, cy, r * 0.13, r * 0.62, '#b8322a')}${dots(10, cx, cy, r * 0.05, r * 0.7, '#3d7a2a')}${dots(14, cx, cy, r * 0.04, r * 0.75, '#fff3c4', .8)}</g>`;
const items = {
  pizza: ['Mini pizzas', [
    wrap('#3a2414', wood('#5b3a22', '#4e311c') + [[200, 180], [400, 170], [600, 185], [210, 410], [410, 420], [605, 405]].map(([x, y]) => pizza(x, y, 92)).join(''), 'Mini pizzas'),
    wrap('#2a1a10', wood('#4e311c', '#442a17') + pizza(400, 310, 230), 'Mini pizzas, close up')]],
  biryani: ['Chicken biryani', [
    wrap('#1d1410', wood('#3b2a1e', '#33241a') + `<g filter="url(#s)"><rect x="120" y="110" width="560" height="380" rx="30" fill="#b9bcc0"/><rect x="140" y="130" width="520" height="340" rx="22" fill="#e8c46a"/></g>` + dots(260, 400, 300, 9, 230, '#f6e3a3') + dots(60, 400, 300, 10, 220, '#d9822b') + dots(22, 400, 300, 24, 190, '#9a4a20') + dots(30, 400, 300, 6, 220, '#3f7d2c'), 'Chicken biryani'),
    wrap('#1d1410', plate(400, 300, 250) + dots(320, 400, 300, 10, 175, '#f3dc96') + dots(70, 400, 300, 11, 170, '#d9822b') + dots(10, 400, 300, 30, 120, '#9a4a20') + dots(25, 400, 300, 7, 170, '#3f7d2c') + `<circle cx="560" cy="200" r="40" fill="#f0f0e8"/>`, 'Chicken biryani, plated')]],
  croissant: ['Croissants', [
    wrap('#2b1d12', wood('#5a3d24', '#4f351f') + [[230, 200, -20], [520, 190, 15], [250, 420, 10], [540, 420, -10]].map(([x, y, a]) => `<g transform="translate(${x} ${y}) rotate(${a})" filter="url(#s)"><path d="M-130 20 Q-110 -70 0 -80 Q110 -70 130 20 Q60 50 0 40 Q-60 50 -130 20Z" fill="#c8812f"/><path d="M-70 -55 Q-40 0 -50 40 M-20 -78 Q0 -10 -5 42 M30 -76 Q35 -10 45 40 M80 -50 Q70 0 90 30" stroke="#8e5520" stroke-width="7" fill="none" stroke-linecap="round"/></g>`).join(''), 'Croissants'),
    wrap('#2b1d12', wood('#4f351f', '#45301b') + `<g transform="translate(400 310) scale(2.4)" filter="url(#s)"><path d="M-130 20 Q-110 -70 0 -80 Q110 -70 130 20 Q60 50 0 40 Q-60 50 -130 20Z" fill="#cf8a35"/><path d="M-70 -55 Q-40 0 -50 40 M-20 -78 Q0 -10 -5 42 M30 -76 Q35 -10 45 40 M80 -50 Q70 0 90 30" stroke="#8e5520" stroke-width="5" fill="none" stroke-linecap="round"/></g>`, 'Croissant, close up')]],
  laddu: ['Laddu box', [
    wrap('#3b0f14', `<g filter="url(#s)"><rect x="110" y="120" width="580" height="360" rx="18" fill="#c9a25a"/><rect x="130" y="140" width="540" height="320" rx="10" fill="#f7efe0"/></g>` + [0, 1, 2, 3].flatMap(i => [0, 1].map(j => `<g filter="url(#s)"><circle cx="${205 + i * 130}" cy="${225 + j * 150}" r="56" fill="#f0a830"/>${dots(18, 205 + i * 130, 225 + j * 150, 6, 44, '#d8891a')}</g>`)).join(''), 'Laddu box'),
    wrap('#3b0f14', plate(400, 300, 240) + [[330, 250], [470, 250], [400, 370], [300, 380], [500, 375]].map(([x, y]) => `<g filter="url(#s)"><circle cx="${x}" cy="${y}" r="70" fill="#f0a830"/>${dots(22, x, y, 7, 55, '#d8891a')}</g>`).join(''), 'Laddu, close up')]],
  banana: ['Bananas and apples', [
    wrap('#16351f', wood('#2c5a35', '#27512f') + [0, 1, 2].map(i => `<g transform="translate(${170 + i * 140} 250) rotate(${-20 + i * 12})" filter="url(#s)"><path d="M-20 -150 Q90 -40 20 160 Q60 0 -20 -150Z" fill="#f2d04a"/><path d="M-20 -150 l-10 -20" stroke="#5b4a1c" stroke-width="10"/></g>`).join('') + [[560, 220], [660, 330], [540, 420]].map(([x, y]) => `<g filter="url(#s)"><circle cx="${x}" cy="${y}" r="70" fill="#c9322a"/><circle cx="${x - 22}" cy="${y - 25}" r="16" fill="#fff" opacity=".25"/><path d="M${x} ${y - 70} l4 -24" stroke="#5b3a1c" stroke-width="7"/></g>`).join(''), 'Bananas and apples'),
    wrap('#16351f', wood('#27512f', '#22482a') + [0, 1, 2, 3].map(i => `<g transform="translate(${260 + i * 90} 300) rotate(${-25 + i * 15}) scale(1.4)" filter="url(#s)"><path d="M-20 -150 Q90 -40 20 160 Q60 0 -20 -150Z" fill="#f0cc45"/>${dots(4, 10, 0, 4, 80, '#7a5a22', .7)}</g>`).join(''), 'Bananas, close up')]],
  rajma: ['Rajma chawal', [
    wrap('#1c1712', wood('#3a2c20', '#33271c') + plate(400, 300, 250) + dots(300, 320, 300, 9, 140, '#fbf6e8') + `<g filter="url(#s)"><circle cx="500" cy="300" r="120" fill="#7a2418"/></g>` + dots(45, 500, 300, 13, 95, '#a8402c') + dots(8, 500, 300, 5, 90, '#3f7d2c'), 'Rajma chawal'),
    wrap('#1c1712', `<g filter="url(#s)"><circle cx="400" cy="300" r="250" fill="#c0c3c6"/><circle cx="400" cy="300" r="225" fill="#7a2418"/></g>` + dots(110, 400, 300, 16, 190, '#a8402c') + dots(16, 400, 300, 6, 180, '#3f7d2c'), 'Rajma, close up')]]
};
for (const [key, [, views]] of Object.entries(items)) views.forEach((svg, i) => fs.writeFileSync(path.join(__dirname, '..', 'public', 'samples', key + '-' + (i + 1) + '.svg'), svg));
console.log('wrote', Object.keys(items).length * 2, 'pictures');
