/**
 * Checks mobile/ankiDroidExport.ts (docs/android-roadmap.md M2.5):
 * - skips already-sent cards (initial and mid-batch re-read)
 * - stops on the first card when AnkiDroid is not installed / unavailable
 * - continues past a single refused card (noteId: null) without marking ankiAt
 * - injects audio/image media refs (word audio before sentence audio) into exact model fields
 * - routes cards into per-language sub-decks (LinguaClip::English, LinguaClip::Japanese, LinguaClip)
 * - deletes temporary anki_* clips while preserving cards' own standalone clips
 * Run with: node mobile/test-anki-droid.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-anki-droid-${process.pid}.mjs`);
await build({
  entryPoints: ['mobile/ankiDroidExport.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
  jsx: 'automatic',
});

// Minimal browser globals for storage.ts, cleanHtml.ts, and androidBridge.ts
const ls = new Map();
globalThis.localStorage = {
  getItem: k => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => { ls.set(k, String(v)); },
  removeItem: k => { ls.delete(k); },
};

class FakeNode {
  constructor(nodeType, textContent = '') {
    this.nodeType = nodeType;
    this.textContent = textContent;
    this.childNodes = [];
  }
}
FakeNode.TEXT_NODE = 3;
class FakeElement extends FakeNode {
  constructor(tagName, attrs = {}) {
    super(1, '');
    this.tagName = tagName.toUpperCase();
    this._attrs = attrs;
  }
  getAttribute(k) { return this._attrs[k] ?? null; }
}
globalThis.Node = FakeNode;
globalThis.Element = FakeElement;
globalThis.DOMParser = class {
  parseFromString(html) {
    const root = new FakeElement('body');
    const stack = [root];
    const re = /<\/?([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      const parent = stack[stack.length - 1];
      if (m[3] !== undefined) {
        parent.childNodes.push(new FakeNode(3, m[3]));
      } else if (m[0].startsWith('</')) {
        if (stack.length > 1) stack.pop();
      } else {
        const tag = m[1].toLowerCase();
        const attrs = {};
        const src = /src=["']([^"']*)["']/i.exec(m[2] || '');
        if (src) attrs.src = src[1];
        const el = new FakeElement(tag, attrs);
        parent.childNodes.push(el);
        if (!['br', 'img'].includes(tag) && !m[0].endsWith('/>')) stack.push(el);
      }
    }
    return { body: root };
  }
};

const {
  exportToAnkiDroid,
  getAnkiDroidProgress,
  subscribeAnkiDroid,
  deckNameForLang,
  buildNoteFields,
  linguaClipModelSpec,
} = await import(out);

function installMockAndroid(handler) {
  const calls = [];
  globalThis.window = {
    LinguaAndroid: {
      isAvailable: () => true,
      call(reqId, method, argsJson) {
        const args = argsJson ? JSON.parse(argsJson) : {};
        calls.push({ method, args });
        queueMicrotask(async () => {
          try {
            const res = await handler(method, args);
            globalThis.window.__lcAndroidResolve(reqId, true, JSON.stringify(res));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            globalThis.window.__lcAndroidResolve(reqId, false, JSON.stringify({ error: msg }));
          }
        });
      },
    },
  };
  return calls;
}

const makeCard = (id, more = {}) => ({
  id,
  deck: 'line',
  videoId: 'v-en',
  videoName: 'Podcast Ep 1',
  text: 'Hello world from LinguaClip.',
  start: 10,
  end: 12,
  reasons: ['saved'],
  saved: true,
  fsrs: { due: 0, stability: 0, difficulty: 0, elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0 },
  createdAt: 1,
  ...more,
});

// --- Pure helpers ---
assert.equal(deckNameForLang('en'), 'LinguaClip::English');
assert.equal(deckNameForLang('ja'), 'LinguaClip::Japanese');
assert.equal(deckNameForLang('other'), 'LinguaClip');
assert.equal(linguaClipModelSpec().name, 'LinguaClip');
assert.deepEqual(linguaClipModelSpec().fields, ['Sentence', 'Audio', 'Image', 'Word', 'Definition', 'Example', 'Video', 'Time']);

{
  const fields = buildNoteFields(
    makeCard('w1', {
      deck: 'word',
      word: 'world',
      text: 'Hello world <tag>',
      definition: '<b>earth</b><script>bad()</script>',
      ai: 'context note',
      example: '<i>my world</i>',
      start: 65,
    }),
    { audioRefs: ['[sound:word.m4a]', '[sound:line.m4a]'], imageRef: '<img src="shot.jpg">' },
  );
  assert.equal(fields[0], 'Hello <b>world</b> &lt;tag&gt;');
  assert.equal(fields[1], '[sound:word.m4a][sound:line.m4a]');
  assert.equal(fields[2], '<img src="shot.jpg">');
  assert.equal(fields[3], 'world');
  assert.ok(fields[4].includes('<b>earth</b>') && !fields[4].includes('<script>') && fields[4].includes('context note'));
  assert.equal(fields[5], '<i>my world</i>');
  assert.equal(fields[6], 'Podcast Ep 1');
  assert.equal(fields[7], '01:05');
}

// --- 1. AnkiDroid not installed → stops on the very first unsent card ---
{
  const calls = installMockAndroid(method => {
    if (method === 'anki.status') return { installed: false, permitted: false, apiAvailable: false };
    throw new Error('anki:not_installed');
  });
  const cards = [makeCard('c1'), makeCard('c2')];
  const store = new Map(cards.map(c => [c.id, c]));
  const res = await exportToAnkiDroid(cards, undefined, {
    getVideos: async () => [{ id: 'v-en', lang: 'en' }],
    getAllCards: async () => cards,
    getCard: async id => store.get(id) ?? null,
    markSent: async () => { throw new Error('should not mark'); },
    clipPath: async f => `/files/clips/${f}`,
    pathExists: async () => false,
    findSource: async () => null,
    cutClip: async () => { throw new Error('no cut'); },
    loadWords: async () => null,
    now: () => 1000,
  });
  assert.equal(res.stopped?.why, 'anki');
  assert.equal(res.stopped?.error, 'anki:not_installed');
  assert.deepEqual(res.sent, []);
  assert.equal(res.refused, 0);
  // ensureModel tried once, status checked once, never attempted card 2
  assert.equal(calls.filter(c => c.method === 'anki.ensureModel').length, 1);
  assert.equal(calls.filter(c => c.method === 'anki.status').length, 1);
  assert.equal(getAnkiDroidProgress(), null);
}

// --- 2. Full batch: skipped + language decks + word/line audio refs + refused card + temp cleanup vs own clip preserved ---
{
  const createdDecks = new Map();
  let nextDeckId = 100;
  let nextNoteId = 500;
  const addedNotes = [];
  const addedMedia = [];
  const removedFiles = [];

  const calls = installMockAndroid((method, args) => {
    if (method === 'anki.status') return { installed: true, permitted: true, apiAvailable: true, version: '2.19.0' };
    if (method === 'anki.ensureModel') return { modelId: 42 };
    if (method === 'anki.ensureDeck') {
      if (!createdDecks.has(args.name)) createdDecks.set(args.name, ++nextDeckId);
      return { deckId: createdDecks.get(args.name) };
    }
    if (method === 'anki.addMedia') {
      addedMedia.push(args);
      const ext = args.kind === 'image' ? 'jpg' : 'm4a';
      const fileName = `${args.preferredName}.${ext}`;
      const ref = args.kind === 'audio' ? `[sound:${fileName}]` : `<img src="${fileName}">`;
      return { ref, fileName };
    }
    if (method === 'anki.addNote') {
      addedNotes.push(args);
      if (args.fields[0].includes('REFUSE_ME')) return { noteId: null };
      return { noteId: ++nextNoteId };
    }
    if (method === 'media.removeFile') {
      removedFiles.push(args.path);
      return { deleted: true };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  const cSent = makeCard('c-sent', { ankiAt: 1234 });
  const cOwnClip = makeCard('c-own', {
    videoId: 'v-en',
    text: 'Keep my standalone clip.',
    clip: { kind: 'audio', file: 'v-en_10.00.m4a', image: 'v-en_10.00.jpg', from: 8.5 },
  });
  const cTempWord = makeCard('c-word', {
    deck: 'word',
    videoId: 'v-ja',
    videoName: 'JP Show',
    text: 'hello apple today',
    word: 'apple',
    definition: 'a fruit',
    start: 20,
    end: 23,
  });
  const cRefused = makeCard('c-refused', {
    videoId: 'v-other',
    text: 'REFUSE_ME 12345',
    start: 30,
    end: 32,
  });
  const cRaceSkipped = makeCard('c-race', { videoId: 'v-en', text: 'Sent elsewhere mid-batch.' });

  const cards = [cSent, cOwnClip, cTempWord, cRefused, cRaceSkipped];
  const store = new Map(cards.map(c => [c.id, { ...c }]));
  const marked = [];
  const cuts = [];
  const progressEvents = [];
  const unsub = subscribeAnkiDroid(() => {
    const p = getAnkiDroidProgress();
    if (p) progressEvents.push(`${p[0]}/${p[1]}`);
  });

  const res = await exportToAnkiDroid(cards, undefined, {
    getVideos: async () => [
      { id: 'v-en', lang: 'en' },
      { id: 'v-ja', lang: 'ja' },
      { id: 'v-other' },
    ],
    getAllCards: async () => [...store.values()],
    getCard: async id => {
      // Simulate c-race being sent from another page before we reach it
      if (id === 'c-race') return { ...store.get(id), ankiAt: 9999 };
      return store.get(id) ?? null;
    },
    markSent: async (id, at) => {
      marked.push(id);
      const old = store.get(id);
      if (old) store.set(id, { ...old, ankiAt: at });
    },
    clipPath: async f => `/files/clips/${f}`,
    pathExists: async p => p === '/files/clips/v-en_10.00.m4a' || p === '/files/clips/v-en_10.00.jpg',
    findSource: async c => ({ path: `/files/media/${c.videoId}.m4a`, offset: 0 }),
    cutClip: async (src, from, to, name) => {
      cuts.push({ src, from, to, name });
      return { file: `${name}.m4a`, image: null };
    },
    loadWords: async vid => vid === 'v-ja'
      ? [
          { w: 'hello', from: 20000, to: 20800 },
          { w: 'apple', from: 20900, to: 21600 },
          { w: 'today', from: 21700, to: 22800 },
        ]
      : null,
    now: () => 2000,
  });
  unsub();

  assert.equal(res.stopped, undefined);
  assert.deepEqual(res.sent, ['c-own', 'c-word']);
  assert.equal(res.skipped, 2, 'c-sent + c-race skipped');
  assert.equal(res.refused, 1, 'c-refused refused without stopping');
  assert.equal(res.silent, 0);
  assert.deepEqual(marked, ['c-own', 'c-word'], 'refused card NOT marked');
  assert.equal(store.get('c-own').ankiAt, 2000);
  assert.equal(store.get('c-refused').ankiAt, undefined);

  // Per-language sub-decks
  assert.ok(createdDecks.has('LinguaClip::English'));
  assert.ok(createdDecks.has('LinguaClip::Japanese'));
  assert.ok(createdDecks.has('LinguaClip'), 'unsorted language falls back to base deck');
  assert.equal(calls.filter(c => c.method === 'anki.ensureModel').length, 1, 'model ensured once');

  // Note 1 (c-own): used existing clip + image directly, NO cutClip call for it
  const noteOwn = addedNotes[0];
  assert.equal(noteOwn.deckId, createdDecks.get('LinguaClip::English'));
  assert.match(noteOwn.fields[1], /^\[sound:lc_2000_v-en_10_00\.m4a\]$/);
  assert.match(noteOwn.fields[2], /^<img src="lc_2000_v-en_10_00_img\.jpg">$/);

  // Note 2 (c-word): word audio BEFORE sentence audio in Audio field
  const noteWord = addedNotes[1];
  assert.equal(noteWord.deckId, createdDecks.get('LinguaClip::Japanese'));
  assert.match(noteWord.fields[1], /^\[sound:lc_2000_v-ja_20_00_w\.m4a\]\[sound:lc_2000_v-ja_20_00\.m4a\]$/);
  assert.equal(noteWord.fields[3], 'apple');
  assert.equal(noteWord.fields[4], 'a fruit');

  // Card's own clip was NOT cut and NEVER removed; all temporary anki_* clips WERE removed (including refused card's temp clip)
  assert.equal(cuts.some(c => c.name.includes('v-en_10.00')), false, 'existing clip not re-cut');
  assert.equal(cuts.length, 3, 'sentence + word for c-word, plus sentence for c-refused');
  assert.equal(removedFiles.length, 3, 'all 3 temp clips cleaned up');
  assert.ok(removedFiles.every(p => p.includes('/files/clips/anki_2000_')));
  assert.equal(removedFiles.some(p => p.includes('v-en_10.00')), false, 'card own clip NEVER deleted');
  assert.ok(progressEvents.includes('0/4') && progressEvents.includes('4/4'));
  assert.equal(getAnkiDroidProgress(), null);
}

console.log('mobile ankiDroidExport ok');
