/**
 * Checks M1.4 Android full online dictionary & aux-channel word pronunciation:
 * - arrayBufferToBase64 (empty, binary 0..255, multi-chunk >64KB)
 * - 2 MiB aux audio size guard & empty buffer rejection
 * - Eudic { img } https-only guard, { ruby, rt }, SegText rendering & HTML whitelist sanitization
 * - Dictionary source caption mapping (zh/en, all 8 sources + local dictName, web vs android)
 * - Aux-channel bridge contract (playback.playAuxBytes with pauseMain:false, playback.stopAux, cancel-in-flight)
 * - Android vs Web lookup routing (lookupJa / lookupWord / dictsOff / noLocal / offline / notFound)
 *
 * Run with: node mobile/test-word-android.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// --- 1. Bundle mobile/platform/wordPlatform.ts (Web/PWA) with stubbed dictionary/japanese ---
const webOut = join(tmpdir(), `word-web-${process.pid}.mjs`);
await build({
  entryPoints: ['mobile/platform/wordPlatform.ts'], bundle: true, format: 'esm', platform: 'node', outfile: webOut, logLevel: 'error',
  plugins: [{
    name: 'stub-web',
    setup(b) {
      b.onResolve({ filter: /utils\/(dictionary|japanese)$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /dictionary$/, namespace: 'stub' }, () => ({ contents: 'export const lookupWiktionary = (...a) => globalThis.__webWiki(...a);' }));
      b.onLoad({ filter: /japanese$/, namespace: 'stub' }, () => ({ contents: 'export const jaLemma = w => globalThis.__jaLemma(w);' }));
    },
  }],
});

// --- 2. Bundle mobile/platform/wordPlatform.android.ts with stubbed dict/voice/TTS ---
const androidOut = join(tmpdir(), `word-android-${process.pid}.mjs`);
await build({
  entryPoints: ['mobile/platform/wordPlatform.android.ts'], bundle: true, format: 'esm', platform: 'node', outfile: androidOut, logLevel: 'error',
  plugins: [{
    name: 'stub-android',
    setup(b) {
      b.onResolve({ filter: /(?:^|\/)(dictionary|jaLookup|dictVoice|speech|localDict|japanese|desktop\.android)$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /dictionary$/, namespace: 'stub' }, () => ({ contents: 'export const dictsOff = (...a) => globalThis.__dictsOff(...a); export const lookupWord = (...a) => globalThis.__lookupWord(...a);' }));
      b.onLoad({ filter: /jaLookup$/, namespace: 'stub' }, () => ({ contents: 'export const lookupJa = (...a) => globalThis.__lookupJa(...a);' }));
      b.onLoad({ filter: /dictVoice$/, namespace: 'stub' }, () => ({ contents: 'export const dictVoice = (...a) => globalThis.__dictVoice(...a);' }));
      b.onLoad({ filter: /speech$/, namespace: 'stub' }, () => ({ contents: "export const VOICES = { en: 'en-US-JennyNeural', ja: 'ja-JP-NanamiNeural', es: 'es-ES-ElviraNeural', no: 'nb-NO-PernilleNeural' };" }));
      b.onLoad({ filter: /localDict$/, namespace: 'stub' }, () => ({ contents: 'export const loadLocalDicts = async () => {};' }));
      b.onLoad({ filter: /japanese$/, namespace: 'stub' }, () => ({ contents: 'export const loadJa = async () => true; export const downloadJa = async () => true;' }));
      b.onLoad({ filter: /desktop\.android$/, namespace: 'stub' }, () => ({
        contents: 'export const synthesizeSpeech = (...a) => globalThis.__tts(...a); export const dictList = async () => []; export const dictCheck = async () => ({ title: "", revision: "", same: null }); export const dictImport = async () => []; export const dictDownload = async () => []; export const dictUpdate = async () => []; export const dictMove = async () => []; export const dictRemove = async () => []; export const onDictProgress = async () => () => {}; export const pickDictZip = async () => null;',
      }));
      b.onResolve({ filter: /\/(desktop|videoStorage|deckLang)$/ }, a => ({ path: a.path, namespace: 'wvstub' }));
      b.onLoad({ filter: /desktop$/, namespace: 'wvstub' }, () => ({ contents: 'export const synthesizeSpeech = async () => null;' }));
      b.onLoad({ filter: /videoStorage$/, namespace: 'wvstub' }, () => ({ contents: 'export const getVideoRecord = async () => null;' }));
      b.onLoad({ filter: /deckLang$/, namespace: 'wvstub' }, () => ({ contents: "export const videoLang = () => 'en';" }));
    },
  }],
});

// --- 3. Bundle WordSheet helpers + useWordLookup helpers + i18n dictionaries ---
const uiOut = join(tmpdir(), `word-ui-${process.pid}.mjs`);
await build({
  stdin: {
    contents: `
      import React from 'react';
      import { SegText } from './mobile/WordSheet.tsx';
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const toHtml = (node: any): string => {
        if (node == null || typeof node === 'boolean') return '';
        if (typeof node === 'string' || typeof node === 'number') return esc(String(node));
        if (Array.isArray(node)) return node.map(toHtml).join('');
        if (node.type === React.Fragment) return toHtml(node.props?.children);
        if (typeof node.type === 'function') return toHtml(node.type(node.props));
        if (typeof node.type === 'string') {
          const props = node.props ?? {};
          const attrs = Object.entries(props).filter(([k]) => k !== 'children').map(([k, v]) => \` \${k === 'className' ? 'class' : k}="\${esc(String(v))}"\`).join('');
          return node.type === 'img' ? \`<img\${attrs}/>\` : \`<\${node.type}\${attrs}>\${toHtml(props.children)}</\${node.type}>\`;
        }
        return '';
      };
      export const renderSegText = (line: any) => toHtml(SegText({ line }));
      export { SegText, dictSourceLabel, errorKeyOf } from './mobile/WordSheet.tsx';
      export { isSafeImgUrl, sanitizeSegs, senseFields, aiFields, jaBaseForm, cardWordOf, cardWordForFirst, isEmptyKeep, saveWordCard, phraseSaveFields } from './mobile/useWordLookup.ts';
      export { zh } from './utils/i18n.zh.ts';
      export { en } from './utils/i18n.en.ts';
      export { clean } from './utils/cleanHtml.ts';
      export { dictLabel, isInstalled, recommendedFor } from './utils/dictRecommend.ts';
      export { lookupWord } from './utils/dictionary.ts';
    `,
    resolveDir: '.', loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', outfile: uiOut, logLevel: 'error',
  plugins: [{
    name: 'stub-tauri-ui',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'httpstub' }));
      b.onLoad({ filter: /.*/, namespace: 'httpstub' }, () => ({ contents: 'export const fetch = globalThis.fetch;' }));
      b.onResolve({ filter: /^@tauri-apps\// }, a => ({ path: a.path, namespace: 'tauristub' }));
      b.onLoad({ filter: /.*/, namespace: 'tauristub' }, () => ({ contents: 'export const invoke = async () => null; export const listen = async () => () => {}; export const convertFileSrc = p => p;' }));
      b.onResolve({ filter: /(?:^|\/)localDict(\.ts)?$/ }, a => ({ path: a.path, namespace: 'ldstub' }));
      b.onLoad({ filter: /.*/, namespace: 'ldstub' }, () => ({
        contents: 'export const localDictsFor = l => globalThis.__mockLocalFor ? globalThis.__mockLocalFor(l) : []; export const localDictsReady = async () => {}; export const lookupLocal = (w, l) => globalThis.__mockLookupLocal ? globalThis.__mockLookupLocal(w, l) : null;',
      }));
      b.onResolve({ filter: /(?:^|\/)review(\.ts)?$/ }, a => ({ path: a.path, namespace: 'revstub' }));
      b.onLoad({ filter: /.*/, namespace: 'revstub' }, () => ({ contents: 'export const addWord = async () => {}; export const addWordIfNew = async () => {};' }));
      b.onResolve({ filter: /(?:^|\/)desktop(\.ts)?$/ }, a => ({ path: a.path, namespace: 'dskstub' }));
      b.onLoad({ filter: /.*/, namespace: 'dskstub' }, () => ({
        contents: 'export const readBinaryFile = async () => new Uint8Array(); export const jaDictStatus = async () => ({ installed: false, size: 0 }); export const installJaDict = async () => {}; export const removeJaDict = async () => {}; export const onJaDictProgress = async () => () => {};',
      }));
    },
  }],
});

