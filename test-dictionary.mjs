/**
 * Checks the dictionary helpers in utils/dictionary.ts: which language a
 * subtitle file is in, Youdao's three JSON shapes, and which Eudic entries are
 * worth opening. Fixtures are trimmed real responses (2026-09-23).
 * Run with: node test-dictionary.mjs
 *
 * Bundles the real module rather than re-typing the logic.
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `dictionary-${process.pid}.mjs`);
await build({ entryPoints: ['utils/dictionary.ts'], bundle: true, format: 'esm', outfile: out });
const { detectLang, parseYoudao, parseYoudaoJa, pickEudicTerms, senseToAnki, senseList, getDictChoice, saveDictChoice, dictOptions } = await import(out);
const enOut = join(tmpdir(), `dictionaryEn-${process.pid}.mjs`);
await build({ entryPoints: ['utils/dictionaryEn.ts'], bundle: true, format: 'esm', outfile: enOut });
const { parseWiktionary, parseJisho, htmlText } = await import(enOut);

// --- language of a whole subtitle file ---
assert.equal(detectLang(["All right, what's the plan?", 'I think we should go to the station and wait.', 'It is what it is.']), 'en');
assert.equal(detectLang(['Quiero hablar contigo mañana por la tarde.', '¿Qué está pasando con los niños?', 'Pero no es muy tarde.']), 'es');
assert.equal(detectLang(["Je voudrais parler avec vous, c'est important.", 'Il ne sait pas ce qui se passe.', 'Les enfants sont à la maison.']), 'fr');
assert.equal(detectLang(['Ich möchte morgen mit dir sprechen.', 'Das ist nicht so einfach, und wir wissen es.', 'Die Straße ist groß.']), 'de');
assert.equal(detectLang(['明日あなたと話したいです', 'それはいいですね']), 'ja', 'Japanese is told by its kana');
assert.equal(detectLang(['我们明天见', '今天天气很好']), null);
assert.equal(detectLang(['Hello']), null, 'too little to tell');
assert.equal(detectLang([]), null);

// --- Youdao: English `ec` ---
const running = parseYoudao({ ec: { word: {
  usphone: 'ˈrʌnɪŋ', ukphone: 'ˈrʌnɪŋ', 'return-phrase': 'running', prototype: 'run',
  trs: [{ pos: 'n.', tran: '跑步，赛跑' }, { pos: 'v.', tran: '跑；运转（run的现在分词形式）' }, { tran: '【名】 （Running）（英）朗宁（人名）' }],
} } }, 'running');
assert.equal(running.word, 'running');
assert.equal(running.phonetic, '/ˈrʌnɪŋ/');
assert.equal(running.source, 'youdao');
assert.deepEqual(running.senses.map(s => s.pos), ['n.', 'v.', '']);
assert.deepEqual(running.senses[1].text, ['跑；运转（run的现在分词形式）']);

// --- Youdao: French `fc` (lemma comes back for a conjugated form) ---
const parlons = parseYoudao({ fc: { word: [{
  phone: 'parle', 'return-phrase': { l: { i: 'parler' } },
  trs: [{ pos: 'v.i.', tr: [{ l: { i: ['讲话，谈话'] } }] }, { pos: 'v.t.', tr: [{ l: { i: ['说，讲(某种语言)；谈论'] } }] }],
}] } }, 'parlons');
assert.equal(parlons.word, 'parler');
assert.equal(parlons.phonetic, '/parle/');
assert.deepEqual(parlons.senses.map(s => s.text[0]), ['讲话，谈话', '说，讲(某种语言)；谈论']);

// --- Youdao: Spanish / German `multle`, with its junk line dropped ---
const sprach = parseYoudao({ multle: { word: [{
  'return-phrase': { l: { i: 'sprach' } },
  trs: [{ tr: [{ l: { i: ['sprechen的过去时直陈式 (强变化动词) \n'] } }] }, { tr: [{ l: { i: ['Fr helper cop yright\n'] } }] }],
}] } }, 'sprach');
assert.equal(sprach.senses.length, 1);
assert.deepEqual(sprach.senses[0], { pos: '', text: ['sprechen的过去时直陈式 (强变化动词)'], examples: [] });
assert.equal(sprach.phonetic, '');

// --- Youdao: nothing found (wrong language, typo) ---
assert.equal(parseYoudao({ web_trans: {}, typos: {} }, 'qwzxv'), null);
assert.equal(parseYoudao({ multle: { word: [{ trs: [] }] } }, 'x'), null);
assert.equal(parseYoudao(null, 'x'), null);

// --- Eudic: the word itself and its lemma, never prefix completions ---
const parle = [
  { value: 'parole', iscghint: false, recordtype: null, recordid: 'A' },
  { value: 'parlé', iscghint: false, recordtype: null, recordid: 'B' },
  { value: 'parler', iscghint: true, recordtype: 'Dict', recordid: 'C' },
  { value: 'parle', iscghint: true, recordtype: 'CG', recordid: 'C' },
];
assert.deepEqual(pickEudicTerms(parle, 'parle').map(t => t.value), ['parler']);
const casa = [
  { value: 'casa', iscghint: false, recordtype: null, recordid: 'A' },
  { value: 'casar', iscghint: true, recordtype: 'Dict', recordid: 'B' },
  { value: 'casa', iscghint: true, recordtype: 'CG', recordid: 'B' },
  { value: 'carcasa', iscghint: false, recordtype: null, recordid: 'C' },
];
assert.deepEqual(pickEudicTerms(casa, 'casa').map(t => t.value), ['casa', 'casar']);
assert.deepEqual(pickEudicTerms([{ value: 'Haus', recordtype: null, recordid: 'A' }], 'haus').map(t => t.value), ['Haus']);
assert.deepEqual(pickEudicTerms([{ value: 'hablo contigo', recordid: null }], 'hablo'), []);

// --- Youdao English: Collins (meanings with examples) beats the concise list ---
const collinsEntry = (tran, sents) => ({ tran_entry: [{ pos_entry: { pos: 'V-I' }, tran, exam_sents: sents && { sent: sents } }] });
const looked = parseYoudao({
  ec: { word: { usphone: 'lʊk', 'return-phrase': 'looked', trs: [{ pos: 'v.', tran: '看' }] } },
  collins: { collins_entries: [{ headword: 'look', entries: { entry: [
    collinsEntry('If you <b>look</b> in a direction, you direct your eyes there. 看', [{ eng_sent: 'I looked down the hallway.', chn_sent: '我沿着走廊看过去。' }, { eng_sent: 'Look!', chn_sent: '看！' }, { eng_sent: 'Third.', chn_sent: '第三。' }]),
    collinsEntry('You use <b>look</b> when describing appearance. （表示外观）看上去'),
  ] } }] },
}, 'looked');
assert.equal(looked.word, 'look');
assert.equal(looked.phonetic, '/lʊk/');
assert.equal(looked.senses.length, 2);
assert.deepEqual(looked.senses[0].text, ['If you look in a direction, you direct your eyes there.\n看']);
assert.deepEqual(looked.senses[1].text, ['You use look when describing appearance.\n（表示外观）看上去'], 'a fullwidth bracket starts the Chinese');
assert.deepEqual(looked.senses[0].examples[0], ['I looked down the hallway.\n我沿着走廊看过去。']);
assert.deepEqual(looked.senses[1].examples, []);
// A lone "past tense of" stub is not worth more than the concise list.
const went = parseYoudao({
  ec: { word: { 'return-phrase': 'went', trs: [{ pos: 'v.', tran: '去（go 的过去式）' }, { pos: 'n.', tran: '人名' }] } },
  collins: { collins_entries: [{ headword: 'went', entries: { entry: [collinsEntry('<b>Went</b> is the past tense of . (go)的过去式')] } }] },
}, 'went');
assert.deepEqual(went.senses.map(s => s.text[0]), ['去（go 的过去式）', '人名']);
// One real meaning with examples is still worth taking.
const llama = parseYoudao({
  ec: { word: { 'return-phrase': 'llama', trs: [{ pos: 'n.', tran: '美洲驼' }] } },
  collins: { collins_entries: [{ headword: 'llama', entries: { entry: [collinsEntry('A <b>llama</b> is a South American animal. 美洲驼', [{ eng_sent: 'A llama spat.', chn_sent: '一只美洲驼吐了口水。' }])] } }] },
}, 'llama');
assert.equal(llama.senses.length, 1);
assert.deepEqual(llama.senses[0].examples, [['A llama spat.\n一只美洲驼吐了口水。']]);

// --- One meaning as Anki fields: escaped, glyph images kept, two examples ---
const img = { img: 'https://www.esdict.cn/tmp/wordimg/q.png' };
const entry = { word: 'a<b', phonetic: '/x/', source: 'eudic', senses: [
  { pos: 'intr.', phrase: 'llegar a ser', text: ['6. 实现，', img, '：'], examples: [['Llegó el armisticio. 停战了.'], ['No llegó. ', img], ['third']] },
  { pos: 'tr.', text: ['1. 移近.'], examples: [] },
] };
assert.deepEqual(senseToAnki(entry, entry.senses[0]), {
  definition: '<b>a&lt;b</b> /x/<br/><i>intr.</i> <b>llegar a ser</b> 6. 实现，<img src="https://www.esdict.cn/tmp/wordimg/q.png">：',
  example: 'Llegó el armisticio. 停战了.<br/><br/>No llegó. <img src="https://www.esdict.cn/tmp/wordimg/q.png">',
});
assert.deepEqual(senseToAnki(entry, entry.senses[1]), { definition: '<b>a&lt;b</b> /x/<br/><i>tr.</i> 1. 移近.', example: '' });

// --- The list the AI picks from: numbered across entries, back to (entry, sense) ---
const list = senseList([entry, { word: 'casar', phonetic: '', source: 'eudic', senses: [{ pos: 'tr.', text: ['娶'], examples: [['Se casó. 结婚了.\n']] }] }]);
assert.deepEqual(list.map(x => [x.entry, x.sense]), [[0, 0], [0, 1], [1, 0]]);
assert.equal(list[0].line, '1. a<b | intr. | llegar a ser | 6. 实现，□： e.g. Llegó el armisticio. 停战了.');
assert.equal(list[2].line, '3. casar | tr. | 娶 e.g. Se casó. 结婚了.');

// --- Dictionary choice (Chinese interface): Eudic by default for es/fr/de; only the touched language is stored ---
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
assert.deepEqual(getDictChoice('zh'), { en: 'youdao', es: 'eudic', fr: 'eudic', de: 'eudic', ja: 'youdao' });
saveDictChoice('en', 'cambridge', 'zh');
assert.deepEqual(JSON.parse(store.get('linguaclip_dict_choice')), { en: 'cambridge' });
saveDictChoice('fr', 'youdao', 'zh');
assert.deepEqual(getDictChoice('zh'), { en: 'cambridge', es: 'eudic', fr: 'youdao', de: 'eudic', ja: 'youdao' });
store.set('linguaclip_dict_choice', '{"es":"cambridge"}');
assert.equal(getDictChoice('zh').es, 'eudic', 'a source the language does not offer falls back');

// --- English interface: only English dictionaries, its own choice, the Chinese one kept ---
store.set('linguaclip_dict_choice', '{"en":"cambridge","es":"youdao"}');
assert.deepEqual(getDictChoice('en'), { en: 'cambridgeEn', es: 'wiktionary', fr: 'wiktionary', de: 'wiktionary', ja: 'wiktionary' });
assert.ok(Object.values(dictOptions('en')).flat().every(s => !['youdao', 'eudic', 'cambridge'].includes(s)), 'no Chinese dictionary in English');
saveDictChoice('ja', 'jisho', 'en');
assert.deepEqual(JSON.parse(store.get('linguaclip_dict_choice_en')), { ja: 'jisho' });
assert.equal(getDictChoice('en').ja, 'jisho');
assert.deepEqual(getDictChoice('zh'), { en: 'cambridge', es: 'youdao', fr: 'eudic', de: 'eudic', ja: 'youdao' }, 'switching back restores the Chinese choice');
saveDictChoice('es', 'wiktionary', 'zh');
assert.equal(getDictChoice('zh').es, 'wiktionary', 'the Chinese list offers the English ones too');
store.set('linguaclip_dict_choice_en', 'not json');
assert.equal(getDictChoice('en').en, 'cambridgeEn', 'a broken store reads as defaults');

// --- Wiktionary (trimmed real answers, 2026-09-30) ---
const formOf = (lemma, lang, name) => `<span class="form-of-definition use-with-mention"><a rel="mw:WikiLink" href="/wiki/Appendix:Glossary#first_person" title="Appendix:Glossary">first-person</a> <a href="/wiki/Appendix:Glossary#preterite">preterite</a> of <span class="form-of-definition-link"><i lang="${lang}"><a rel="mw:WikiLink" href="/wiki/${lemma}#${name}" title="${lemma}">${lemma}</a></i></span></span>`;
const llegue = parseWiktionary({
  es: [{ partOfSpeech: 'Verb', definitions: [{ definition: formOf('llegar', 'es', 'Spanish') }] }],
  ca: [{ partOfSpeech: 'Verb', definitions: [{ definition: formOf('lleure', 'ca', 'Catalan') }] }],
}, 'llegué', 'es');
assert.equal(llegue.entry, null, 'a form only: no meanings of its own');
assert.deepEqual(llegue.forms, [{ lemma: 'llegar', note: 'first-person preterite of llegar' }], 'the lemma of this language, not the Catalan one');
const fue = parseWiktionary({ es: [{ partOfSpeech: 'Verb', definitions: [{ definition: formOf('ir', 'es', 'Spanish') }, { definition: formOf('ser', 'es', 'Spanish') }] }] }, 'fue', 'es');
assert.deepEqual(fue.forms.map(f => f.lemma), ['ir', 'ser']);
assert.equal(parseWiktionary({ en: [{ partOfSpeech: 'Noun', definitions: [{ definition: 'house' }] }] }, 'Casa', 'es'), null, 'no Spanish part: null, so the caller retries in lower case');
const llegar = parseWiktionary({ es: [{ partOfSpeech: 'Verb', definitions: [
  { definition: '<span class="usage-label-sense"></span> to <a rel="mw:WikiLink" href="/wiki/arrive" title="arrive">arrive</a>, <a href="/wiki/get">get</a> (to)',
    parsedExamples: [{ example: 'Cuando <b>llegues</b> a casa, mándame un mensaje.', translation: 'When you get home, send me a message.' }] },
  { definition: 'to be <a href="/wiki/sufficient">sufficient</a>; to be enough &amp; more', examples: ['Un solo día no <b>llega</b>.'] },
  { definition: '' },
] }] }, 'llegar', 'es');
assert.deepEqual(llegar.entry, { word: 'llegar', phonetic: '', source: 'wiktionary', senses: [
  { pos: 'Verb', text: ['to arrive, get (to)'], examples: [['Cuando llegues a casa, mándame un mensaje.\nWhen you get home, send me a message.']] },
  { pos: 'Verb', text: ['to be sufficient; to be enough & more'], examples: [['Un solo día no llega.']] },
] });
const ki = parseWiktionary({ ja: [
  { partOfSpeech: 'Noun', definitions: [
    { definition: '<a href="/wiki/spirit">spirit</a>, <a href="/wiki/mood">mood</a>', parsedExamples: [{ translation: '<i><span class="e-transliteration tr">asobu <b>ki</b> manman</span></i>', example: '<span lang="ja"><a href="/wiki/遊ぶ#Japanese"><ruby>遊<rp>(</rp><rt>あそ</rt><rp>)</rp></ruby>ぶ</a><b><ruby>気<rp>(</rp><rt>き</rt><rp>)</rp></ruby></b>満々</span><link rel="mw:PageProp/Category" href="./Category:x">' }] },
    { definition: '<i about="#mwt63">This term needs a translation to English. Please help out and <b>add a translation</b>, then remove the text <code><a rel="mw:WikiLink" href="/wiki/Template:rfdef" title="Template:rfdef">rfdef</a></code></i>' },
  ] },
  { partOfSpeech: 'Adverb', definitions: [{ definition: '<style data-mw-deduplicate="x">.mw-parser-output .object-usage-tag{font-style:italic}</style><span class="object-usage-tag">(colloquial)</span> somehow' }] },
] }, '気', 'ja');
assert.deepEqual(ki.entry.senses.map(s => [s.pos, s.text[0]]), [['Noun', 'spirit, mood'], ['Adverb', '(colloquial) somehow']], 'stubs and <style> dropped');
assert.deepEqual(ki.entry.senses[0].examples, [['遊ぶ気満々\nasobu ki manman']], 'furigana dropped from the example');
assert.equal(htmlText('&lt;b&gt; &#233;t&#xE9; &nbsp;x &bogus;'), '<b> été x &bogus;', 'entities decoded to text, never markup');
assert.equal(htmlText('a &#99999999; b'), 'a &#99999999; b', 'an impossible code point stays as written instead of throwing');

// --- Jisho (JMdict) ---
const jisho = parseJisho({ data: [
  { japanese: [{ word: '食べる', reading: 'たべる' }], senses: [
    { english_definitions: ['to eat'], parts_of_speech: ['Ichidan verb', 'Transitive verb'] },
    { english_definitions: ['to live on (e.g. a salary)', 'to live off'], parts_of_speech: [] },
    { english_definitions: ['Taberu'], parts_of_speech: ['Wikipedia definition'] },
  ] },
  { japanese: [{ reading: 'たべる' }], senses: [{ english_definitions: [], parts_of_speech: ['Noun'] }] },
  { japanese: [{ word: '食べるラー油', reading: 'たべるラーゆ' }], senses: [{ english_definitions: ['chili oil'], parts_of_speech: ['Noun'] }] },
] }, '食べる');
assert.deepEqual(jisho, [{ word: '食べる', phonetic: 'たべる', reading: 'たべる', source: 'jisho', senses: [
  { pos: 'Ichidan verb, Transitive verb', text: ['to eat'], examples: [] },
  { pos: 'Ichidan verb, Transitive verb', text: ['to live on (e.g. a salary); to live off'], examples: [] },
] }], 'a sense with no part of speech shares the one before; Wikipedia and empty senses dropped');
assert.deepEqual(parseJisho({ data: [
  { japanese: [{ word: '来る', reading: 'きたる' }], senses: [{ english_definitions: ['next'], parts_of_speech: ['Pre-noun adjectival'] }] },
  { japanese: [{ word: '来る', reading: 'くる' }], senses: [{ english_definitions: ['to come'], parts_of_speech: ['Kuru verb'] }] },
] }, 'くる').map(e => e.phonetic), ['くる'], 'a kana query keeps the headword read that way');
assert.deepEqual(parseJisho({ data: [{ japanese: [{ word: '走る', reading: 'はしる' }], senses: [{ english_definitions: ['to run'], parts_of_speech: ['Godan verb'] }] }, { japanese: [{ word: '走り', reading: 'はしり' }], senses: [{ english_definitions: ['running'], parts_of_speech: ['Noun'] }] }] }, 'はしっ').map(e => e.word), ['走る'], 'nothing exact: Jisho\'s first guess');
assert.equal(parseJisho({ data: [] }, 'x'), null);
assert.equal(parseJisho(null, 'x'), null);

// --- Hand-over when a dictionary is unreachable or lacks the word (fake network) ---
import { writeFileSync } from 'node:fs';
const stub = join(tmpdir(), `http-stub-${process.pid}.mjs`);
writeFileSync(stub, 'export const fetch = (...a) => globalThis.fakeFetch(...a);');
const fbOut = join(tmpdir(), `dictionary-fb-${process.pid}.mjs`);
await build({ entryPoints: ['utils/dictionary.ts'], bundle: true, format: 'esm', outfile: fbOut, alias: { '@tauri-apps/plugin-http': stub } });
const fb = await import(fbOut);
let hits;
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => body });
const wikiLlegar = { es: [{ partOfSpeech: 'Verb', definitions: [{ definition: 'to arrive' }] }] };
const net = {};
globalThis.fakeFetch = async url => {
  const host = new URL(url).host;
  hits.push(host);
  const r = net[host];
  if (r === 'down') throw new Error('timed out');
  return r ?? reply(404, {});
};
console.warn = () => {}; // the hand-over logs each unreachable dictionary
const run = async (word, lang) => { hits = []; try { return (await fb.lookupWord(word, lang))?.map(e => e.source) ?? null; } catch { return 'offline'; } };
// The English interface (node's navigator is en-US).
store.clear();
net['dictionary.cambridge.org'] = 'down';
net['en.wiktionary.org'] = reply(200, wikiLlegar);
assert.deepEqual(await run('llegar', 'es'), ['wiktionary'], 'the default answers');
fb.saveDictChoice('es', 'cambridgeBi', 'en');
assert.deepEqual(await run('llegar', 'es'), ['wiktionary'], 'chosen Cambridge unreachable → the default');
net['dictionary.cambridge.org'] = reply(200, '<html></html>');
globalThis.DOMParser = class { parseFromString() { return { querySelectorAll: () => [], querySelector: () => null }; } };
assert.deepEqual(await run('llegar', 'es'), ['wiktionary'], 'chosen Cambridge without the word → the default');
assert.deepEqual(hits, ['dictionary.cambridge.org', 'en.wiktionary.org']);
net['dictionary.cambridge.org'] = 'down';
net['en.wiktionary.org'] = reply(404, {});
assert.equal(await run('zzz', 'es'), null, 'the default lacking the word is the answer, not offline');
store.clear();
assert.equal(await run('zzz', 'es'), null, 'default lacks it: no second try');
assert.deepEqual(hits, ['en.wiktionary.org'], 'the default lacking the word: no second dictionary, no lower-case retry for a lower-case word');
net['en.wiktionary.org'] = 'down';
assert.equal(await run('llegar', 'es'), 'offline', 'default and second both unreachable → offline, not "not found"');
net['dictionary.cambridge.org'] = reply(200, '<html></html>');
assert.equal(await run('llegar', 'es'), null, 'default unreachable, second answers "not found"');

// --- Online / local switches and order (docs/dictionary.md「查词顺序与开关」), local dictionaries faked ---
const localStub = join(tmpdir(), `local-stub-${process.pid}.mjs`);
writeFileSync(localStub, `export const localDictsReady = async () => {};
export const localDictsFor = lang => globalThis.fakeLocal?.[lang] ? [{}] : [];
export const lookupLocal = async (word, lang) => { globalThis.localHits?.push(word); return globalThis.fakeLocal?.[lang]?.[word] ?? null; };`);
const swOut = join(tmpdir(), `dictionary-sw-${process.pid}.mjs`);
await build({ entryPoints: ['utils/dictionary.ts'], bundle: true, format: 'esm', outfile: swOut, alias: { '@tauri-apps/plugin-http': stub },
  plugins: [{ name: 'local', setup: b => b.onResolve({ filter: /\/localDict$/ }, () => ({ path: localStub })) }] });
const sw = await import(swOut);
const runSw = async (word, lang) => { hits = []; globalThis.localHits = []; try { return (await sw.lookupWord(word, lang))?.map(e => e.source) ?? null; } catch { return 'offline'; } };
const L = [{ word: 'llegar', phonetic: '', senses: [], source: 'local' }];
globalThis.fakeLocal = { es: { llegar: L } };
store.clear();
net['en.wiktionary.org'] = reply(404, {});
assert.deepEqual(sw.getDictSources('en'), { online: true, local: true, localFirst: true, autoPick: false, aiAlways: false, aiCulture: false }, 'defaults: English interface local first, AI pick off');
assert.deepEqual(sw.getDictSources('zh'), { online: true, local: true, localFirst: false, autoPick: false, aiAlways: false, aiCulture: false }, 'defaults: Chinese interface online first');
sw.saveDictSources({ autoPick: true });
assert.equal(sw.getDictSources('zh').autoPick, true, 'AI pick kept once ticked');
sw.saveDictSources({ autoPick: false });
sw.saveDictSources({ aiAlways: true, aiCulture: true });
assert.equal(sw.getDictSources('zh').aiAlways && sw.getDictSources('zh').aiCulture, true, 'every-lookup and cultural meaning kept once set');
assert.equal(sw.getDictSources('zh').autoPick, false, 'aiAlways alone does not turn the auto pick on (an older version reads only autoPick)');
sw.saveDictSources({ aiAlways: false, aiCulture: false });
sw.saveDictSources({ localFirst: false });
assert.deepEqual(await runSw('llegar', 'es'), ['local'], 'online default lacks the word → local still asked');
assert.deepEqual(hits, ['en.wiktionary.org']);
net['en.wiktionary.org'] = reply(200, wikiLlegar);
assert.deepEqual(await runSw('llegar', 'es'), ['wiktionary'], 'online answers first');
assert.deepEqual(globalThis.localHits, [], 'local not asked once online answered');
sw.saveDictSources({ localFirst: true });
assert.deepEqual(await runSw('llegar', 'es'), ['local'], 'local first');
assert.deepEqual(hits, [], 'online untouched when local answers first');
sw.saveDictSources({ local: false });
assert.deepEqual(await runSw('llegar', 'es'), ['wiktionary'], 'local off: online only');
assert.deepEqual(globalThis.localHits, []);
sw.saveDictSources({ local: true, online: false });
assert.deepEqual(await runSw('llegar', 'es'), ['local'], 'online off: local only');
assert.deepEqual(hits, []);
assert.equal(await runSw('zzz', 'es'), null, 'online off, local lacks it');
assert.deepEqual(hits, []);
assert.equal(await sw.dictsOff('es'), null);
assert.equal(await sw.dictsOff('fr'), 'noLocal', 'online off, no local dictionary for French');
sw.saveDictSources({ local: false });
assert.equal(await sw.dictsOff('es'), 'all');
sw.saveDictSources({ online: true, localFirst: false });
assert.equal(await sw.dictsOff('es'), null);
net['en.wiktionary.org'] = 'down';
net['dictionary.cambridge.org'] = 'down';
sw.saveDictSources({ local: true });
assert.deepEqual(await runSw('llegar', 'es'), ['local'], 'offline → local answers');
assert.equal(await runSw('zzz', 'es'), 'offline', 'offline and local lacks it → still "unreachable"');
store.set('linguaclip_dict_sources', '{bad');
assert.deepEqual(sw.getDictSources('zh'), { online: true, local: true, localFirst: false, autoPick: false, aiAlways: false, aiCulture: false }, 'unreadable → defaults, never all off');

console.log('test-dictionary: all passed');

// --- Youdao: Japanese `newjc` (kanji query, then a kana query whose real entry is in homonymD) ---
const taberu = parseYoudaoJa({"newjc": {"word": {"head": {"pjm": "たべる", "tone": "②", "hw": "食べる"}, "sense": [{"phrList": [{"jmsyT": "飲食物をいただく。", "ljT": ["你是吃年糕，还是吃面食?", "吃不愁，穿不愁。"], "jmsy": "吃。", "lj": ["君は‘饼’を食べるか，それともめん類を食べるか？", "食べることにも，着ることにも心配したことがない。"]}, {"jmsyT": "生計を立てる。", "ljT": ["靠利息生活。", "连饭都吃不上的生活。"], "jmsy": "生活。", "lj": ["金利で食べるべている", "食べる物にも事欠く生活。"]}], "cx": "他动词・一段/二类"}]}}});
assert.equal(taberu.length, 1);
assert.equal(taberu[0].word, '食べる');
assert.equal(taberu[0].phonetic, 'たべる ②');
assert.equal(taberu[0].senses[0].pos, '他动词・一段/二类');
assert.equal(taberu[0].senses[0].text[0], '吃。\n飲食物をいただく。');
assert.match(taberu[0].senses[0].examples[0][0], /^君は.*食べるか.*\n你是吃/);
const kana = parseYoudaoJa({"newjc": {"word": {"head": {"pjm": "たべる", "hw": "たべる"}, "homonymD": [{"head": {"pjm": "たべる", "tone": "②", "hw": "食べる"}, "sense": [{"phrList": [{"jmsyT": "飲食物をいただく。", "ljT": ["你们吃什么?我们要一斤水饺", "生鱼片你吃得来能吃吗?没问题"], "jmsy": "吃。", "lj": ["何を食べますか――水餃子を1斤お願いします", "刺身は食べられますか――大丈夫です"]}, {"jmsyT": "生計を立てる。", "ljT": ["到了三十岁才不为生活操心了", "靠工资维持生活"], "jmsy": "生活。", "lj": ["30歳になってようやく食べていけるようになった", "月給でたべる"]}], "cx": "他动词・一段/二类"}]}], "sense": [{"phrList": [{"ljT": ["你应该吃这里的菜。", "你喜欢在外面吃还是在家吃?"], "jmsy": " 吃", "lj": ["ここの料理をたべるべきだ。", "外食と家でたべるのとどちらが好きですか。"]}]}, {"phrList": [{"jmsy": " 生活"}]}]}}});
assert.deepEqual(kana.map(e => e.word), ['たべる', '食べる'], 'a kana word leads with its own entry, then its kanji spellings');
assert.equal(parseYoudaoJa({}), null);
assert.equal(parseYoudaoJa({ newjc: { word: { head: { hw: 'x' }, sense: [] } } }), null);

console.log('japanese dictionary ok');
