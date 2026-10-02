// Content and geometry shared across scenes, so a carried object lands on exact pixels.
export const WIN = { x: 140, y: 180, w: 1640, h: 862 };          // the app window in the listening scenes
export const STEPS = ['盲听', '对稿', '再盲听', '听写'];

// Demo episode text (written for this film, not any real show's transcript).
export const LINES = [
  'So, last week I started taking the early train to work.',
  "It's quieter, and honestly, it's the only time I get to myself.",
  'I usually put on a podcast and just let it run.',
  "But here's the thing — I wasn't really listening.",
  "Whole minutes would go by and I'd catch maybe half of it.",
  "And I'd tell myself, that's fine, it's still practice.",
  'But I kept feeling overwhelmed whenever they spoke fast.',
  'So I tried something different.',
  "I'd play one short part, then stop and ask what I heard.",
  "Then I'd read along and fill in the gaps.",
  'And then listen one more time, without the text.',
  "Anyway, that's what we're talking about today.",
];
export const SAVED = [4, 8];                                     // line indexes saved in steps 1 and 2

// Real recommended shows (pro/podcastShows.ts): name, level, pace, style.
export const SHOWS = [
  ['6 Minute English', '入门', '偏慢', '对话'], ['All Ears English', '中级', '偏快', '对话'], ["Luke's English Podcast", '中高级', '偏快', '独白'],
  ['Japanese with Shun', '中级', '偏慢', '独白'], ['NHK Easy Japanese', '入门', '偏慢', '对话'], ['Nihongo con Teppei', '入门', '偏慢', '独白'],
  ['Haru no Nihongo', '中高级', '偏快', '独白'], ['なみとパッツーの日本語ラジオ', '中级', '偏快', '对话'], ['Radio Ambulante', '中高级', '偏快', '故事'],
  ['Easy Spanish', '中级', '偏快', '对话'], ['Coffee Break Spanish', '入门', '偏慢', '对话'], ['Coffee Break French', '入门', '偏慢', '对话'],
  ['Choses à Savoir', '中高级', '偏快', '独白'], ['InnerFrench', '中级', '偏慢', '独白'], ['Easy French', '中级', '偏快', '对话'],
  ['Journal en français facile', '中级', '偏慢', '新闻'], ['Slow German', '入门', '偏慢', '独白'], ['Nachrichtenleicht', '入门', '偏慢', '新闻'],
  ['Sozusagen!', '中高级', '偏快', '对话'], ['Easy German', '中级', '偏快', '对话'], ['Talk To Me In Korean', '入门', '偏慢', '对话'],
  ['Heeya Korean 희야한국어', '中级', '偏慢', '独白'], ['Didi의 한국문화 Podcast', '中高级', '偏快', '独白'],
];

// Big left-column chapter heading used by the listening scenes: step number disc + two lines.
export const headCSS = `
.chap { position:absolute; left:140px; top:34px; height:110px; display:flex; align-items:center; gap:26px; white-space:nowrap; }
.chap .num { flex:none; width:88px; height:88px; border-radius:50%; background:#E8492B; color:#fff; font-size:50px; font-weight:600;
  display:flex; align-items:center; justify-content:center; }
.chap .l1 { font-size:80px; font-weight:600; letter-spacing:-0.02em; }
.chap .l2 { font-size:46px; font-weight:500; color:#78716C; margin-left:10px; padding-top:14px; }
`;