const webMod = await import(webOut);
const androidMod = await import(androidOut);
const uiMod = await import(uiOut);

// =========================================================================
// 1. Static source invariants
// =========================================================================
const webPlatformSrc = readFileSync('mobile/platform/wordPlatform.ts', 'utf8');
assert.ok(!webPlatformSrc.includes('@tauri-apps/'), 'Web wordPlatform must never import @tauri-apps/*');
assert.ok(!webPlatformSrc.includes('wordVoice'), 'Web wordPlatform must never import wordVoice');
assert.ok(!webPlatformSrc.includes('dictVoice'), 'Web wordPlatform must never import dictVoice');
assert.ok(!webPlatformSrc.includes('jaLookup'), 'Web wordPlatform must never import jaLookup');

const sheetSrc = readFileSync('mobile/WordSheet.tsx', 'utf8');
assert.ok(!sheetSrc.includes('dangerouslySetInnerHTML'), 'WordSheet must never use raw dangerouslySetInnerHTML');

// =========================================================================
// 2. arrayBufferToBase64 & 2 MiB size limit guard
// =========================================================================
assert.equal(webMod.arrayBufferToBase64(new ArrayBuffer(0)), '');
assert.equal(androidMod.arrayBufferToBase64(new ArrayBuffer(0)), '');

