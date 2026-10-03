/**
 * Podcast helpers (pro/podcastFeed.ts, pro/podcastShows.ts): what the paste box was
 * given, iTunes durations, the downloaded file's name, the language the transcription
 * is told, an episode's speaking rate and the easier / harder show hints. Reading a real feed (DOMParser) is checked in the browser, not here.
 * Run with: node pro/test-podcast.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `podcast-${process.pid}.mjs`);
await build({ stdin: { contents: "export * from './pro/podcastFeed'; export { SHOWS, SHOW_LANGS, asrOf } from './pro/podcastShows'; export * from './pro/listenLevel';", resolveDir: '.', loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error',
  plugins: [{ name: 'no-http', setup(b) {
    b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: 'http', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = () => { throw new Error("no network here"); };' }));
  } }] });
const P = await import(out);

// --- the paste box ---
assert.deepEqual(P.classifyPaste('https://podcasts.apple.com/cn/podcast/coffee-break-spanish/id201598403'), { kind: 'apple', id: '201598403' });
assert.deepEqual(P.classifyPaste(' https://podcasts.apple.com/us/podcast/x/id1234?i=1000650000000 '), { kind: 'apple', id: '1234' }, 'an episode link: the show');
assert.deepEqual(P.classifyPaste('https://open.spotify.com/show/5Y1…'), { kind: 'closed', name: 'Spotify' });
assert.deepEqual(P.classifyPaste('https://www.xiaoyuzhoufm.com/podcast/abc'), { kind: 'closed', name: '小宇宙' });
assert.deepEqual(P.classifyPaste('https://feeds.megaphone.fm/allearsenglish'), { kind: 'feed', url: 'https://feeds.megaphone.fm/allearsenglish' });
assert.deepEqual(P.classifyPaste('http://example.com/rss'), { kind: 'feed', url: 'http://example.com/rss' });
assert.equal(P.classifyPaste('coffee break spanish').kind, 'bad');
assert.equal(P.classifyPaste('javascript:alert(1)').kind, 'bad');
assert.equal(P.classifyPaste('').kind, 'bad');

// --- itunes:duration ---
assert.equal(P.parseDuration('382'), 382);
assert.equal(P.parseDuration('23:21'), 1401);
assert.equal(P.parseDuration('2:06:03'), 7563);
assert.equal(P.parseDuration('00:10:00'), 600);
assert.equal(P.parseDuration(''), undefined);
assert.equal(P.parseDuration('about 5 min'), undefined);
assert.equal(P.parseDuration(null), undefined);

// --- file names: stable per episode, apart for two "Episode 1"s, nothing that leaves the folder ---
const a = P.episodeName('Episode 1', 'guid-a'), b = P.episodeName('Episode 1', 'guid-b');
assert.notEqual(a, b);
assert.equal(P.episodeName('Episode 1', 'guid-a'), a);
// A guid is only unique inside its own feed: the same guid in two shows is two episodes.
assert.notEqual(P.episodeName('Episode 1', P.epKey('https://a/rss', '1')), P.episodeName('Episode 1', P.epKey('https://b/rss', '1')));
assert.match(a, /^Episode 1 \[[0-9a-f]{8}\]$/);
assert.doesNotMatch(P.episodeName('../../etc/passwd: "x"?', 'g'), /[/\\:*?"<>|]/);
assert.match(P.episodeName('   ', 'g'), /^episode \[/);
assert.ok(P.episodeName('長'.repeat(300), 'g').length < 120);

// --- the transcription's language ---
assert.equal(P.asrLang('de-DE'), 'de');
assert.equal(P.asrLang('EN'), 'en');
assert.equal(P.asrLang('pt-br'), 'auto');
assert.equal(P.asrLang(''), 'auto');
const cbs = P.SHOWS.find(s => s.id === 'cbs');
assert.equal(cbs.lang, 'es', 'grouped under Spanish');
assert.equal(P.asrOf(cbs), 'auto', 'taught in English: the transcription guesses');
assert.equal(P.asrOf(P.SHOWS.find(s => s.id === 'easyde')), 'de');
for (const l of P.SHOW_LANGS) for (const lv of ['beginner', 'intermediate', 'advanced'])
  assert.ok(P.SHOWS.some(s => s.lang === l && s.level === lv), `${l} has a ${lv} show (the easier / harder hint needs one)`);
assert.equal(new Set(P.SHOWS.map(s => s.id)).size, P.SHOWS.length);
assert.ok(P.SHOWS.every(s => s.feed.startsWith('https://')), 'feeds are https (the http plugin only allows that)');

// --- speaking rate: words (or ja / zh / ko characters) a minute of speaking, pauses left out ---
const L = (i, s, e, text) => ({ id: i, startTime: s, endTime: e, text });
const en = Array.from({ length: 30 }, (_, i) => L(i, i * 10, i * 10 + 2, "It's a well-known fact, right?")); // 5 words (it's, well-known: one each) in 2 s, 8 s pauses
assert.deepEqual(P.speechRate(en), { n: 150, unit: 'word', tier: 'mid' }, 'pauses are not speaking time');
assert.equal(P.speechRate(en.map(l => ({ ...l, endTime: l.startTime + 3 }))).tier, 'slow');
assert.equal(P.speechRate(en.map(l => ({ ...l, endTime: l.startTime + 1.5 }))).tier, 'fast');
const ja = Array.from({ length: 20 }, (_, i) => L(i, i * 5, i * 5 + 2, '今日はいい天気ですね。'));
assert.deepEqual(P.speechRate(ja), { n: 300, unit: 'char' }, 'ja: characters, no tier; punctuation not counted');
assert.equal(P.speechRate(Array.from({ length: 20 }, (_, i) => L(i, i * 5, i * 5 + 2, '안녕하세요 반갑습니다'))).unit, 'char');
assert.equal(P.speechRate([L(0, 0, 10, 'too short to tell')]), null, 'under 30 s of speech: no rate');
assert.equal(P.speechRate([]), null);
const tc = x => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')},000`;
const srt = en.map(l => `${l.id + 1}\n${tc(l.startTime)} --> ${tc(l.endTime)}\n${l.text}\n`).join('\n');
assert.equal(P.recordRate({ id: 'r', subtitleText: srt, podcast: { feed: cbs.feed } }), null, 'taught in English: no rate');
assert.equal(P.recordRate({ id: 'r2', subtitleText: srt }).unit, 'word');

// --- what was understood: 2 × little → easier, 3 × most → harder, then start over ---
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
assert.equal(P.noteHeard('f', 'little'), null);
assert.equal(P.noteHeard('f', 'little'), 'easier');
assert.equal(P.noteHeard('f', 'little'), null, 'answers forgotten after a hint');
assert.equal(P.noteHeard('g', 'most'), null);
assert.equal(P.noteHeard('g', 'half'), null);
assert.equal(P.noteHeard('g', 'most'), null);
assert.equal(P.noteHeard('g', 'most'), null);
assert.equal(P.noteHeard('g', 'most'), 'harder');
assert.equal(P.noteHeard('f', 'little'), 'easier', 'shows kept apart');
store.set('linguaclip_listen_level', '{broken');
assert.equal(P.noteHeard('h', 'little'), null, 'unreadable: starts over');
store.set('linguaclip_listen_level', '[1,2]');
assert.equal(P.noteHeard('h', 'little'), null);

// --- which shows to suggest ---
const id = x => x.map(s => s.id);
const lep = P.SHOWS.find(s => s.id === 'lep'), aee = P.SHOWS.find(s => s.id === 'aee'), bbc = P.SHOWS.find(s => s.id === 'bbc6');
assert.deepEqual(id(P.suggestShows('easier', lep.feed, 'en')), ['aee'], 'one level down');
assert.deepEqual(id(P.suggestShows('harder', aee.feed, 'en')), ['lep']);
assert.deepEqual(id(P.suggestShows('harder', lep.feed, 'en')), [], 'nothing above advanced');
assert.deepEqual(id(P.suggestShows('easier', bbc.feed, 'en')), [], 'beginner, no other slow beginner');
assert.deepEqual(id(P.suggestShows('easier', P.SHOWS.find(s => s.id === 'easyfr').feed, 'fr')), ['cbf'], 'French: one level down');
assert.deepEqual(id(P.suggestShows('easier', P.SHOWS.find(s => s.id === 'teppei').feed, 'ja')), ['nhk'], 'already beginner: the other slow beginner');
assert.deepEqual(id(P.suggestShows('easier', 'https://pasted/rss', 'en')), ['bbc6'], 'pasted: beginner');
assert.deepEqual(id(P.suggestShows('harder', 'https://pasted/rss', 'en')), ['aee', 'lep']);
assert.deepEqual(P.suggestShows('easier', 'x', null), [], 'unknown language: none');
assert.equal(P.showLang({ id: 'x', podcast: { feed: cbs.feed } }), 'es', 'a listed show: its own language');
assert.equal(P.showLang({ id: 'y', subtitleText: srt }), 'en', 'pasted: guessed from the transcript');

// --- the starter list (from our site: malformed items are dropped one by one) ---
const item = { id: 'en-1', version: 1, lang: 'en', level: 1, title: 'T', show: 'VOA', about: 'a', seconds: 200, bytes: 3e6,
  audio: 'https://linguaclipapp.com/starter/en-1.mp3', srt: 'https://linguaclipapp.com/starter/en-1.srt', trans: { zh: 'https://x/zh.json', en: 'http://x/en.json' }, credit: 'VOA, public domain' };
const one = P.parseStarter({ v: 1, items: [item] });
assert.equal(one.length, 1);
assert.deepEqual(one[0].trans, { zh: 'https://x/zh.json' }, 'only https translations');
assert.deepEqual(one[0].srtFor, {}, 'no per-language transcript: the plain one');
assert.deepEqual(P.parseStarter({ v: 1, items: [{ ...item, srtFor: { en: 'https://x/kana.srt', zh: 'file:///x' } }] })[0].srtFor, { en: 'https://x/kana.srt' });
assert.deepEqual(P.parseStarter({ v: 2, items: [item] }), [], 'a newer format: nothing');
assert.deepEqual(P.parseStarter(null), []);
assert.deepEqual(P.parseStarter({ v: 1, items: 'x' }), []);
const bad = [{ ...item, audio: 'javascript:alert(1)' }, { ...item, level: 4 }, { ...item, credit: '' }, { ...item, version: '1' }, null];
assert.deepEqual(P.parseStarter({ v: 1, items: [...bad, { ...item, id: 'ok' }] }).map(i => i.id), ['ok'], 'bad items dropped, good kept');

console.log('podcast helpers ok');
