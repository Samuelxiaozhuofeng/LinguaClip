// End card (52–60s): the red playhead becomes the play triangle of the app icon, then the lockup + CTA.
import { prog, lerp, eout, ein, eio, life, set, h, $, $$ } from './core.js';
import { OPEN } from './act3.js';

const CSS = `
.e-wrap { position:absolute; inset:0; transform-origin:50% 48%; }
.e-icon { position:absolute; left:0; top:0; width:300px; height:300px; transform-origin:0 0; }
.e-dot { position:absolute; left:0; top:0; width:44px; height:44px; margin:-22px 0 0 -22px; border-radius:50%; background:#E8492B; }
.e-name { position:absolute; left:800px; top:300px; font-size:150px; font-weight:600; letter-spacing:-0.04em; line-height:1; }
.e-tag { position:absolute; left:806px; top:478px; font-size:66px; font-weight:600; color:#E8492B; }
.e-cta { position:absolute; left:500px; top:660px; display:flex; align-items:center; gap:34px; }
.e-cta .btn { padding:24px 48px; border-radius:20px; background:#E8492B; color:#fff; font-size:50px; font-weight:600; }
.e-cta .url { font-size:58px; font-weight:600; letter-spacing:-0.01em; }
.e-os { position:absolute; left:504px; top:800px; font-size:54px; color:#78716C; font-weight:500; }
.e-fine { position:absolute; left:0; right:0; top:1000px; text-align:center; font-size:28px; color:#A8A29E; }
`;
const ICON = `<svg class="e-icon" viewBox="0 0 100 100">
  <rect class="p-paper" x="4" y="4" width="92" height="92" rx="20" fill="#F6F0E2" stroke="#E2D8C2" stroke-width="1.2"/>
  ${[24, 36, 48, 60, 72, 84].map(y => `<line class="p-line" x1="4" y1="${y}" x2="96" y2="${y}" stroke="#E4DAC6" stroke-width="0.9"/>`).join('')}
  <line class="p-margin" x1="22" y1="4" x2="22" y2="96" stroke="#D88B7B" stroke-width="1.1"/>
  <rect class="p-hl" x="30" y="33" width="48" height="13" rx="2" fill="#F8E7A3"/>
  <path class="p-tri" d="M42 36 L72 52 L42 68 Z" fill="#2E6B4F"/>
</svg>`;
const BIG = { x: 750, y: 270, s: 1.4 };            // icon centred, 420px (visual top-left)
const LOCK = { x: 500, y: 300, s: 0.83 };        // icon in the lockup, ~250px
const TRI = { x: 54 / 100, y: 52 / 100 };          // triangle centroid in icon space

export function mountEnd(root) {
  document.head.append(h(`<style>${CSS}</style>`));
  const L = h(`<div class="layer"></div>`); root.append(L);
  const wrap = h(`<div class="e-wrap"></div>`);
  const icon = h(ICON);
  const dot = h(`<div class="e-dot"></div>`);
  const name = h(`<div class="e-name">LinguaClip</div>`);
  const tag = h(`<div class="e-tag">播客精听</div>`);
  const cta = h(`<div class="e-cta"><span class="btn">免费下载</span><span class="url">linguaclipapp.com</span></div>`);
  const os = h(`<div class="e-os">Mac · Windows 桌面 App · 开源</div>`);
  const fine = h(`<div class="e-fine">界面为示意重绘，示例节目与句子为演示内容 · 开场画面由 AI 生成</div>`);
  wrap.append(icon, name, tag, cta, os);
  const ctaBtn = $(cta, '.btn'); ctaBtn.style.display = 'inline-block';
  L.append(wrap, dot, fine);
  const paper = $(icon, '.p-paper'), lines = $$(icon, '.p-line'), margin = $(icon, '.p-margin'), hl = $(icon, '.p-hl'), tri = $(icon, '.p-tri');
  for (const el of [paper, ...lines, margin, hl, tri]) el.style.transformBox = 'fill-box';
  paper.style.transformOrigin = tri.style.transformOrigin = '50% 50%';
  lines.forEach(el => (el.style.transformOrigin = '0% 50%')); margin.style.transformOrigin = '50% 0%'; hl.style.transformOrigin = '0% 50%';

  return (t) => {
    const on = t > 51.95; L.style.display = on ? 'block' : 'none'; if (!on) return;
    const m = eio(prog(t, 53.45, 54.35));
    const ic = { x: lerp(BIG.x, LOCK.x, m), y: lerp(BIG.y, LOCK.y, m), s: lerp(BIG.s, LOCK.s, m) };
    const asm = eout(prog(t, 52.55, 54.0));
    icon.style.transformOrigin = '50% 50%';
    set(icon, { x: ic.x - 150 * (1 - ic.s), y: ic.y - 150 * (1 - ic.s), s: ic.s * lerp(0.62, 1, asm), r: lerp(-14, 0, asm) });
    const svgSet = (el, sx, sy, o) => { el.style.transform = `scale(${sx},${sy})`; el.style.opacity = o; };
    const pk = eout(prog(t, 52.55, 53.0));
    svgSet(paper, lerp(0.4, 1, pk), lerp(0.4, 1, pk), pk);
    lines.forEach((el, i) => { const k = eout(prog(t, 53.0 + i * 0.05, 53.35 + i * 0.05)); svgSet(el, k, 1, 1); });
    const mk = eout(prog(t, 53.2, 53.5)); svgSet(margin, 1, mk, 1);
    const hk = eout(prog(t, 53.35, 53.65)); svgSet(hl, hk, 1, 1);
    const tk = eout(prog(t, 53.5, 53.8)); svgSet(tri, lerp(0.4, 1, tk), lerp(0.4, 1, tk), tk);

    // the red dot: flies from the 打开 button to where the triangle will sit, then hands over
    const tx = BIG.x + TRI.x * 300 * BIG.s, ty = BIG.y + TRI.y * 300 * BIG.s;
    const fk = eio(prog(t, 52.15, 52.95));
    const ox = OPEN.x ?? 960, oy = OPEN.y ?? 540;
    const dOut = prog(t, 53.5, 53.75);
    set(dot, { show: t < 53.8, x: lerp(ox, tx, fk) + Math.sin(fk * Math.PI) * -60, y: lerp(oy, ty, fk) - Math.sin(fk * Math.PI) * 120,
      s: lerp(1, 1.9, fk) * (1 - dOut * 0.5), o: 1 - dOut });

    const r = (a) => eout(prog(t, a, a + 0.45));
    set(name, { o: r(53.85), x: lerp(60, 0, r(53.85)) });
    set(tag, { o: r(54.05), x: lerp(60, 0, r(54.05)) });
    set(cta, { o: r(54.35), y: lerp(30, 0, r(54.35)) });
    const pulse = t > 55.4 ? Math.max(0, Math.sin((t - 55.4) * Math.PI / 1.2)) ** 6 : 0;
    set(ctaBtn, { s: 1 + 0.09 * pulse });
    set(os, { o: r(54.55), y: lerp(20, 0, r(54.55)) });
    set(fine, { o: r(55.1) * 1 });
    set(wrap, { s: lerp(0.94, 1, eout(prog(t, 52.6, 54.6))) + 0.05 * prog(t, 54.6, 60), y: -24 * prog(t, 54.6, 60) });
  };
}