const small = new Uint8Array([1, 2, 3]).buffer;
assert.equal(webMod.arrayBufferToBase64(small), 'AQID');
assert.equal(androidMod.arrayBufferToBase64(small), 'AQID');

// All 256 byte values round-trip cleanly
const allBytes = new Uint8Array(256);
for (let i = 0; i < 256; i++) allBytes[i] = i;
const allB64 = androidMod.arrayBufferToBase64(allBytes.buffer);
assert.deepEqual(new Uint8Array(Buffer.from(allB64, 'base64')), allBytes);

// Multi-chunk (> 64KB, crossing 0x8000 chunk size multiple times) without call-stack overflow
const large = new Uint8Array(100_000);
for (let i = 0; i < large.length; i++) large[i] = (i * 31) & 0xff;
const largeB64 = androidMod.arrayBufferToBase64(large.buffer);
assert.deepEqual(new Uint8Array(Buffer.from(largeB64, 'base64')), large);

// Size guard: 0 bytes, null/undefined, exact 2 MiB, and 2 MiB + 1 byte
assert.equal(androidMod.MAX_AUX_AUDIO_BYTES, 2 * 1024 * 1024);
assert.equal(androidMod.encodeAuxAudio(null), null);
assert.equal(androidMod.encodeAuxAudio(undefined), null);
assert.equal(androidMod.encodeAuxAudio(new ArrayBuffer(0)), null);
assert.ok(typeof androidMod.encodeAuxAudio(new ArrayBuffer(androidMod.MAX_AUX_AUDIO_BYTES)) === 'string', 'exact 2 MiB boundary allowed');
assert.equal(androidMod.encodeAuxAudio(new ArrayBuffer(androidMod.MAX_AUX_AUDIO_BYTES + 1)), null, '> 2 MiB rejected');

// =========================================================================
// 3. Eudic { img } / { ruby, rt } / HTML whitelist sanitization
// =========================================================================
const { isSafeImgUrl, sanitizeSegs, senseFields, aiFields, renderSegText, clean } = uiMod;

assert.equal(isSafeImgUrl('https://www.esdict.cn/tmp/wordimg/a1.png'), true);
assert.equal(isSafeImgUrl('https://www.frdic.com/tmp/wordimg/b2.png'), true);
assert.equal(isSafeImgUrl('http://www.esdict.cn/tmp/wordimg/a1.png'), false, 'plain http rejected');
assert.equal(isSafeImgUrl('javascript:alert(1)'), false, 'javascript: rejected');
assert.equal(isSafeImgUrl('data:image/svg+xml,<svg onload=alert(1)>'), false, 'data: rejected');
assert.equal(isSafeImgUrl('file:///etc/passwd'), false, 'file: rejected');
assert.equal(isSafeImgUrl('not-a-url'), false);

const mixedSegs = [
  '释义 ',
  { img: 'https://www.esdict.cn/tmp/wordimg/g1.png' },
  { img: 'javascript:alert(1)' },
  { img: 'http://insecure.example/x.png' },
  { ruby: '食べる', rt: 'たべる' },
  '<script>alert(1)</script>',
];
const cleanedSegs = sanitizeSegs(mixedSegs);
assert.equal(cleanedSegs.length, 4);
assert.deepEqual(cleanedSegs[1], { img: 'https://www.esdict.cn/tmp/wordimg/g1.png' });
assert.deepEqual(cleanedSegs[2], { ruby: '食べる', rt: 'たべる' });

