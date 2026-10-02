// Act 1 (0–13.6s): hook photo → wall of shows → one episode's waveform → cut into sections with transcript.
import { C, prog, lerp, eout, eout5, ein, eio, sstep, life, rnd, h, $, $$, set, cam } from './core.js';
import { SHOWS, WIN } from './shared.js';

const CSS = `
.a1-img { position:absolute; left:-96px; top:-54px; width:2112px; height:1188px; object-fit:cover; transform-origin:70% 40%; }
.a1-head { position:absolute; left:120px; top:330px; font-size:132px; font-weight:600; letter-spacing:-0.03em; line-height:1.18; white-space:nowrap; }
.a1-l2 { display:block; }
.a1-back { position:absolute; left:64px; top:290px; width:1150px; height:420px; border-radius:36px; background:#fff;
  box-shadow:0 30px 90px rgba(28,25,23,.18); }
.a1-wall { position:absolute; left:0; top:0; width:1920px; }
.wcard { position:absolute; width:400px; height:170px; background:#fff; border-radius:22px; padding:30px 32px;
  box-shadow:0 1px 3px rgba(0,0,0,.06), 0 10px 30px rgba(28,25,23,.08); }
.wcard b { display:block; font-size:30px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wcard span { display:inline-block; margin-top:22px; margin-right:10px; font-size:22px; color:#78716C; background:#F4F4F3; padding:5px 14px; border-radius:999px; }
.wcard.sel { outline:5px solid #E8492B; }
.a1-panel { position:absolute; background:#fff; border-radius:30px; overflow:hidden;
  box-shadow:0 1px 3px rgba(0,0,0,.06), 0 30px 80px rgba(28,25,23,.12); }
.a1-ph { position:absolute; left:60px; top:52px; display:flex; align-items:center; gap:26px; }
.a1-ph i { width:84px; height:84px; border-radius:22px; background:#FDECE8; display:flex; align-items:center; justify-content:center; }
.a1-ph b { font-size:46px; font-weight:600; display:block; } .a1-ph small { font-size:28px; color:#78716C; }
.a1-time { position:absolute; right:60px; top:74px; font-size:34px; color:#78716C; font-variant-numeric:tabular-nums; }
.a1-wave { position:absolute; left:0; top:0; transform-origin:0 0; overflow:visible; }
.a1-pc { position:absolute; left:32px; top:30px; white-space:nowrap; }
.a1-pc b { display:block; font-size:30px; font-weight:600; } .a1-pc span { display:inline-block; margin-top:22px; margin-right:10px; font-size:22px; color:#78716C; background:#F4F4F3; padding:5px 14px; border-radius:999px; }
.a1-q { position:absolute; font-size:30px; font-weight:600; color:#78716C; background:#F4F4F3; border:2px dashed #D6D3D1; border-radius:14px; padding:4px 14px; }
.a1-headC { position:absolute; left:96px; top:150px; font-size:100px; font-weight:600; letter-spacing:-0.02em; white-space:nowrap; }
.a1-fly { position:absolute; left:0; top:0; width:1920px; height:1080px; display:flex; align-items:center; justify-content:center;
  font-size:300px; font-weight:700; color:#E8492B; letter-spacing:0.02em; }
.a1-gloss { position:absolute; left:0; right:0; top:760px; text-align:center; font-size:56px; font-weight:600; color:#1C1917; }
.a1-headD { position:absolute; left:96px; top:86px; font-size:78px; font-weight:600; letter-spacing:-0.02em; white-space:nowrap; }
.a1-subD { position:absolute; left:98px; top:196px; font-size:42px; color:#78716C; font-weight:500; }
.a1-chip { position:absolute; left:96px; top:640px; padding:18px 30px; background:#fff; border-radius:999px; font-size:34px; font-weight:500;
  box-shadow:0 8px 30px rgba(28,25,23,.1); display:flex; align-items:center; gap:22px; }
.a1-chip .bar { width:260px; height:10px; border-radius:5px; background:#F4F4F3; overflow:hidden; } .a1-chip .bar i { display:block; height:100%; background:#E8492B; }
.a1-cut { position:absolute; width:4px; background:#E8492B; border-radius:2px; }
.a1-sec { position:absolute; top:610px; height:400px; border-radius:20px; padding:22px 20px; }
.a1-sec .lab { font-size:30px; font-weight:600; margin-bottom:18px; }
.a1-sec p { font-size:19px; line-height:1.5; color:#57534E; margin-bottom:10px; }
.a1-grow { position:absolute; border-radius:24px; background:#FDECE8; }
`;

