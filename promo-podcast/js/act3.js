// Act 3 (40.4–52.6s): the recommended show lands in a grid of 6 languages × 3 levels, then a pasted link imports an episode.
import { prog, lerp, eout, eio, life, set, h, $, $$, makeCursor, typed, cam } from './core.js';
import { CARRY } from './listen.js';

const CSS = `
.a3-head { position:absolute; left:96px; top:52px; font-size:84px; font-weight:600; letter-spacing:-0.02em; white-space:nowrap; }
.a3-sub { position:absolute; left:98px; top:162px; font-size:44px; font-weight:500; color:#78716C; white-space:nowrap; }
.a3-card { position:absolute; width:552px; height:356px; padding:30px 34px; border-radius:28px; background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.06), 0 18px 50px rgba(28,25,23,.1); }
.a3-card h4 { font-size:44px; font-weight:600; margin-bottom:12px; }
.a3-row { display:flex; align-items:center; gap:14px; height:84px; border-top:2px solid #F4F4F3; white-space:nowrap; }
.a3-row b { flex:1; font-size:36px; font-weight:600; overflow:hidden; text-overflow:ellipsis; }
.a3-row span { flex:none; font-size:30px; font-weight:600; color:#78716C; background:#F4F4F3; padding:6px 16px; border-radius:999px; }
.a3-row span.on { color:#fff; background:#E8492B; }
.a3-carry { position:absolute; display:flex; align-items:center; gap:18px; padding:20px 26px; border-radius:16px; background:#fff; font-size:38px; font-weight:600; transform-origin:0 0; white-space:nowrap; }
.a3-carry span { font-size:30px; color:#78716C; background:#F4F4F3; padding:6px 18px; border-radius:999px; font-weight:500; }
.a3-dlg { position:absolute; left:220px; top:270px; width:1480px; height:770px; padding:52px 64px; }
.a3-dlg h3 { font-size:52px; font-weight:600; margin-bottom:30px; }
.a3-in { height:104px; border-radius:22px; border:3px solid #E7E5E4; background:#FAFAFA; display:flex; align-items:center; padding:0 34px; font-size:38px; color:#A8A29E; white-space:nowrap; overflow:hidden; }
.a3-in.f { border-color:#E8492B; color:#1C1917; background:#fff; }
.a3-caret { display:inline-block; width:4px; height:46px; background:#E8492B; margin-left:3px; }
.a3-show { margin:34px 0 8px; font-size:32px; color:#78716C; }
.a3-ep { display:flex; align-items:center; height:120px; border-top:2px solid #F4F4F3; font-size:40px; }
.a3-ep b { flex:1; font-weight:600; } .a3-ep small { width:380px; color:#78716C; font-size:32px; }
.a3-btn { width:330px; text-align:center; padding:20px 0; border-radius:18px; font-size:34px; font-weight:600; background:#F4F4F3; position:relative; overflow:hidden; }
.a3-btn i { position:absolute; left:0; top:0; bottom:0; background:#FDECE8; } .a3-btn em { position:relative; font-style:normal; }
.a3-btn.go { background:#E8492B; color:#fff; }
.a3-foot { position:absolute; left:64px; bottom:44px; font-size:32px; color:#78716C; }
`;
// Real recommended shows (pro/podcastShows.ts), one per level per language.
const GRID = [
  ['英语', ['6 Minute English', 'All Ears English', "Luke's English Podcast"]],
  ['日语', ['Nihongo con Teppei', 'Japanese with Shun', 'Haru no Nihongo']],
  ['西班牙语', ['Coffee Break Spanish', 'Easy Spanish', 'Radio Ambulante']],
  ['法语', ['Coffee Break French', 'InnerFrench', 'Choses à Savoir']],
  ['德语', ['Slow German', 'Easy German', 'Sozusagen!']],
  ['韩语', ['Talk To Me In Korean', 'Heeya Korean', 'Didi의 한국문화 Podcast']],
];
const LV = ['入门', '中级', '中高级'];
const CAM = [{ t: 40.4, s: 1, x: 0, y: 0 }, { t: 43.4, s: 1.04, x: -20, y: -10 }, { t: 46.0, s: 1.01, x: 0, y: 0 }, { t: 49.2, s: 1.05, x: 0, y: -24 }, { t: 52.15, s: 1, x: 0, y: 0 }];
export const OPEN = {};                 // the import button's centre, picked up by the end card

