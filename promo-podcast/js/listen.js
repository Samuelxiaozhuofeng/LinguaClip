// Listening scenes (13.4–41s): the 精听 window walks one section through blind → transcript → blind → dictation.
import { C, prog, lerp, eout, ein, eio, life, set, makeCursor, cam, $ } from './core.js';
import { SAVED } from './shared.js';
import { buildListen, DICT } from './listen-ui.js';

export const CARRY = {};                 // rect of the recommended-show row, picked up by act3

const DICT2 = ["I'd", 'play', 'one', 'short', 'part,', 'then', 'stop', 'and', 'ask', 'what', 'I', 'heard.'];
const CAM = [
  { t: 13.4, s: 1.000, x: 0, y: 0 }, { t: 15.8, s: 1.05, x: -24, y: 12 }, { t: 18.3, s: 1.015, x: 20, y: 0 }, { t: 21.0, s: 1.055, x: 26, y: 14 },
  { t: 23.5, s: 1.07, x: -20, y: -6 }, { t: 26.4, s: 1.02, x: 10, y: 0 }, { t: 28.8, s: 1.06, x: -26, y: 14 }, { t: 30.9, s: 1.02, x: 20, y: 0 },
  { t: 33.4, s: 1.065, x: -16, y: 10 }, { t: 35.8, s: 1.01, x: 10, y: 0 }, { t: 38.4, s: 1.06, x: 22, y: 10 }, { t: 40.45, s: 1.000, x: 0, y: 0 },
];
const CHAP = [[13.0, 20.85], [21.05, 26.5], [26.75, 30.1], [30.3, 35.7], [35.9, 37.3], [37.5, 40.55]];
const DIM = [[18.35, 18.6, 20.55, 20.8], [26.55, 26.75, 27.3, 27.5], [30.15, 30.35, 31.2, 31.45], [37.15, 37.4, 40.3, 40.6]];

