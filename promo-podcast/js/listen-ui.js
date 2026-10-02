// DOM for the app window used in the listening scenes (13.4–41s): redrawn from the real 精听 page.
import { h, $, $$ } from './core.js';
import { WIN, STEPS, LINES, SAVED, headCSS } from './shared.js';

const CSS = headCSS + `
.stage { position:absolute; inset:0; transform-origin:50% 55%; }
.win { position:absolute; left:${WIN.x}px; top:${WIN.y}px; width:${WIN.w}px; height:${WIN.h}px; overflow:hidden; }
.w-top { position:absolute; left:0; top:0; right:0; height:104px; border-bottom:2px solid #E7E5E4; display:flex; align-items:center; padding:0 40px; }
.w-title { display:flex; align-items:center; gap:18px; font-size:32px; font-weight:600; width:360px; white-space:nowrap; }
.w-title img { width:52px; height:52px; border-radius:13px; }
.w-steps { flex:1; display:flex; justify-content:center; gap:12px; }
.w-step { display:flex; align-items:center; gap:12px; padding:12px 24px; border-radius:999px; font-size:32px; font-weight:600; color:#78716C; white-space:nowrap; }
.w-step i { font-style:normal; width:40px; height:40px; border-radius:50%; background:#F4F4F3; display:flex; align-items:center; justify-content:center; font-size:24px; }
.w-step.cur { background:#E8492B; color:#fff; } .w-step.cur i { background:rgba(255,255,255,.25); }
.w-step.done i { background:#1C1917; color:#fff; }
.w-sec { width:360px; text-align:right; font-size:30px; color:#78716C; white-space:nowrap; font-variant-numeric:tabular-nums; }
.w-body { position:absolute; left:0; top:106px; right:0; bottom:0; }
.blind { position:absolute; inset:0; }
.blind .hp { position:absolute; left:50%; top:56px; margin-left:-90px; width:180px; height:180px; border-radius:50%; background:#FDECE8; display:flex; align-items:center; justify-content:center; }
.blind .hp svg { width:88px; height:88px; }
.blind .cnt { position:absolute; left:0; right:0; top:262px; text-align:center; font-size:36px; color:#78716C; font-variant-numeric:tabular-nums; }
.cells { position:absolute; left:50%; top:334px; width:1586px; margin-left:-793px; height:112px; display:flex; gap:22px; transform-origin:50% 50%; }
.cell { width:112px; height:112px; border-radius:22px; background:#F4F4F3; border:3px solid #E7E5E4; }
.cell.past { background:#FDECE8; border-color:#FDECE8; } .cell.cur { background:#E8492B; border-color:#E8492B; }
.hint { position:absolute; left:50%; top:520px; width:1240px; margin-left:-620px; padding:30px 40px; border-radius:22px; background:#F4F4F3; font-size:36px; line-height:1.45; color:#44403C; text-align:center; }
.toast { position:absolute; left:50%; bottom:44px; width:300px; margin-left:-150px; padding:20px 0; text-align:center; border-radius:999px; background:#1C1917; color:#fff; font-size:36px; font-weight:600; }
.dim { position:absolute; inset:0; background:rgba(250,250,250,.8); }
.card { position:absolute; left:50%; top:60px; width:1060px; margin-left:-530px; padding:54px 60px; border-radius:32px; background:#fff;
  box-shadow:0 1px 3px rgba(0,0,0,.08), 0 30px 80px rgba(28,25,23,.2); }
.card h3 { font-size:56px; font-weight:600; margin-bottom:14px; } .card .q { font-size:40px; color:#44403C; margin-bottom:34px; line-height:1.4; }
.opts { display:flex; gap:20px; margin-bottom:40px; }
.opt { flex:1; text-align:center; padding:26px 0; border-radius:20px; border:3px solid #E7E5E4; font-size:40px; font-weight:600; }
.opt.on { border-color:#E8492B; background:#FDECE8; color:#E8492B; }
.btn { display:inline-block; padding:24px 46px; border-radius:20px; font-size:40px; font-weight:600; background:#E8492B; color:#fff; }
.btn.ghost { background:#F4F4F3; color:#1C1917; margin-left:16px; }
.tip { margin-top:4px; padding:28px 34px; border-radius:20px; background:#FDECE8; font-size:36px; line-height:1.45; color:#1C1917; }
.tip .show { margin-top:20px; display:flex; align-items:center; gap:18px; padding:20px 26px; border-radius:16px; background:#fff; font-size:38px; font-weight:600; }
.tip .show span { font-size:30px; color:#78716C; background:#F4F4F3; padding:6px 18px; border-radius:999px; font-weight:500; }
.trans { position:absolute; left:50px; right:50px; top:24px; bottom:0; transform-origin:50% 40%; }
.trans .th { font-size:32px; color:#78716C; margin:0 0 12px 26px; }
.tl { position:relative; display:flex; align-items:center; gap:26px; height:57px; padding:0 26px; border-radius:14px; font-size:35px; transform-origin:50% 50%; }
.tl .ts { width:80px; font-size:26px; color:#A8A29E; font-family:'Instrument Sans'; font-variant-numeric:tabular-nums; }
.tl .tx { flex:1; white-space:nowrap; } .tl .st { font-size:40px; color:#D6D3D1; width:44px; text-align:center; }
.tl.cur { background:#FDECE8; } .tl.cur::before { content:''; position:absolute; left:0; top:8px; bottom:8px; width:8px; border-radius:4px; background:#E8492B; }
.tl .st.on { color:#E8492B; }
.w-hl { background:#FBEFB0; border-radius:8px; }
.def { position:absolute; width:720px; padding:36px 42px; border-radius:26px; background:#fff; box-shadow:0 1px 3px rgba(0,0,0,.08), 0 30px 80px rgba(28,25,23,.24); }
.def b { font-size:52px; font-family:'Source Serif 4'; font-weight:600; } .def small { font-size:30px; color:#78716C; margin-left:14px; }
.def p { font-size:36px; line-height:1.45; margin-top:14px; } .def .pos { display:inline-block; margin-top:12px; font-size:28px; padding:4px 16px; border-radius:999px; background:#F4F4F3; color:#57534E; }
.beam { position:absolute; left:100px; right:100px; top:387px; height:8px; border-radius:4px; background:#E8492B; box-shadow:0 0 36px 10px rgba(232,73,43,.45); }
.sum li { list-style:none; display:flex; gap:20px; align-items:flex-start; padding:20px 0; border-top:2px solid #F4F4F3; font-size:34px; line-height:1.35; }
.sum li i { flex:none; width:44px; height:44px; border-radius:10px; background:#E8492B; color:#fff; font-style:normal; display:flex; align-items:center; justify-content:center; font-size:28px; }
.dict { position:absolute; inset:0; }
.dict .cnt { position:absolute; left:0; right:0; top:56px; text-align:center; font-size:36px; color:#78716C; }
.dict .play { position:absolute; left:50%; top:118px; margin-left:-60px; width:120px; height:120px; border-radius:50%; background:#FDECE8; display:flex; align-items:center; justify-content:center; }
.dict .play svg { width:48px; height:48px; }
.slots { position:absolute; left:80px; right:80px; top:290px; display:flex; flex-wrap:wrap; justify-content:center; gap:30px 26px; }
.slot { position:relative; min-width:80px; padding:0 8px 10px; border-bottom:5px solid #D6D3D1; font-size:68px; font-family:'Source Serif 4'; text-align:center; height:104px; }
.slot.ok { border-color:#1C1917; } .slot.bad { border-color:#E8492B; color:#E8492B; } .slot.cur { border-color:#E8492B; }
.dict .done { position:absolute; left:50%; top:620px; transform:translateX(-50%); display:flex; align-items:center; gap:30px; white-space:nowrap; }
.dict .okmark { font-size:40px; font-weight:600; }
`;

