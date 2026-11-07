/**
 * Checks utils/splitLong.ts (over-long lines of subtitles the user brings, cut on import)
 * and utils/speedPref.ts (each player's remembered speed).
 * Run with: node test-split.mjs
 *
 * Bundles the real modules (Tauri's fetch stubbed, as in test-resegment.mjs).
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `split-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/splitLong'; export * from './utils/srtParser'; export { getSpeed, saveSpeed, SPEEDS } from './utils/speedPref';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: out,
  plugins: [{
    name: 'stub-tauri-http',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...a) => globalThis.fetch(...a);' }));
    },
  }],
});
const { splitLongLines, parseSRT, getSpeed, saveSpeed, SPEEDS } = await import(out);

const srt = (...cues) => cues.map(([a, b, text], i) => `${i + 1}\n${a} --> ${b}\n${text}\n`).join('\n');
const words = s => s.split(/\s+/).filter(Boolean).length;
const ms = n => Math.round(n * 1000);

// A 30-word line with no punctuation: two even halves of 15, times back to back,
// first piece from the line's start, last to its end, the next line untouched.
{
  const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
  const out = parseSRT(splitLongLines(srt(['00:00:01,000', '00:00:11,000', long], ['00:00:12,000', '00:00:13,000', 'Short one.'])));
  assert.equal(out.length, 3);
  assert.deepEqual(out.map(l => words(l.text)), [15, 15, 2]);
  assert.equal(ms(out[0].startTime), 1000);
  assert.equal(ms(out[0].endTime), ms(out[1].startTime));
  assert.equal(ms(out[1].endTime), 11000);
  assert.equal(out[2].text, 'Short one.');
  assert.equal(out.map(l => l.text).slice(0, 2).join(' '), long);
}

// Time shared by letters: a piece of long words gets more of the line than one of short words.
{
  const text = [...Array(10).fill('extraordinarily'), ...Array(10).fill('a')].join(' ');
  const [a, b] = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text])));
  assert.equal(words(a.text), 10);
  assert.ok(a.endTime - a.startTime > 9, `long words got ${a.endTime - a.startTime}s`);
  assert.ok(b.endTime - b.startTime < 1);
}

// A sentence end inside the line wins over an even cut; then a comma.
{
  const text = 'I went to the market this morning with my sister. We bought apples, pears, and a lot of fresh bread for the week ahead of us.';
  const out = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:20,000', text])));
  assert.equal(out[0].text, 'I went to the market this morning with my sister.');
  assert.ok(out.every(l => words(l.text) <= 16));
  for (let i = 1; i < out.length; i++) assert.equal(ms(out[i - 1].endTime), ms(out[i].startTime));
}

// No cut after "Mr." / "Yes." / "U.S.", nor one leaving fewer than 3 words.
{
  const text = 'Yes. So Mr. Smith went to the U.S. office and then he came back home again very late tonight';
  assert.ok(words(text) > 16);
  const out = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text])));
  assert.ok(out.every(l => words(l.text) >= 3 && words(l.text) <= 16), out.map(l => l.text).join(' | '));
  assert.ok(!out.some(l => /(Mr\.|U\.S\.|^Yes\.)$/.test(l.text)), out.map(l => l.text).join(' | '));
  assert.ok(!out.some(l => l.text === 'Yes.'));
}

// The even-split fallback lands on word 9 of 18: right after "Mr." / "U.S." here. It moves to a
// neighbouring boundary instead, every piece still within 16 words.
for (const abbr of ['Mr.', 'U.S.']) {
  const text = `Yesterday I finally got a chance to meet ${abbr} Smith and discuss the plans for our new office.`;
  assert.equal(words(text), 18);
  assert.equal(text.split(' ')[8], abbr);
  const out = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text])));
  const show = out.map(l => l.text).join(' | ');
  assert.ok(out.length >= 2 && out.every(l => words(l.text) >= 3 && words(l.text) <= 16), show);
  assert.ok(!out.some(l => l.text.endsWith(abbr)), `cut after ${abbr}: ${show}`);
  assert.equal(out.map(l => l.text).join(' '), text);
}

// An abbreviation wrapped in quotes, brackets or a leading ellipsis is still one: no cut after it,
// neither by the sentence-end rule (word 3 of 18) nor by the even split (word 9 of 18).
{
  const WRAPPED = [
    '"Mr.', "'Mr.", '“Mr.', '‘Mr.', '「Mr.', '『Mr.', '(Mr.', '[Mr.', '«Mr.', '…Mr.', '...Mr.',
    '"U.S."', "'U.S.'", '“U.S.”', '‘U.S.’', '「U.S.」', '(U.S.)', '[U.S.]', '(Dr.)', '“Dr.',
    '{Mr.', '‹Mr.', '¡Dr.', '("U.S.")', '[“Mr.', '…"Mr.',
  ];
  const ms = s => Math.round(s * 1000);
  const fails = [];
  for (const w of WRAPPED) {
    for (const text of [
      `He said ${w} Smith would be coming to the office tomorrow morning to discuss all of our plans.`,
      `Yesterday I finally got a chance to meet ${w} Smith and discuss the plans for our new office.`,
    ]) {
      assert.equal(words(text), 18);
      const out = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text])));
      const show = out.map(l => l.text).join(' | ');
      const bad = [];
      if (out.some(l => l.text.endsWith(w))) bad.push('cut after it');
      if (!out.every(l => words(l.text) >= 3 && words(l.text) <= 16)) bad.push('piece size');
      if (out.map(l => l.text).join(' ') !== text) bad.push('text changed');
      if (ms(out[0].startTime) !== 0 || ms(out[out.length - 1].endTime) !== 10000) bad.push('ends moved');
      for (let i = 1; i < out.length; i++) if (ms(out[i - 1].endTime) !== ms(out[i].startTime)) bad.push('time gap');
      if (bad.length) fails.push(`${w}: ${bad.join(', ')} — ${show}`);
    }
  }
  assert.deepEqual(fails, []);
}

// Wrapping alone does not stop a real sentence end from being a cut: "office." in quotes.
{
  const text = 'He told me "we will meet at the office." Then we went home together and talked about it for hours.';
  const out = parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text])));
  assert.equal(out[0].text, 'He told me "we will meet at the office."');
  assert.ok(out.every(l => words(l.text) <= 16));
}

// Nothing over 16 words: the file comes back byte for byte (tags, two-line cues and all).
{
  const file = srt(['00:00:01,000', '00:00:02,000', '<i>Hello</i>\nthere'], ['00:00:03,000', '00:00:04,000', Array(16).fill('w').join(' ')]);
  assert.equal(splitLongLines(file), file);
}

// Japanese / Chinese lines stay whole, even spaced out into many pieces.
{
  const ja = srt(['00:00:00,000', '00:00:10,000', Array(20).fill('ですね').join(' ')]);
  assert.equal(splitLongLines(ja), ja);
  const zh = srt(['00:00:00,000', '00:00:10,000', Array(20).fill('我们').join(' ')]);
  assert.equal(splitLongLines(zh), zh);
}

// Bilingual entries (the original and its translation in one entry, two writing systems)
// stay whole however long: cutting would glue the translation onto one half.
{
  const es = 'pueden ser preguntas muy simples sobre tu trabajo, tu vida diaria, tus amigos o tus planes para el fin de semana.';
  const en = 'it can be very simple questions about your work, your daily life, your friends or your plans for the weekend.';
  assert.ok(words(es) > 16 && words(en) > 16);
  const BILINGUAL = {
    'es + zh': `${es}\n可以是非常简单的问题，关于你的工作、日常生活、朋友或者周末的计划。`,
    'en + zh': `${en}\n可以是非常简单的问题，关于你的工作、日常生活、朋友或者周末的计划。`,
    'en + ja': `${en}\n仕事や毎日の生活、友達、週末の予定についての簡単な質問でいいです。`,
    'en + ko': `${en}\n일, 일상생활, 친구 또는 주말 계획에 대한 아주 간단한 질문이면 됩니다.`,
    'en + ru': `${en}\nэто могут быть очень простые вопросы о работе, жизни, друзьях или планах на выходные.`,
    'zh + en (translation first)': `可以是非常简单的问题，关于你的工作、日常生活、朋友或者周末的计划。\n${en}`,
  };
  const cut = [];
  for (const [name, text] of Object.entries(BILINGUAL)) {
    const file = srt(['00:00:01,000', '00:00:09,000', text], ['00:00:10,000', '00:00:12,000', 'Short one.\n短句。']);
    if (splitLongLines(file) !== file) cut.push(name);
  }
  assert.deepEqual(cut, [], 'bilingual entries were cut');
}

// One language only: still cut. A single letter of another writing system inside (a symbol, one
// character of a name) does not make it bilingual; two or more letters of it do (left whole).
{
  const en = 'it can be very simple questions about your work, your daily life, your friends or your plans for the weekend.';
  const pieces = text => parseSRT(splitLongLines(srt(['00:00:00,000', '00:00:10,000', text]))).length;
  assert.ok(pieces(en) > 1, 'pure English is cut');
  assert.ok(pieces('pueden ser preguntas muy simples sobre tu trabajo, tu vida diaria, tus amigos o tus planes para el fin de semana.') > 1, 'pure Spanish is cut');
  assert.ok(pieces(`${en.slice(0, -1)} and the π sign.`) > 1, 'one Greek letter: still cut');
  assert.ok(pieces(`${en.slice(0, -1)} with Mr. 李.`) > 1, 'one Chinese character: still cut');
  assert.equal(pieces(`${en.slice(0, -1)} with Mr. 李明.`), 1, 'a two-character Chinese name: left whole');
}

// Speeds: each place its own key; a value not among its choices (or none) is 1×.
{
  const store = new Map();
  globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(getSpeed('dictation'), 1);
  saveSpeed('dictation', 0.75);
  saveSpeed('watch', 1.5);
  assert.equal(getSpeed('dictation'), 0.75);
  assert.equal(getSpeed('watch'), 1.5);
  assert.equal(getSpeed('listen'), 1);
  saveSpeed('watch', 0.5); // dictation has 0.5, watch does not
  assert.ok(SPEEDS.dictation.includes(0.5) && !SPEEDS.watch.includes(0.5));
  assert.equal(getSpeed('watch'), 1);
  store.set('linguaclip_speed_listen', 'fast');
  assert.equal(getSpeed('listen'), 1);
  globalThis.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(getSpeed('dictation'), 1);
  saveSpeed('dictation', 2); // must not throw
}

console.log('test-split: all passed');