// SegText SSR output checks: safe https img, ruby/rt, text escaping, unsafe imgs dropped
const rendered = renderSegText(mixedSegs);
assert.ok(rendered.includes('<img src="https://www.esdict.cn/tmp/wordimg/g1.png" alt="" class="inline h-[1em] align-[-0.12em] mix-blend-multiply"/>'));
assert.ok(rendered.includes('<ruby>食べる<rt>たべる</rt></ruby>'));
assert.ok(rendered.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(!rendered.includes('javascript:'), 'javascript: img must never render');
assert.ok(!rendered.includes('insecure.example'), 'http: img must never render');

// senseFields & aiFields card HTML safety
const keptSense = senseFields(
  { word: 'hablar', phonetic: '/aˈβlaɾ/', senses: [], source: 'eudic' },
  { pos: 'vt.', text: mixedSegs, examples: [['¿Hablas <img src=x onerror=1>?', { img: 'javascript:evil()' }]] },
  null,
  '此处意为“说”',
);
assert.ok(keptSense.definition.includes('<img src="https://www.esdict.cn/tmp/wordimg/g1.png">'));
assert.ok(keptSense.definition.includes('<ruby>食べる<rt>たべる</rt></ruby>'));
assert.ok(keptSense.definition.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
assert.ok(!keptSense.definition.includes('javascript:'));
assert.ok(!keptSense.example.includes('javascript:'));
assert.ok(keptSense.example.includes('&lt;img src=x onerror=1&gt;'));
assert.equal(keptSense.ai, '此处意为“说”');

const keptAi = aiFields({ word: '<b>x</b>', partOfSpeech: 'n.', definition: '<script>1</script>', culture: 'note' });
assert.equal(keptAi.definition, '<b>&lt;b&gt;x&lt;/b&gt;</b> <i>(n.)</i><br/>&lt;script&gt;1&lt;/script&gt;');
assert.equal(keptAi.ai, 'note');

// utils/cleanHtml.ts whitelist check with minimal DOMParser shim for Node
{
  const TEXT_NODE = 3;
  class FakeNode { constructor(nodeType, textContent = '') { this.nodeType = nodeType; this.textContent = textContent; this.childNodes = []; } }
  class FakeElement extends FakeNode {
    constructor(tagName, attrs = {}) { super(1); this.tagName = tagName.toUpperCase(); this.attrs = attrs; }
    getAttribute(k) { return this.attrs[k] ?? null; }
  }
  const origNode = globalThis.Node;
  const origElem = globalThis.Element;
  const origDP = globalThis.DOMParser;
  globalThis.Node = { TEXT_NODE };
  globalThis.Element = FakeElement;
  globalThis.DOMParser = class {
    parseFromString() {
      const body = new FakeElement('body');
      const b = new FakeElement('b'); b.childNodes.push(new FakeNode(TEXT_NODE, 'word'));
      const br = new FakeElement('br');
      const ruby = new FakeElement('ruby'); ruby.childNodes.push(new FakeNode(TEXT_NODE, '漢'));
      const rt = new FakeElement('rt'); rt.childNodes.push(new FakeNode(TEXT_NODE, 'かん'));
      ruby.childNodes.push(rt);
      const okImg = new FakeElement('img', { src: 'https://www.esdict.cn/tmp/wordimg/a.png' });
      const badImg = new FakeElement('img', { src: 'javascript:alert(1)' });
      const script = new FakeElement('script'); script.childNodes.push(new FakeNode(TEXT_NODE, 'alert(1)'));
      const div = new FakeElement('div'); div.childNodes.push(new FakeNode(TEXT_NODE, 'plain & <raw>'));
      body.childNodes.push(b, br, ruby, okImg, badImg, script, div);
      return { body };
    }
  };
  try {
    const out = clean('ignored-by-shim');
    assert.equal(
      out,
      '<b>word</b><br/><ruby>漢<rt>かん</rt></ruby><img src="https://www.esdict.cn/tmp/wordimg/a.png">plain &amp; &lt;raw&gt;',
      'cleanHtml allows only whitelist tags + https img and drops script / javascript img',
    );
  } finally {
    globalThis.Node = origNode;
    globalThis.Element = origElem;
    globalThis.DOMParser = origDP;
  }
}

// =========================================================================
// 4. Dictionary source caption mapping & error keys (zh + en)
// =========================================================================
const makeT = dict => (key, vars) => {
  let s = dict[key];
  assert.ok(typeof s === 'string', `missing i18n key: ${key}`);
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
};
const tZh = makeT(uiMod.zh);
const tEn = makeT(uiMod.en);
const { dictSourceLabel, errorKeyOf } = uiMod;

const sources = ['youdao', 'cambridge', 'cambridgeEn', 'cambridgeBi', 'eudic', 'wiktionary', 'jisho', 'local'];
for (const source of sources) {
  const entry = { word: 'test', phonetic: '', senses: [], source };
  const zhLabel = dictSourceLabel([entry], tZh, 'android', true);
  const enLabel = dictSourceLabel([entry], tEn, 'android', true);
  assert.equal(zhLabel, `释义来自 ${uiMod.zh[`dict.${source}`]}`);
  assert.equal(enLabel, `From ${uiMod.en[`dict.${source}`]}`);
}
// Local dict with explicit dictName overrides dict.local (single & multiple)
assert.equal(dictSourceLabel([{ word: '猫', phonetic: '', senses: [], source: 'local', dictName: 'JMdict' }], tZh, 'android', false), '释义来自 JMdict');
assert.equal(dictSourceLabel([
  { word: '猫', phonetic: '', senses: [], source: 'local', dictName: 'Jitendex.org' },
  { word: '猫', phonetic: '', senses: [], source: 'local', dictName: 'wty-ja-zh' },
], tZh, 'android', false), '释义来自 Jitendex.org / wty-ja-zh');
// Web/PWA keeps Wiktionary copy unchanged
assert.equal(
  dictSourceLabel([{ word: 'test', phonetic: '', senses: [], source: 'youdao' }], tZh, 'web', true),
  uiMod.zh['m.fromWiki'],
);
assert.equal(
  dictSourceLabel([{ word: 'test', phonetic: '', senses: [], source: 'youdao' }], tZh, 'web', false),
  uiMod.zh['m.fromWikiNoAi'],
);
// All error keys map to valid zh & en strings
for (const err of ['offline', 'noDict', 'dictsOff', 'noLocal', 'notFound']) {
  const k = errorKeyOf(err);
  assert.ok(k, `missing error key for ${err}`);
  assert.ok(tZh(k).length > 0 && tEn(k).length > 0);
}
assert.equal(errorKeyOf(''), null);

// =========================================================================
// 5. Web vs Android lookup routing & aux-channel bridge contract
// =========================================================================
assert.equal(webMod.WORD_PLATFORM, 'web');
assert.equal(webMod.CAN_SPEAK_WORD, false);
assert.equal(await webMod.speakWordAux('hello', 'en'), false);
webMod.stopWordAux(); // no-op

const webCalls = [];
globalThis.__jaLemma = w => (w === '食べました' ? '食べる' : w);
globalThis.__webWiki = async (w, l) => {
  webCalls.push(`${l}:${w}`);
  if (w === 'offline') throw new Error('net');
  if (w === 'missing') return null;
  return [{ word: w, phonetic: '', senses: [{ pos: 'n.', text: ['ok'], examples: [] }], source: 'wiktionary' }];
};
assert.deepEqual(await webMod.lookupOnlineWord('x', null, false), { dict: null, error: 'noDict' });
assert.equal((await webMod.lookupOnlineWord('食べました', 'ja', true)).dict?.[0].word, '食べる');
assert.deepEqual(webCalls, ['ja:食べる']);
assert.deepEqual(await webMod.lookupOnlineWord('offline', 'en', false), { dict: null, error: 'offline' });
assert.deepEqual(await webMod.lookupOnlineWord('missing', 'en', false), { dict: null, error: 'notFound' });

// Android lookup routing
assert.equal(androidMod.WORD_PLATFORM, 'android');
assert.equal(androidMod.CAN_SPEAK_WORD, true);

const aCalls = [];
let dictsOffReply = null;
let wordReply = async () => null;
let jaReply = async () => null;
globalThis.__dictsOff = async l => { aCalls.push(`off:${l}`); return dictsOffReply; };
globalThis.__lookupWord = async (w, l) => { aCalls.push(`word:${l}:${w}`); return wordReply(w, l); };
globalThis.__lookupJa = async w => { aCalls.push(`ja:${w}`); return jaReply(w); };

assert.deepEqual(await androidMod.lookupOnlineWord('test', null, false), { dict: null, error: 'noDict' });
dictsOffReply = 'all';
assert.deepEqual(await androidMod.lookupOnlineWord('test', 'en', false), { dict: null, error: 'dictsOff' });
dictsOffReply = 'noLocal';
assert.deepEqual(await androidMod.lookupOnlineWord('test', 'en', false), { dict: null, error: 'noLocal' });

dictsOffReply = null;
wordReply = async w => [{ word: w, phonetic: '/t/', senses: [{ pos: 'n.', text: ['ok'], examples: [] }], source: 'youdao' }];
const enRes = await androidMod.lookupOnlineWord('test', 'en', false);
assert.equal(enRes.error, '');
assert.equal(enRes.dict?.[0].source, 'youdao');

jaReply = async w => [{ word: w, phonetic: '', senses: [{ pos: '动', text: ['吃'], examples: [] }], source: 'jisho' }];
const jaRes = await androidMod.lookupOnlineWord('食べる', 'ja', true);
assert.equal(jaRes.error, '');
assert.equal(jaRes.dict?.[0].source, 'jisho');
assert.ok(aCalls.includes('word:en:test') && aCalls.includes('ja:食べる'));

wordReply = async () => { throw new Error('timeout'); };
assert.deepEqual(await androidMod.lookupOnlineWord('fail', 'en', false), { dict: null, error: 'offline' });
wordReply = async () => null;
assert.deepEqual(await androidMod.lookupOnlineWord('none', 'en', false), { dict: null, error: 'notFound' });

// LocalStorage shim for getWordVoice() / linguaclip_dict_sources tests
const lsMap = new Map();
const origLS = globalThis.localStorage;
globalThis.localStorage = {
  getItem: k => (lsMap.has(k) ? lsMap.get(k) : null),
  setItem: (k, v) => { lsMap.set(k, String(v)); },
  removeItem: k => { lsMap.delete(k); },
  clear: () => { lsMap.clear(); },
};

// Aux-channel bridge contract with mocked window.LinguaAndroid
const bridgeLog = [];
let bridgeOk = true;
const origWindow = globalThis.window;
globalThis.window = {
  LinguaAndroid: {
    isAvailable: () => true,
    call(reqId, method, argsJson) {
      bridgeLog.push({ method, args: JSON.parse(argsJson) });
      queueMicrotask(() => {
        globalThis.window.__lcAndroidResolve(reqId, bridgeOk, bridgeOk ? '{}' : JSON.stringify({ error: 'aux_fail' }));
      });
    },
  },
};

try {
  // playAuxAudioBytes rejects empty and > 2 MiB without calling bridge
  assert.equal(await androidMod.playAuxAudioBytes(new ArrayBuffer(0)), false);
  assert.equal(await androidMod.playAuxAudioBytes(new ArrayBuffer(androidMod.MAX_AUX_AUDIO_BYTES + 1)), false);
  assert.equal(bridgeLog.length, 0);

  // wordVoice = 'clip' returns false immediately without calling dictVoice, TTS, or bridge
  lsMap.set('linguaclip_practice_config', JSON.stringify({ wordVoice: 'clip' }));
  let clipTouched = false;
  globalThis.__dictVoice = async () => { clipTouched = true; return new Uint8Array([1, 2]).buffer; };
  globalThis.__tts = async () => { clipTouched = true; return new Uint8Array([3, 4]).buffer; };
  assert.equal(await androidMod.speakWordAux('clipword', 'en'), false);
  assert.equal(clipTouched, false, 'wordVoice=clip must not invoke dictVoice or TTS');
  assert.equal(bridgeLog.length, 0);
  lsMap.set('linguaclip_practice_config', JSON.stringify({ wordVoice: 'tts' }));

  // Dictionary voice wins over Edge TTS and invokes playback.playAuxBytes with pauseMain: false
  const mp3Bytes = new Uint8Array([0x49, 0x44, 0x33, 0x03, 0x00, 0x01, 0x02, 0x03]).buffer;
  globalThis.__dictVoice = async () => mp3Bytes;
  globalThis.__tts = async () => new Uint8Array([9, 9]).buffer;
  assert.equal(await androidMod.speakWordAux('apple', 'en'), true);
  assert.equal(bridgeLog.at(-1).method, 'playback.playAuxBytes');
  assert.equal(bridgeLog.at(-1).args.ext, 'mp3');
  assert.equal(bridgeLog.at(-1).args.pauseMain, false, 'word pronunciation must NEVER pause/steal main audio focus');
  assert.deepEqual(new Uint8Array(Buffer.from(bridgeLog.at(-1).args.base64, 'base64')), new Uint8Array(mp3Bytes));

  // Rapid duplicate tap on same word plays only once (deduped)
  const playsBefore = bridgeLog.filter(x => x.method === 'playback.playAuxBytes').length;
  assert.equal(await androidMod.speakWordAux('apple', 'en'), true);
  assert.equal(bridgeLog.filter(x => x.method === 'playback.playAuxBytes').length, playsBefore, 'duplicate tap must play only once');

  // Different word interrupts previous (stopAux) and falls back to Edge TTS when dictVoice returns 'none'
  const ttsBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x64]).buffer;
  globalThis.__dictVoice = async () => 'none';
  globalThis.__tts = async (_text, voice) => { assert.equal(voice, 'ja-JP-NanamiNeural'); return ttsBytes; };
  assert.equal(await androidMod.speakWordAux('猫', 'ja'), true);
  assert.equal(bridgeLog.at(-2).method, 'playback.stopAux', 'new word interrupts previous playback');
  assert.equal(bridgeLog.at(-1).method, 'playback.playAuxBytes');
  assert.equal(bridgeLog.at(-1).args.pauseMain, false);
  assert.deepEqual(new Uint8Array(Buffer.from(bridgeLog.at(-1).args.base64, 'base64')), new Uint8Array(ttsBytes));

  // Concurrent duplicate taps while in-flight share one playback; new word interrupts in-flight
  let resolveSlow;
  globalThis.__dictVoice = () => new Promise(r => { resolveSlow = r; });
  globalThis.__tts = async () => 'none';
  const dupA = androidMod.speakWordAux('slowdup', 'en');
  const dupB = androidMod.speakWordAux('slowdup', 'en');
  androidMod.stopWordAux();
  resolveSlow(mp3Bytes);
  assert.deepEqual(await Promise.all([dupA, dupB]), [false, false], 'stopped in-flight speak must not fire playAuxBytes');
  assert.equal(bridgeLog.at(-1).method, 'playback.stopAux');

  // Bridge error returns false cleanly; both dictVoice & TTS unavailable returns false
  bridgeOk = false;
  globalThis.__dictVoice = async () => mp3Bytes;
  assert.equal(await androidMod.speakWordAux('bridgefail', 'en'), false);
  bridgeOk = true;
  globalThis.__dictVoice = async () => 'none';
  globalThis.__tts = async () => null;
  assert.equal(await androidMod.speakWordAux('missingvoice', 'en'), false);

  // Offline + localFirst lookup returns local Yomitan dict without touching network
  lsMap.set('linguaclip_dict_sources', JSON.stringify({ online: true, local: true, localFirst: true }));
  const origFetch = globalThis.fetch;
  let netCalled = false;
  globalThis.fetch = async () => { netCalled = true; throw new Error('offline'); };
  globalThis.__mockLocalFor = () => [{ id: 'd1', lang: 'en', enabled: true }];
  globalThis.__mockLookupLocal = async w => [{ word: w, phonetic: '', senses: [{ pos: 'n.', text: ['苹果'], examples: [] }], source: 'local', dictName: 'wty-en-zh' }];
  try {
    const offlineLocal = await uiMod.lookupWord('apple', 'en');
    assert.equal(netCalled, false, 'localFirst hit must not touch network when offline');
    assert.equal(offlineLocal?.[0].source, 'local');
    assert.equal(offlineLocal?.[0].dictName, 'wty-en-zh');
  } finally {
    globalThis.fetch = origFetch;
  }

  // dictRecommend helpers (zh vs en recommendations, dictLabel, isInstalled)
  assert.equal(uiMod.dictLabel('JMdict [2026-09-29]'), 'JMdict');
  assert.equal(uiMod.recommendedFor('zh', 'en')[0].gloss, 'zh');
  assert.ok(uiMod.recommendedFor('en', 'es').every(r => r.gloss === 'en'));
  assert.equal(uiMod.isInstalled(uiMod.recommendedFor('zh', 'ja')[0], [{ title: 'wty-ja-zh [2026-01-01]', broken: false, downloadUrl: null }]), true);
} finally {
  globalThis.window = origWindow;
  globalThis.localStorage = origLS;
}