const HP = `<svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#E8492B" stroke-width="2" stroke-linecap="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/></svg>`;
const TS = ['0:00', '0:04', '0:08', '0:12', '0:15', '0:20', '0:24', '0:29', '0:31', '0:36', '0:39', '0:43'];
export const DICT = ["Whole", "minutes", "would", "go", "by", "and", "I'd", "catch", "maybe", "half", "of", "it."];

export function buildListen(root) {
  document.head.append(h(`<style>${CSS}</style>`));
  const L = h(`<div class="layer"></div>`); root.append(L);
  const win = h(`<div class="win sheet">
    <div class="w-top"><div class="w-title"><img src="assets/img/icon.png">Episode 12</div>
      <div class="w-steps">${STEPS.map((s, i) => `<div class="w-step"><i>${i + 1}</i>${s}</div>`).join('')}</div>
      <div class="w-sec">第 2 段 / 共 6 段</div></div>
    <div class="w-body">
      <div class="blind"><div class="hp">${HP}</div><div class="cnt">本段第 1 句 / 共 12 句</div>
        <div class="cells">${LINES.map(() => '<div class="cell"></div>').join('')}</div>
        <div class="hint">只管听，没听懂的地方按 S 做个记号。</div></div>
      <div class="beam"></div>
      <div class="trans"><div class="th">对着文字稿再听一遍：点词查释义，没听出来的句子点 ☆ 收藏。</div>
        ${LINES.map((l, i) => `<div class="tl"><span class="ts">${TS[i]}</span><span class="tx serif">${i === 6 ? l.replace('overwhelmed', '<span class="w-ov">overwhelmed</span>') : l}</span><span class="st">${SAVED.includes(i) ? '★' : '☆'}</span></div>`).join('')}</div>
      <div class="dict"><div class="cnt">听写 · 第 <b class="dn">1</b> 句 / 共 2 句</div><div class="play"><svg width="34" height="34" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="#E8492B"/></svg></div>
        <div class="slots">${DICT.map(w => `<div class="slot" data-w="${w}"></div>`).join('')}</div>
        <div class="done"><span class="okmark">✓ 全部写对</span><span class="btn">完成</span></div></div>
      <div class="toast">已收藏</div>
      <div class="dim"></div>
      <div class="card c-heard"><h3>盲听完了</h3><div class="q">盲听时听懂了多少？</div>
        <div class="opts"><div class="opt">大部分</div><div class="opt">一半左右</div><div class="opt">很少</div></div>
        <div class="tip"><div>这个节目对你可能偏难——听懂不到一半时，多听收效不大。</div>
          <div class="show">6 Minute English <span>入门</span><span>偏慢</span></div></div>
        <span class="btn b-go">开始对稿</span></div>
      <div class="card c-pass"><h3>对稿完了</h3><div class="q">最后再盲听一遍，看看现在能听懂多少。</div><span class="btn">开始再盲听</span></div>
      <div class="card c-sum sum"><h3>第 2 段学完了</h3><div class="q">收藏的句子（2）</div>
        <ul>${SAVED.map(i => `<li><i>✓</i><span class="serif">${LINES[i]}</span></li>`).join('')}</ul>
        <div style="margin-top:26px"><span class="btn">听写选中的 2 句</span><span class="btn ghost">下一段</span></div></div>
    </div></div>`);
  const chaps = [
    ['1', '先盲听。', '没听懂，按 S 收藏。'],
    ['2', '对稿。', '点词就查，难句点 ☆。'],
    ['3', '再盲听。', '关掉稿子，看看听懂多少。'],
    ['4', '听写。', '收藏的难句，一个词一个词写出来。'],
    ['', '一段一段来。', '精听到第 3 段 / 共 6 段'],
    ['', '听懂很少？', '连着两段都这样，它会推荐简单点的节目。'],
  ].map(([n, a, b]) => h(`<div class="chap">${n ? `<div class="num">${n}</div>` : ''}<div class="l1">${a}</div><div class="l2">${b}</div></div>`));
  const key = h(`<div class="abs" style="left:150px;top:830px;width:170px;height:170px;border-radius:30px;background:#fff;border:3px solid #E7E5E4;box-shadow:0 10px 0 #E7E5E4,0 20px 40px rgba(0,0,0,.08);display:flex;align-items:center;justify-content:center;font-size:88px;font-weight:600">S</div>`);
  const stage = h(`<div class="stage"></div>`); stage.append(win, key);
  L.append(...chaps, stage);
  const q = s => $(win, s), qa = s => $$(win, s);
  return {
    L, stage, win, chaps, key,
    steps: qa('.w-step'), sec: q('.w-sec'),
    blind: q('.blind'), cnt: q('.blind .cnt'), cellsBox: q('.cells'), cells: qa('.cell'), hint: q('.hint'), hp: q('.blind .hp'),
    beam: q('.beam'), trans: q('.trans'), tls: qa('.tl'), stars: qa('.tl .st'), ov: q('.w-ov'),
    dict: q('.dict'), dn: q('.dict .dn'), slots: qa('.slot'), done: q('.dict .done'), toast: q('.toast'), dim: q('.dim'),
    heard: q('.c-heard'), opts: qa('.c-heard .opt'), tip: q('.c-heard .tip'), go: q('.c-heard .b-go'),
    pass: q('.c-pass'), sum: q('.c-sum'),
  };
}