export function mountListen(root) {
  const U = buildListen(root);
  U.L.style.display = 'block';            // measure in real layout; draw() hides it again
  const R0 = root.getBoundingClientRect();
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - R0.left + r.width / 2, y: r.top - R0.top + r.height / 2, r }; };
  // second sentence slots live next to the first set
  const slots2 = DICT2.map(w => { const el = U.slots[0].cloneNode(); el.dataset.w = w; return el; });
  const box2 = U.slots[0].parentElement.cloneNode(); box2.append(...slots2); U.slots[0].parentElement.after(box2);

  // measure click targets once, in their settled layout
  U.tip.style.display = 'block';
  const show = $(U.tip, '.show').getBoundingClientRect();
  Object.assign(CARRY, { x: show.left - R0.left, y: show.top - R0.top, w: show.width, h: show.height });
  const pLittle = at(U.opts[2]);
  U.tip.style.display = 'none';
  const P = { half: at(U.opts[1]), go: at(U.go), word: at(U.ov), star: at(U.stars[8]), pass: at($(U.pass, '.btn')),
    sum: at($(U.sum, '.btn')), done: at($(U.done, '.btn')), little: pLittle };
  const cursor = makeCursor(U.stage);
  const KEYS = [
    { t: 18.9, x: 1600, y: 1000 }, { t: 19.5, x: P.half.x, y: P.half.y, click: 1 }, { t: 20.35, x: P.go.x, y: P.go.y, click: 1, mv: 0.5 },
    { t: 22.7, x: 1500, y: 1000, mv: 0.01 }, { t: 23.55, x: P.word.x, y: P.word.y + 6, click: 1, mv: 0.6 },
    { t: 25.7, x: P.star.x, y: P.star.y, click: 1, mv: 0.7 }, { t: 27.15, x: P.pass.x, y: P.pass.y, click: 1, mv: 0.9 },
    { t: 30.95, x: P.sum.x, y: P.sum.y, click: 1, mv: 0.55 }, { t: 35.75, x: P.done.x, y: P.done.y, click: 1, mv: 0.6 },
    { t: 37.95, x: P.little.x, y: P.little.y, click: 1, mv: 0.55 },
  ];
  const CUR_ON = [[18.85, 20.75], [22.65, 26.05], [26.65, 27.45], [30.4, 31.25], [35.15, 36.0], [37.35, 38.5]];

  return (t) => {
    const on = t > 12.9 && t < 41.1; U.L.style.display = on ? 'block' : 'none'; if (!on) return;
    set(U.stage, cam(t, CAM));

    // window in from the grown section, out when the recommended show is carried away
    const wOut = eio(prog(t, 40.45, 40.95));
    set(U.win, { o: eout(prog(t, 12.95, 13.25)) * (1 - wOut), s: 1 - 0.04 * wOut });

    // step bar
    const stIn = eout(prog(t, 13.7, 14.15));
    let cur = 0, done = 0, secN = 2;
    if (t >= 20.6) { cur = 1; done = 1; } if (t >= 27.2) { cur = 2; done = 2; } if (t >= 30.25) { cur = 3; done = 3; }
    if (t >= 35.8) { cur = 0; done = 0; secN = 3; }
    const since = t >= 35.8 ? 35.8 : [13.95, 20.6, 27.2, 30.25][cur];
    const pop = 0.1 * (1 - eout(prog(t, since, since + 0.35)));
    U.steps.forEach((el, i) => {
      el.classList.toggle('cur', i === cur); el.classList.toggle('done', i < done);
      el.firstChild.textContent = i < done ? '✓' : String(i + 1);
      set(el, { o: stIn, y: lerp(-24, 0, stIn), s: 1 + (i === cur ? pop : 0) });
    });
    U.sec.textContent = `第 ${secN} 段 / 共 6 段`;
    set(U.sec, { o: t >= 35.8 ? eout(prog(t, 35.8, 36.1)) : stIn });

    // chapter headings: the outgoing one leaves before the next arrives
    U.chaps.forEach((el, i) => {
      const [a, b] = CHAP[i];
      const k = life(t, a, a + 0.38, b - 0.22, b);
      set(el, { show: k > 0, o: k, y: t < a + 0.38 ? lerp(40, 0, k) : lerp(-30, 0, k) });
    });

    // blind screen: step 1 (13.6–21.3), step 3 (28.05–30.3), next section (35.95–37.2)
    const blindOn = (t > 12.9 && t < 21.3) || (t > 28.0 && t < 31.5) || (t > 35.9 && t < 40.6);
    set(U.blind, { show: blindOn, o: t > 35.9 ? eout(prog(t, 35.95, 36.25)) : 1 });
    let idx = -1;
    if (t < 21.3) idx = Math.min(11, Math.floor((t - 14.0) / 0.36));
    else if (t < 31.5) idx = Math.min(11, Math.floor((t - 28.55) / 0.34));
    else idx = Math.min(11, Math.floor((t - 36.3) / 0.36));
    if (t > 18.3 && t < 21.3) idx = 12;   // pass finished
    U.cells.forEach((el, i) => {
      el.className = 'cell' + (i < idx ? ' past' : i === idx ? ' cur' : '');
      const flip = t < 27 ? prog(t, 20.9 + i * 0.02, 21.2 + i * 0.02) : 0;
      set(el, { rx: flip * 90, o: 1 - flip * 0.6 });
    });
    U.cnt.textContent = `本段第 ${Math.max(1, Math.min(12, idx + 1))} 句 / 共 12 句`;
    U.hint.textContent = t > 27 && t < 35 ? '关掉文字稿再听一遍，看看现在能听懂多少。可以小声跟着说。' : '只管听，没听懂的地方按 S 做个记号。';
    // step 3 re-entry: cells grow out of the folded beam
    const grow = t > 27.9 && t < 31.5 ? eout(prog(t, 28.05, 28.45)) : 1;
    set(U.cellsBox, { sx: grow, sy: lerp(0.08, 1, grow) });
    [U.hp, U.cnt, U.hint].forEach(el => set(el, { o: t > 27.9 && t < 31.5 ? eout(prog(t, 28.2, 28.5)) : 1 }));

    // S key + toast (saves line 5 during the first blind pass)
    const kOn = life(t, 15.0, 15.3, 17.2, 17.5);
    const press = t > 15.55 && t < 15.75 ? 1 : 0;
    set(U.key, { show: kOn > 0, o: kOn, y: lerp(30, 0, kOn) + press * 8 });
    U.key.style.boxShadow = press ? '0 2px 0 #E7E5E4,0 8px 20px rgba(0,0,0,.08)' : '0 10px 0 #E7E5E4,0 20px 40px rgba(0,0,0,.08)';
    const toast = life(t, 15.6, 15.8, 16.7, 16.95) + life(t, 25.75, 25.95, 26.6, 26.85);
    set(U.toast, { show: toast > 0, o: toast, y: lerp(20, 0, toast) });

    // dimmer + cards
    const dim = DIM.reduce((m, d) => Math.max(m, life(t, ...d)), 0);
    set(U.dim, { show: dim > 0, o: dim });
    const card = (el, a, b, c, d) => { const k = life(t, a, b, c, d); set(el, { show: k > 0, o: k, y: lerp(70, 0, k) }); };
    card(U.heard, 18.4, 18.8, 20.5, 20.8);
    if (t > 37) card(U.heard, 37.2, 37.6, 40.25, 40.55);
    card(U.pass, 26.55, 26.9, 27.25, 27.5);
    card(U.sum, 30.15, 30.5, 31.15, 31.45);
    const k2 = t > 37;
    U.opts[1].classList.toggle('on', !k2 && t >= 19.5);
    U.opts[2].classList.toggle('on', k2 && t >= 37.95);
    U.tip.style.display = k2 && t >= 38.05 ? 'block' : 'none';
    set(U.tip, { o: eout(prog(t, 38.05, 38.35)) });
    U.go.style.display = k2 ? 'none' : 'inline-block';
    if (k2) set($(U.tip, '.show'), { o: 1 - prog(t, 40.45, 40.55) });   // act3 takes the row from here

    // transcript (step 2), folding into a beam (step 3)
    const trOn = t > 21.15 && t < 28.1;
    set(U.trans, { show: trOn, rx: eio(prog(t, 27.45, 27.95)) * 84, sy: lerp(1, 0.04, ein(prog(t, 27.6, 28.0))), o: 1 - prog(t, 27.9, 28.05) });
    let line = Math.min(11, Math.floor((t - 21.8) / 0.28));
    if (t > 23.6 && t < 24.9) line = 6; else if (t >= 24.9) line = Math.min(11, 6 + Math.floor((t - 24.9) / 0.32));
    U.tls.forEach((el, i) => {
      const k = eout(prog(t, 21.2 + i * 0.03, 21.55 + i * 0.03));
      el.classList.toggle('cur', i === line);
      set(el, { rx: (1 - k) * -90, o: k });
    });
    U.stars.forEach((el, i) => {
      const lit = (i === SAVED[0]) || (i === SAVED[1] && t >= 25.7);
      el.classList.toggle('on', lit); el.textContent = lit ? '★' : '☆';
      if (i === SAVED[1]) set(el, { s: t >= 25.7 ? lerp(1.6, 1, eout(prog(t, 25.7, 26.0))) : 1 });
    });
    U.ov.classList.toggle('w-hl', t >= 23.55 && t < 24.9);
    const beam = life(t, 27.85, 28.0, 28.1, 28.45);
    set(U.beam, { show: beam > 0, o: beam, sx: lerp(0.6, 1, eout(prog(t, 27.85, 28.05))) });

    // definition popover (part of the window body, positioned at the word)
    defn(t, U, P.word);

    // dictation (step 4)
    const dOn = t > 31.3 && t < 36.2;
    set(U.dict, { show: dOn, o: life(t, 31.3, 31.6, 35.85, 36.15) });
    const two = t >= 34.75;
    U.dn.textContent = two ? '2' : '1';
    set(U.slots[0].parentElement, { show: !two, o: 1 });
    set(box2, { show: two, o: eout(prog(t, 34.75, 34.95)), x: lerp(60, 0, eout(prog(t, 34.75, 34.95))) });
    let clock = 31.9;
    U.slots.forEach((el, i) => {
      const w = DICT[i], start = clock;
      let text, cls = 'slot';
      if (w === 'catch') {
        const wrong = 'cash';
        if (t < start) text = ''; else if (t < start + 0.2) text = wrong.slice(0, Math.floor((t - start) / 0.05) + 1);
        else if (t < start + 0.7) { text = wrong; cls += ' bad'; } else if (t < start + 0.95) { text = w.slice(0, Math.floor((t - start - 0.7) / 0.05) + 1); cls += ' cur'; }
        else { text = w; cls += ' ok'; }
        clock += 1.05;
      } else {
        text = t < start ? '' : w.slice(0, Math.floor((t - start) / 0.045) + 1);
        cls += text.length === w.length ? ' ok' : t >= start ? ' cur' : '';
        clock += w.length * 0.045 + 0.1;
      }
      el.textContent = text; el.className = cls;
    });
    slots2.forEach((el, i) => {
      const k = prog(t, 34.8 + i * 0.035, 34.86 + i * 0.035);
      el.textContent = k > 0 ? el.dataset.w : ''; el.className = 'slot' + (k >= 1 ? ' ok' : '');
    });
    set(U.done, { o: eout(prog(t, 35.25, 35.45)), y: lerp(20, 0, eout(prog(t, 35.25, 35.45))) });

    // pointer
    const vis = CUR_ON.find(([a, b]) => t >= a - 0.01 && t <= b + 0.01);
    cursor(t, KEYS, vis ? [vis[0], vis[0] + 0.15, vis[1] - 0.15, vis[1]] : [0, 0, 0, 0]);
  };
}

let defEl = null;
function defn(t, U, word) {
  if (!defEl) {
    defEl = document.createElement('div'); defEl.className = 'def';
    defEl.innerHTML = '<b>overwhelmed</b><small>/ˌoʊvərˈwelmd/</small><br><span class="pos">adj. 形容词</span><p>被压得喘不过气的；不知所措的。这句里是说：他们一说快，我就跟不上、有点慌。</p>';
    U.stage.append(defEl);
  }
  const k = life(t, 23.62, 23.85, 24.65, 24.85);
  defEl.style.left = word.r.left - 160 + 'px'; defEl.style.top = word.r.top - defEl.offsetHeight - 22 + 'px';   // above the word: the frame's bottom edge is close
  set(defEl, { show: k > 0, o: k, y: lerp(16, 0, k), s: lerp(0.96, 1, k) });
}