// When native bridge is absent, speakWordAux returns false
assert.equal(await androidMod.speakWordAux('apple', 'en'), false);

// =========================================================================
// 6. Japanese base-form display & card front saving (other languages untouched)
// =========================================================================
const { jaBaseForm, cardWordOf } = uiMod;
const jaLine = { id: 1, startTime: 0, endTime: 2, text: '昨日リンゴを食べました。' };
const jaEntry = { word: '食べる', phonetic: 'たべる', senses: [{ pos: '动', text: ['吃'], examples: [] }], source: 'jisho' };
const jaDef = { word: '食べました', line: jaLine, around: '', lang: 'ja', phrase: false, dict: [jaEntry], ai: null };
assert.equal(jaBaseForm(jaDef), '食べる', 'conjugated Japanese form shows dictionary base form');
assert.equal(cardWordOf(jaDef, jaEntry), '食べる', 'Japanese word card saves base form');
assert.equal(jaBaseForm({ ...jaDef, word: '食べる' }), null, 'same surface and base omits redundant badge');
assert.equal(cardWordOf({ ...jaDef, word: '食べる' }, jaEntry), '食べる');
assert.equal(jaBaseForm({ ...jaDef, word: '気をつけて', phrase: true }), null, 'Japanese dragged phrase keeps original phrase');
assert.equal(cardWordOf({ ...jaDef, word: '気をつけて', phrase: true }, jaEntry), '気をつけて');
const jaAiDef = { word: '走りました', line: jaLine, around: '', lang: 'ja', phrase: false, dict: null, ai: { word: '走る', partOfSpeech: 'v.', definition: '跑' } };
assert.equal(jaBaseForm(jaAiDef), '走る', 'Japanese AI fallback headword also provides base form');
assert.equal(cardWordOf(jaAiDef), '走る');