export function mountAct3(root) {
  document.head.append(h(`<style>${CSS}</style>`));
  const L = h(`<div class="layer"></div>`); root.append(L);
  const head1 = h(`<div class="a3-head">6 种语言 · 23 个推荐节目</div>`);
  const sub1 = h(`<div class="a3-sub">每种语言都分 <span class="red">入门 · 中级 · 中高级</span></div>`);
  const cards = GRID.map(([lang, shows], i) => {
    const el = h(`<div class="a3-card"><h4>${lang}</h4>${shows.map((s, k) => `<div class="a3-row"><b>${s}</b><span>${LV[k]}</span></div>`).join('')}</div>`);
    el.style.left = 96 + (i % 3) * 588 + 'px'; el.style.top = 290 + Math.floor(i / 3) * 384 + 'px';
    return { el, tags: $$(el, '.a3-row span'), first: $(el, '.a3-row b') };
  });
  const carry = h(`<div class="a3-carry">6 Minute English <span>入门</span><span>偏慢</span></div>`);
  const head2 = h(`<div class="a3-head">喜欢的节目，粘贴链接就能导。</div>`);
  const sub2 = h(`<div class="a3-sub">Apple Podcasts 链接或 RSS 地址都行</div>`);
  const dlg = h(`<div class="a3-dlg sheet"><h3>添加播客</h3><div class="a3-in"><span class="txt"></span><span class="a3-caret"></span></div>
    <div class="a3-list"><div class="a3-show">演示节目 · 往期</div>
      ${[['Episode 14', '9月28日 · 21:05'], ['Episode 13', '9月21日 · 19:40'], ['Episode 12', '9月14日 · 18:40']].map(([a, b]) => `<div class="a3-ep"><b>${a}</b><small>${b}</small><div class="a3-btn"><i></i><em>导入</em></div></div>`).join('')}</div>
    <div class="a3-foot">导入 = 下载这一集，在你电脑上生成文字稿。</div></div>`);
  L.append(head1, sub1, ...cards.map(c => c.el), carry, head2, sub2, dlg);
  const inp = $(dlg, '.a3-in'), txt = $(dlg, '.txt'), caret = $(dlg, '.a3-caret'), list = $(dlg, '.a3-list');
  const eps = $$(dlg, '.a3-ep'), btn = $(eps[0], '.a3-btn'), fill = $(btn, 'i'), label = $(btn, 'em');
  L.style.display = 'block';            // measure in real layout; draw() hides it again
  const R0 = root.getBoundingClientRect(), br = btn.getBoundingClientRect(), fr = cards[0].first.getBoundingClientRect();
  const BTN = { x: br.left - R0.left + br.width / 2, y: br.top - R0.top + br.height / 2 };
  const LAND = { x: fr.left - R0.left - 26, y: fr.top - R0.top + fr.height / 2 };   // where the carried row's text lands
  Object.assign(OPEN, BTN);
  const cursor = makeCursor(L);
  const URL = 'https://podcasts.apple.com/cn/podcast/demo-show/id00000000';

  return (t) => {
    const on = t > 40.4 && t < 52.75; L.style.display = on ? 'block' : 'none'; if (!on) return;
    set(L, cam(t, CAM));

    // ── carried row → the English card's first row
    const ck = eio(prog(t, 40.5, 41.2));
    const sc = lerp(1, 32 / 38, ck);
    set(carry, { show: t >= 40.45 && t < 41.3, o: 1 - prog(t, 41.15, 41.3), x: lerp(CARRY.x, LAND.x, ck), y: lerp(CARRY.y, LAND.y - (CARRY.h * sc) / 2, ck), s: sc });

    const gOut = prog(t, 45.85, 46.2);
    const h1 = life(t, 40.65, 41.05, 45.8, 46.05);
    set(head1, { show: h1 > 0, o: h1, y: lerp(36, 0, h1) });
    const s1 = life(t, 40.9, 41.3, 45.8, 46.05);
    set(sub1, { show: s1 > 0, o: s1, x: lerp(-40, 0, s1) });
    cards.forEach((c, i) => {
      const k = i === 0 ? eout(prog(t, 40.6, 40.95)) : eout(prog(t, 40.75 + i * 0.09, 41.15 + i * 0.09));
      set(c.el, { show: t > 40.55 && t < 46.25, o: k * (1 - gOut), y: lerp(60, 0, k) + gOut * 80, blur: gOut * 6 });
      if (i === 0) set(c.first, { o: t < 41.2 ? 0 : 1 });
      // the three levels light up in turn across every language
      c.tags.forEach((tg, lv) => tg.classList.toggle('on', life(t, 41.9 + lv * 0.95 + i * 0.05, 42.0 + lv * 0.95 + i * 0.05, 42.75 + lv * 0.95, 42.85 + lv * 0.95) > 0.5 || (t > 44.9 && lv === 0)));
    });

    // ── paste & import (enters while the grid falls away)
    const h2 = life(t, 46.1, 46.5, 52.0, 52.3);
    set(head2, { show: h2 > 0, o: h2, y: lerp(36, 0, h2) });
    set(sub2, { show: h2 > 0, o: life(t, 46.3, 46.7, 52.0, 52.3) });
    const dk = life(t, 45.95, 46.4, 52.35, 52.7);
    set(dlg, { show: dk > 0, o: dk, y: lerp(90, 0, dk), s: lerp(0.96, 1, dk) });
    const typing = t >= 46.75;
    inp.classList.toggle('f', typing);
    txt.textContent = typing ? typed(t, 46.75, 60, URL) : '粘贴 Apple Podcasts 链接或 RSS 地址';
    set(caret, { show: typing && t < 48.1 });
    const lk = eout(prog(t, 48.0, 48.35));
    set(list, { o: lk, y: lerp(30, 0, lk) });
    eps.forEach((el, i) => set(el, { o: eout(prog(t, 48.05 + i * 0.07, 48.35 + i * 0.07)) }));
    const dl = prog(t, 48.75, 49.95), tr = prog(t, 50.0, 50.95);
    let lab = '导入', pct = 0, go = false;
    if (t >= 48.75 && t < 50.0) { lab = `下载中 ${Math.round(dl * 100)}%`; pct = dl; }
    else if (t >= 50.0 && t < 51.0) { lab = '生成文字稿中'; pct = tr; }
    else if (t >= 51.0) { lab = '已导入 · 打开'; go = true; }
    label.textContent = lab; fill.style.width = pct * 100 + '%'; btn.classList.toggle('go', go);
    set(btn, { s: go ? lerp(1.12, 1, eout(prog(t, 51.0, 51.3))) : 1 });

    cursor(t, [{ t: 47.9, x: 1600, y: 1040 }, { t: 48.7, x: BTN.x, y: BTN.y, click: 1, mv: 0.6 }, { t: 51.75, x: BTN.x + 30, y: BTN.y + 4, click: 1, mv: 0.3 }],
      [47.9, 48.05, 51.95, 52.1]);
  };
}
