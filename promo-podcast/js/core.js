// Shared helpers: every visual state is a pure function of film time t (seconds).
export const C = {
  paper: '#FAFAFA', page: '#FFFFFF', shade: '#F4F4F3', line: '#E7E5E4', faint: '#D6D3D1',
  mute: '#78716C', ink: '#1C1917', accent: '#E8492B', soft: '#FDECE8', green: '#2E6B4F', yellow: '#FBEFB0',
};
export const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const prog = (t, a, b) => clamp((t - a) / (b - a));
export const lerp = (a, b, x) => a + (b - a) * x;
export const sstep = x => x * x * x * (x * (x * 6 - 15) + 10);           // smootherstep: no one-frame pop
export const eout = x => 1 - Math.pow(1 - x, 3);
export const eout5 = x => 1 - Math.pow(1 - x, 5);
export const ein = x => x * x * x;
export const eio = x => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const back = x => { const c = 1.6; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
export const rnd = i => { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

// Arrive (eased landing) then leave (accelerating exit): 0 before a, 1 while settled, back to 0 after d.
export const life = (t, a, b, c, d) => (t < a || t > d ? 0 : t < b ? eout(prog(t, a, b)) : t <= c ? 1 : 1 - ein(prog(t, c, d)));

export const h = (html) => { const tpl = document.createElement('template'); tpl.innerHTML = html.trim(); return tpl.content.firstElementChild; };
export const $ = (root, sel) => root.querySelector(sel);
export const $$ = (root, sel) => [...root.querySelectorAll(sel)];

// Write a transform/opacity/filter state. Only properties passed are touched.
export function set(el, o) {
  const s = el.style;
  if ('o' in o) s.opacity = o.o;
  if ('x' in o || 'y' in o || 's' in o || 'r' in o || 'rx' in o || 'sx' in o || 'sy' in o) {
    s.transform = `translate(${o.x || 0}px,${o.y || 0}px)` + (o.rx ? ` perspective(1600px) rotateX(${o.rx}deg)` : '') +
      (o.r ? ` rotate(${o.r}deg)` : '') + ` scale(${o.sx ?? o.s ?? 1},${o.sy ?? o.s ?? 1})`;
  }
  if ('blur' in o) s.filter = o.blur > 0.05 ? `blur(${o.blur}px)` : 'none';
  if ('show' in o) s.visibility = o.show ? 'visible' : 'hidden';
}

// A macOS-like pointer that glides between keyframes [{t, x, y, click?}].
export function makeCursor(parent) {
  const el = h(`<svg class="cursor" width="44" height="44" viewBox="0 0 24 24"><path d="M5 2.5v17.2l4.6-4.4 3 6.6 3-1.3-3-6.5h6.3z" fill="#1C1917" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`);
  const ring = h(`<div class="click-ring"></div>`);
  parent.append(ring, el);
  return (t, keys, fade = [0, 0, 1e9, 1e9]) => {
    const o = life(t, ...fade);
    set(el, { show: o > 0.01, o }); set(ring, { show: false });
    if (o <= 0.01) return;
    let x = keys[0].x, y = keys[0].y;
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1], b = keys[i];
      if (t >= b.t) { x = b.x; y = b.y; continue; }
      const mv = b.mv || 0.55;
      const k = eio(prog(t, b.t - mv, b.t)); x = lerp(a.x, b.x, k); y = lerp(a.y, b.y, k); break;
    }
    let press = 1;
    for (const k of keys) if (k.click) {
      const d = t - k.t;
      if (d > -0.06 && d < 0.12) press = 0.86;
      if (d >= 0 && d < 0.45) { const q = d / 0.45; set(ring, { show: true, o: 1 - q, x: x - 30, y: y - 30, s: 0.4 + q * 0.9 }); }
    }
    set(el, { x: x - 6, y: y - 4, s: press });
  };
}

// Typewriter: how many characters of str are visible at t.
export const typed = (t, a, cps, str) => str.slice(0, Math.max(0, Math.floor((t - a) * cps)));

// Camera: a Catmull-Rom path through [{t, s, x, y}] keys, so the frame never stops moving between beats.
export function cam(t, keys) {
  if (t <= keys[0].t) return { s: keys[0].s, x: keys[0].x, y: keys[0].y };
  const n = keys.length - 1;
  if (t >= keys[n].t) return { s: keys[n].s, x: keys[n].x, y: keys[n].y };
  let i = 0; while (t > keys[i + 1].t) i++;
  const k0 = keys[Math.max(0, i - 1)], k1 = keys[i], k2 = keys[i + 1], k3 = keys[Math.min(n, i + 2)];
  const u = (t - k1.t) / (k2.t - k1.t), dt = k2.t - k1.t;
  const f = p => {
    const m1 = ((k2[p] - k0[p]) / (k2.t - k0.t || 1)) * dt, m2 = ((k3[p] - k1[p]) / (k3.t - k1.t || 1)) * dt;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * k1[p] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * k2[p] + (u3 - u2) * m2;
  };
  return { s: f('s'), x: f('x'), y: f('y') };
}