const COLS = [120, 548, 976, 1404], ROWS = 12, CARD_H = 198;
const SEL = { col: 3, row: 9 };
const W_END = -1400;                       // wall offset when it brakes
const P = { x: 96, y: 380, w: 1728, h: 600 }; // episode panel
const WAVE = { w: 1380, h: 220, bars: 150 };
const MISSED = [[0.22, 0.31], [0.52, 0.59], [0.74, 0.83]];
const CUTS = [0, 0.18, 0.35, 0.52, 0.68, 0.84, 1];
const CAM = [{ t: 5.6, s: 1, x: 0, y: 0 }, { t: 8.9, s: 1.06, x: -20, y: -16 }, { t: 10.2, s: 1.02, x: 0, y: 0 }, { t: 11.8, s: 1.05, x: -40, y: 10 }, { t: 13.5, s: 1, x: 0, y: 0 }];
const D_WAVE = { x: 96, y: 330, s: 1728 / 1380 };

export function mountAct1(root) {
  document.head.append(h(`<style>${CSS}</style>`));
  const L = h(`<div class="layer"></div>`); root.append(L);

  // A: photo + headline (headline is carried into B on a white backing)
  const img = h(`<img class="a1-img" src="assets/img/hook.jpg">`);
  const wall = h(`<div class="a1-wall"></div>`);
  const cards = [];
  for (let c = 0; c < 4; c++) for (let r = 0; r < ROWS; r++) {
    const isSel = c === SEL.col && r === SEL.row;
    const s = isSel ? SHOWS[0] : SHOWS[(c * 7 + r * 3 + 1) % SHOWS.length];
    const el = h(`<div class="wcard"><b>${s[0]}</b><span>${s[1]}</span><span>${s[2]}</span><span>${s[3]}</span></div>`);
    el.style.left = COLS[c] + 'px'; el.style.top = 60 + r * CARD_H + 'px';
    wall.append(el); cards.push({ el, c, r, isSel });
  }
  const back = h(`<div class="a1-back"></div>`);
  const head = h(`<div class="a1-head"><span class="a1-l1">播客听了不少，</span><span class="a1-l2">还是只听懂<span class="red">一半</span>？</span></div>`);
  const l2 = $(head, '.a1-l2');

  // C: episode panel + waveform
  const panel = h(`<div class="a1-panel"><div class="a1-ph"><i><svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#E8492B" stroke-width="2" stroke-linecap="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg></i><div><small>一集播客 · 演示</small><b>Episode 12</b></div></div><div class="a1-time">18:40</div><div class="a1-pc"><b>${SHOWS[0][0]}</b><span>${SHOWS[0][1]}</span><span>${SHOWS[0][2]}</span><span>${SHOWS[0][3]}</span></div></div>`);
  const pc = $(panel, '.a1-pc');
  const ph = $$(panel, '.a1-ph, .a1-time');
  const bars = [];
  let svg = `<svg class="a1-wave" width="${WAVE.w}" height="${WAVE.h}" viewBox="0 0 ${WAVE.w} ${WAVE.h}">`;
  for (let i = 0; i < WAVE.bars; i++) {
    const f = i / (WAVE.bars - 1), env = 0.35 + 0.65 * Math.abs(Math.sin(f * 9.3 + 1.1)) * (0.55 + 0.45 * rnd(i));
    const bh = Math.max(14, env * WAVE.h * 0.92);
    svg += `<rect x="${(f * (WAVE.w - 6)).toFixed(1)}" y="${((WAVE.h - bh) / 2).toFixed(1)}" width="6" height="${bh.toFixed(1)}" rx="3"/>`;
  }
  svg += `<line class="ph-line" x1="0" y1="-18" x2="0" y2="${WAVE.h + 18}" stroke="#E8492B" stroke-width="4"/><circle class="ph-dot" cx="0" cy="-22" r="14" fill="#E8492B"/></svg>`;
  const wave = h(svg);
  $$(wave, 'rect').forEach((el, i) => bars.push({ el, f: i / (WAVE.bars - 1) }));
  const phLine = $(wave, '.ph-line'), phDot = $(wave, '.ph-dot');
  const qs = MISSED.map(() => h(`<div class="a1-q">没听懂</div>`));
  const headC = h(`<div class="a1-headC">没听懂的地方，就这么<span class="red">滑过去</span>了。</div>`);
  const fly = h(`<div class="a1-fly">精听</div>`);
  const fog = h(`<div class="abs" style="inset:0;background:#FAFAFA"></div>`);
  const gloss = h(`<div class="a1-gloss">一段一段听，把没听懂的地方听懂</div>`);

  // D: decomposition
  const headD = h(`<div class="a1-headD">导入一集，在你电脑上生成文字稿</div>`);
  const subD = h(`<div class="a1-subD">再自动切成几分钟一段</div>`);
  const chip = h(`<div class="a1-chip">生成文字稿中…<span class="bar"><i></i></span></div>`);
  const chipBar = $(chip, '.bar i');
  const cuts = CUTS.slice(1, -1).map(() => h(`<div class="a1-cut"></div>`));
  const TXT = ['So, last week I started taking the early train…', "It's quieter, and honestly…", 'I usually put on a podcast…', "But here's the thing…", "Whole minutes would go by…", 'And I\'d tell myself…'];
  const secs = CUTS.slice(0, -1).map((a, i) => {
    const el = h(`<div class="a1-sec"><div class="lab">第 ${i + 1} 段</div>${[0, 1, 2].map(k => `<p class="serif">${TXT[(i * 2 + k) % TXT.length]}</p>`).join('')}</div>`);
    const x0 = D_WAVE.x + a * WAVE.w * D_WAVE.s, x1 = D_WAVE.x + CUTS[i + 1] * WAVE.w * D_WAVE.s;
    el.style.left = x0 + 8 + 'px'; el.style.width = x1 - x0 - 16 + 'px';
    return { el, ps: $$(el, 'p'), lab: $(el, '.lab'), x0, x1 };
  });
  const grow = h(`<div class="a1-grow"></div>`);

  L.append(img, wall, back, head, panel, wave, ...qs, headC, headD, subD, chip, ...cuts, ...secs.map(s => s.el), grow, fog, fly, gloss);

  const wallY = t => lerp(1150, W_END, eout5(prog(t, 2.55, 5.0)));
  const selRect = () => ({ x: COLS[SEL.col], y: 60 + SEL.row * CARD_H + W_END, w: 400, h: 170 });

  return (t) => {
    const on = t < 13.75; L.style.display = on ? 'block' : 'none'; if (!on) return;
    set(L, cam(t, CAM));

    // ── A: photo, slow push, then slides up to reveal the wall
    const imgOut = ein(prog(t, 2.55, 3.25));
    set(img, { show: t < 3.3, s: 1.0 + 0.05 * prog(t, 0, 3.3), y: -1150 * imgOut });

    // ── headline: line 1 from frame 0; line 2 at 3.0; leaves left at 5.2
    const hOut = ein(prog(t, 5.15, 5.6));
    set(head, { show: t < 5.6, x: -1300 * hOut, y: lerp(0, -60, eout(prog(t, 2.6, 3.1))) });
    const l2in = eout(prog(t, 3.0, 3.45));
    set(l2, { o: l2in, x: lerp(-60, 0, l2in) });
    const bIn = eout(prog(t, 2.6, 3.05));
    set(back, { show: t > 2.6 && t < 5.6, o: bIn, x: -1300 * hOut, y: -60, s: lerp(0.94, 1, bIn) });

    // ── B: the wall races up and brakes; the selected card lights
    const wy = wallY(t);
    set(wall, { show: t > 2.55 && t < 5.75, y: wy });
    const selOn = t >= 4.95;
    for (const k of cards) {
      if (k.isSel) {
        k.el.classList.toggle('sel', selOn);
        set(k.el, { s: selOn ? lerp(1.08, 1.03, eout(prog(t, 4.95, 5.2))) : 1, o: t < 5.05 ? 1 : 0 });
      } else {
        const out = prog(t, 5.05 + (k.c * 0.03), 5.45);
        set(k.el, { o: 1 - out, blur: out * 10 });
      }
    }

    // ── C: selected card → episode panel (FLIP), waveform, missed parts slide by
    const fk = eio(prog(t, 5.05, 5.85));
    const s0 = selRect();
    const pr = { x: lerp(s0.x, P.x, fk), y: lerp(s0.y, P.y, fk), w: lerp(s0.w, P.w, fk), h: lerp(s0.h, P.h, fk) };
    const pOut = prog(t, 9.0, 9.3);
    set(panel, { show: t >= 5.05 && t < 9.35, o: 1 - pOut });
    Object.assign(panel.style, { left: pr.x + 'px', top: pr.y + 'px', width: pr.w + 'px', height: pr.h + 'px' });
    ph.forEach(el => set(el, { o: eout(prog(t, 5.55, 5.95)) }));
    set(pc, { o: 1 - prog(t, 5.3, 5.55) });

    const play = prog(t, 6.0, 9.0);
    const dk = eio(prog(t, 9.6, 10.35));      // carry into D
    const scale = (pr.w / P.w) * (P.w - 120) / WAVE.w;
    const cx = pr.x + 60 * (pr.w / P.w), cy = pr.y + 250 * (pr.w / P.w);
    set(wave, { show: t >= 5.5, o: eout(prog(t, 5.55, 5.95)), x: lerp(cx, D_WAVE.x, dk), y: lerp(cy, D_WAVE.y, dk), s: lerp(scale, D_WAVE.s, dk) });
    const playX = play * (WAVE.w - 6);
    const showHead = t < 9.1;
    phLine.setAttribute('transform', `translate(${playX},0)`); phDot.setAttribute('transform', `translate(${playX},0)`);
    phLine.style.opacity = phDot.style.opacity = showHead ? 1 - prog(t, 9.0, 9.1) : 0;
    const transcribed = prog(t, 10.35, 11.15);   // D: the chip's progress turns every bar solid
    for (const b of bars) {
      const missed = MISSED.some(([a, z]) => b.f >= a && b.f <= z);
      let col = b.f * (WAVE.w - 6) <= playX ? (missed ? C.faint : C.ink) : C.faint;
      if (t >= 9.6) col = b.f <= transcribed ? C.ink : (missed ? C.faint : C.ink);
      b.el.setAttribute('fill', col);
    }
    MISSED.forEach(([a, z], i) => {
      const pass = prog(t, 6.0 + a * 3.0, 6.0 + a * 3.0 + 0.3);
      const out = prog(t, 8.95, 9.15);
      const q = qs[i];
      set(q, { show: t > 6 && t < 9.2, o: eout(pass) * (1 - out), x: cx + ((a + z) / 2) * WAVE.w * scale - 66, y: cy - 86 + 18 * (1 - eout(pass)) });
    });
    const hc = life(t, 5.95, 6.45, 8.95, 9.15);
    set(headC, { show: hc > 0, o: hc, y: lerp(40, 0, eout(prog(t, 5.95, 6.45))) });

    // fly-through
    const fIn = eout(prog(t, 8.85, 9.1)), fGo = ein(prog(t, 9.75, 10.2));
    set(fly, { show: t > 8.85 && t < 10.22, o: fIn * (1 - prog(t, 9.98, 10.2)), s: lerp(0.55, 1, fIn) + 0.05 * prog(t, 9.1, 9.75) + fGo * 13, blur: fGo * 24 });
    const gl = life(t, 9.0, 9.3, 9.7, 9.85);
    set(gloss, { show: gl > 0, o: gl, y: lerp(24, 0, gl) });
    const veil = life(t, 8.85, 9.05, 9.8, 10.15);
    set(fog, { show: veil > 0, o: veil * 0.92 });

    // ── D
    const dOut = prog(t, 12.7, 13.1);
    const hd = eout(prog(t, 10.0, 10.45));
    set(headD, { show: t > 9.95, o: hd * (1 - dOut), y: lerp(-40, 0, hd) });
    set(subD, { show: t > 10.1, o: eout(prog(t, 10.2, 10.6)) * (1 - dOut), x: lerp(-40, 0, eout(prog(t, 10.2, 10.6))) });
    const ch = life(t, 10.25, 10.5, 11.1, 11.3);
    set(chip, { show: ch > 0, o: ch, y: lerp(30, 0, eout(prog(t, 10.25, 10.5))) });
    chipBar.style.width = transcribed * 100 + '%';
    set(wave, { ...(t > 12.95 ? { o: 1 - dOut } : {}) });
    cuts.forEach((el, i) => {
      const k = eout(prog(t, 11.15 + i * 0.07, 11.45 + i * 0.07));
      const x = D_WAVE.x + CUTS[i + 1] * WAVE.w * D_WAVE.s - 2;
      Object.assign(el.style, { left: x + 'px', top: D_WAVE.y - 30 + 'px', height: (WAVE.h * D_WAVE.s + 60) * k + 'px' });
      set(el, { show: t > 11.15 && t < 13.5, o: 1 - dOut });
    });
    secs.forEach((s, i) => {
      const k = eout(prog(t, 11.25 + i * 0.08, 11.6 + i * 0.08));
      const sel = i === 1;
      const fade = sel ? 0 : prog(t, 12.45, 12.75);
      set(s.el, { show: t > 11.25 && t < 13.2, o: k * (1 - fade), y: lerp(40, 0, k), blur: fade * 8 });
      s.el.style.background = sel && t > 12.35 ? `rgba(253,236,232,${eout(prog(t, 12.35, 12.6))})` : 'transparent';
      s.lab.style.color = sel && t > 12.35 ? C.accent : C.ink;
      s.ps.forEach((p, j) => set(p, { o: eout(prog(t, 11.45 + i * 0.08 + j * 0.1, 11.75 + i * 0.08 + j * 0.1)) }));
    });

    // section 2 grows into the app window of the next scene
    const g = eio(prog(t, 12.6, 13.2));
    const s2 = secs[1];
    const gr = { x: lerp(s2.x0 + 8, WIN.x, g), y: lerp(610, WIN.y, g), w: lerp(s2.x1 - s2.x0 - 16, WIN.w, g), h: lerp(400, WIN.h, g) };
    Object.assign(grow.style, { left: gr.x + 'px', top: gr.y + 'px', width: gr.w + 'px', height: gr.h + 'px',
      background: `rgb(${Math.round(lerp(253, 255, g))},${Math.round(lerp(236, 255, g))},${Math.round(lerp(232, 255, g))})` });
    set(grow, { show: t > 12.6 && t < 13.4, o: 1 });
  };
}