const enEntry = { word: 'go', phonetic: '', senses: [{ pos: 'v.', text: ['to move'], examples: [] }], source: 'wiktionary' };
const enDef = { word: 'went', line: jaLine, around: '', lang: 'en', phrase: false, dict: [enEntry], ai: null };
assert.equal(jaBaseForm(enDef), null, 'English lookup must not show Japanese base-form badge');
assert.equal(cardWordOf(enDef, enEntry), 'went', 'English word card must keep tapped word unchanged');

// =========================================================================
// 7. Summary Japanese base-form helper & non-clobbering empty phrase save
// =========================================================================
const { cardWordForFirst, isEmptyKeep, saveWordCard, phraseSaveFields } = uiMod;
const jaMultiDef = {
  ...jaDef,
  loading: false,
  aiBusy: false,
  aiError: '',
  error: '',
  picked: 2,
  dict: [
    jaEntry,
    { word: '食う', phonetic: 'くう', senses: [{ pos: '动', text: ['吃（口语）'], examples: [] }], source: 'jisho' },
  ],
};
assert.equal(cardWordForFirst({ ...jaMultiDef, picked: null }), '食べる', 'summary save uses first dict entry base form');
assert.equal(cardWordForFirst(jaMultiDef), '食う', 'summary save follows AI-picked dict entry base form');
assert.equal(cardWordForFirst({ ...jaAiDef, loading: false, aiBusy: false, aiError: '', error: '' }), '走る', 'summary save uses AI headword base form');
assert.equal(cardWordForFirst({ ...enDef, loading: false, aiBusy: false, aiError: '', error: '' }), 'went', 'English summary save stays unchanged');

assert.equal(isEmptyKeep({ definition: '', example: '', ai: '' }), true);
assert.equal(isEmptyKeep({ definition: '  ', example: '\n', ai: '' }), true);
assert.equal(isEmptyKeep({ definition: 'meaning', example: '', ai: '' }), false);
assert.equal(isEmptyKeep({ definition: '', example: '', ai: 'note' }), false);

const saveCalls = [];
const mockWriters = {
  addWord: async (...args) => { saveCalls.push(['addWord', args]); },
  addWordIfNew: async (...args) => { saveCalls.push(['addWordIfNew', args]); },
};
const lineRef = { videoId: 'v1', videoName: 'ep.mp3', text: 'come what may', start: 1, end: 3 };
const emptyPhrase = phraseSaveFields({
  word: 'come what may', line: jaLine, around: '', lang: 'en', phrase: true,
  loading: false, dict: null, ai: null, aiBusy: false, aiError: '', picked: null, error: 'notFound',
});
assert.ok(emptyPhrase);
await saveWordCard(lineRef, 'come what may', emptyPhrase, mockWriters);
assert.equal(saveCalls.length, 1);
assert.equal(saveCalls[0][0], 'addWordIfNew', 'empty-meaning phrase save uses addWordIfNew so existing card meaning is never overwritten');
assert.equal(saveCalls[0][1][1], 'come what may');
assert.equal(saveCalls[0][1][2], '');

await saveWordCard(lineRef, 'come what may', { definition: '<b>whatever happens</b>', example: 'ex', ai: '' }, mockWriters);
assert.equal(saveCalls.length, 2);
assert.equal(saveCalls[1][0], 'addWord', 'non-empty meaning save uses addWord');

// All W4 i18n keys exist in both zh & en
for (const k of [
  'm.w4NoAudioBanner', 'm.w4KanaNeedDict', 'm.w4KanaDownloadNow', 'm.w4JaBaseForm',
  'm.w4KeepWordBtn', 'm.w4KeepWordShort', 'm.w4KeptWordBtn', 'm.w4KeptWordHint',
  'm.w4BackupNoClips', 'm.w4BackupClipsPending',
]) {
  assert.ok(typeof uiMod.zh[k] === 'string' && uiMod.zh[k].length > 0, `missing zh key ${k}`);
  assert.ok(typeof uiMod.en[k] === 'string' && uiMod.en[k].length > 0, `missing en key ${k}`);
}

console.log('mobile word-android ok');
