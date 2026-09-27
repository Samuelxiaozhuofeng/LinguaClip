import { useSyncExternalStore } from 'react';
// kuromoji's own loader needs node's `path`; its dictionary and tokenizer do not.
import DynamicDictionaries from 'kuromoji/src/dict/DynamicDictionaries';
import Tokenizer from 'kuromoji/src/Tokenizer';
import { jaDictStatus, installJaDict, removeJaDict, readBinaryFile, onJaDictProgress } from './desktop';
import { JA_PHRASES, JA_PHRASE_LIST, JA_SPELLING } from './jaPhrases';

// Japanese lines have no spaces, so they are split with kuromoji (ipadic, a
// download of its own: src-tauri/src/ja_dict.rs) into phrase-sized groups — a
// word plus the particles and endings stuck to it (今日は / いい / 天気ですね),
// one input box each. Each group carries its reading, so typing it in kana counts.
// Where the AI has checked a line (utils/jaSegments.ts), its cut points win.

export const hasKana = (text: string) => /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);

export type JaGroup = { value: string; reading?: string; punct: boolean };
type Morph = { s: string; at: number; pos: string; d1: string; base: string; reading?: string; punct: boolean };

// --- State shared by every screen: dictionary, AI cut points, a version to re-render on ---

let tokenizer: { tokenize(text: string): any[] } | null = null;
let loading: Promise<boolean> | null = null;
// line text → char offsets where each group starts (from the AI check)
const cuts = new Map<string, number[]>();
let version = 0; // bumps whenever a line may split differently
const listeners = new Set<() => void>();
const ping = () => listeners.forEach(fn => fn());
const bump = () => { version++; ping(); };

export const subscribeJa = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useJaVersion = () => useSyncExternalStore(subscribeJa, () => version);
export const jaReady = () => tokenizer !== null;

// For the download UI. installed: null = not checked yet. failed: the last
// download or load did not work.
export type JaState = { installed: boolean | null; ready: boolean; running: boolean; pct: number; failed: boolean };
let state: JaState = { installed: null, ready: false, running: false, pct: 0, failed: false };
const setState = (patch: Partial<JaState>) => { state = { ...state, ...patch }; ping(); };
export const useJaState = () => useSyncExternalStore(subscribeJa, () => state);

const FILES = ['base', 'check', 'tid', 'tid_pos', 'tid_map', 'cc', 'unk', 'unk_pos', 'unk_map', 'unk_char', 'unk_compat', 'unk_invoke'];

// ponytail: DecompressionStream needs WebKit 16.4+; without it the load fails and lines stay whole.
const gunzip = async (bytes: Uint8Array): Promise<ArrayBuffer> =>
  new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();

async function build(dir: string): Promise<void> {
  const sep = dir.includes('\\') ? '\\' : '/';
  const raw = await Promise.all(FILES.map(async f => gunzip(await readBinaryFile(`${dir}${sep}${f}.dat.gz`))));
  const b = Object.fromEntries(FILES.map((f, i) => [f, raw[i]]));
  const dic = new DynamicDictionaries();
  dic.loadTrie(new Int32Array(b.base), new Int32Array(b.check));
  dic.loadTokenInfoDictionaries(new Uint8Array(b.tid), new Uint8Array(b.tid_pos), new Uint8Array(b.tid_map));
  dic.loadConnectionCosts(new Int16Array(b.cc));
  dic.loadUnknownDictionaries(new Uint8Array(b.unk), new Uint8Array(b.unk_pos), new Uint8Array(b.unk_map),
    new Uint8Array(b.unk_char), new Uint32Array(b.unk_compat), new Uint8Array(b.unk_invoke));
  tokenizer = new Tokenizer(dic);
}

// Loads the dictionary if it is on disk. false = not downloaded, or unreadable
// (then lines stay one box each and the practice page offers to download again).
export function loadJa(): Promise<boolean> {
  if (tokenizer) return Promise.resolve(true);
  loading ??= (async () => {
    try {
      const st = await jaDictStatus();
      setState({ installed: st.installed });
      if (!st.installed) return false;
      await build(st.dir);
      setState({ ready: true, failed: false });
      bump();
      return true;
    } catch (e) {
      console.error('Japanese dictionary failed to load:', e);
      setState({ failed: true });
      return false;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

// --- Download, shared by the settings row and the practice-page banner ---

let installing: Promise<boolean> | null = null;

export function downloadJa(): Promise<boolean> {
  installing ??= (async () => {
    setState({ running: true, pct: 0, failed: false });
    const off = await onJaDictProgress(pct => setState({ pct })).catch(() => () => {});
    try {
      await installJaDict();
      return await loadJa();
    } catch (e) {
      console.error('Japanese dictionary download failed:', e);
      setState({ failed: true });
      return false;
    } finally {
      off();
      setState({ running: false });
      installing = null;
    }
  })();
  return installing;
}

export async function deleteJa(): Promise<void> {
  await removeJaDict();
  tokenizer = null;
  setState({ installed: false, ready: false });
  bump();
}

// --- Splitting ---

export function setJaCuts(entries: Iterable<[string, number[]]>): void {
  let changed = false;
  for (const [text, starts] of entries) {
    if (cuts.get(text)?.join() !== starts.join()) { cuts.set(text, starts); changed = true; }
  }
  if (changed) bump();
}

const isPunct = (m: { pos: string; s: string }) => m.pos === '記号' || /^[\s\p{P}\p{S}]+$/u.test(m.s);

export function jaMorphs(text: string): Morph[] | null {
  if (!tokenizer) return null;
  let at = 0;
  const out = tokenizer.tokenize(text).map(t => {
    const m = {
      s: t.surface_form as string,
      at,
      pos: t.pos as string,
      d1: t.pos_detail_1 as string,
      base: t.basic_form && t.basic_form !== '*' ? t.basic_form as string : t.surface_form as string,
      reading: t.reading && t.reading !== '*' ? t.reading as string : undefined,
      punct: isPunct({ pos: t.pos, s: t.surface_form }),
    };
    at += m.s.length;
    return m;
  });
  // Offsets are only good if the pieces add back up to the line.
  return out.map(m => m.s).join('') === text ? out : null;
}

const KATAKANA = /^[\p{Script=Katakana}ー]+$/u;

// Particles, auxiliaries, suffixes and dependent words ride on the word before;
// the word after a prefix (お茶) rides on the prefix; katakana nouns in a row
// are one loanword (スマート + フォン).
const sticks = (m: Morph, prev: Morph) =>
  m.pos === '助詞' || m.pos === '助動詞' || m.d1 === '接尾' || m.d1 === '非自立' || prev.pos === '接頭詞' ||
  (m.pos === '名詞' && prev.pos === '名詞' && KATAKANA.test(m.s) && KATAKANA.test(prev.s));

// Word morphs only (punctuation left out): the list the AI numbers.
export const jaWordMorphs = (text: string) => jaMorphs(text)?.filter(m => !m.punct) ?? null;

// Char offset of each group's first morph, by the default rule; a set phrase
// (jaPhrases.ts) that starts and ends on morph edges is one group of its own.
export function defaultStarts(all: Morph[]): number[] {
  const out = new Set<number>();
  all.forEach((m, i) => {
    const prev = all[i - 1];
    if (!m.punct && (!prev || prev.punct || !sticks(m, prev))) out.add(m.at);
  });
  const text = all.map(m => m.s).join('');
  const edges = new Set([...all.map(m => m.at), text.length]);
  const taken: [number, number][] = [];
  for (const p of JA_PHRASE_LIST) {
    for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + 1)) {
      const end = at + p.length;
      if (!edges.has(at) || !edges.has(end) || taken.some(([a, b]) => at < b && end > a)) continue;
      taken.push([at, end]);
      for (const x of out) if (x > at && x < end) out.delete(x);
      out.add(at);
    }
  }
  return [...out].sort((a, b) => a - b);
}

export function jaGroups(text: string): JaGroup[] | null {
  const all = jaMorphs(text);
  if (!all) return null;
  const starts = new Set(cuts.get(text) ?? defaultStarts(all));
  const out: JaGroup[] = [];
  let open: JaGroup | null = null;
  for (const m of all) {
    if (m.punct) { out.push({ value: m.s, punct: true }); open = null; continue; }
    const reading = m.reading ?? m.s;
    if (open && !starts.has(m.at)) {
      open.value += m.s;
      open.reading += reading;
    } else {
      open = { value: m.s, reading, punct: false };
      out.push(open);
    }
  }
  return out;
}

// Kana typed for a kanji word counts: compare in hiragana, full-width folded.
export const kanaFold = (s: string) =>
  s.normalize('NFKC').trim().toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// What a clicked group is looked up as: its word in dictionary form, particles
// and endings dropped (食べました → 食べる, お茶を → お茶); a set phrase as
// Youdao spells it. Unchanged when the splitting dictionary is not loaded.
export function jaLemma(text: string): string {
  const bare = text.replace(/^[\s\p{P}\p{S}]+/u, '');
  const phrase = JA_PHRASE_LIST.find(p => bare.startsWith(p));
  if (phrase) return JA_PHRASES[phrase];
  const head: Morph[] = [];
  for (const m of jaMorphs(text) ?? []) {
    if (m.punct) continue;
    if (head.length && (m.pos === '助詞' || m.pos === '助動詞' || m.d1 === '非自立')) break;
    head.push(m);
  }
  if (head.length === 0) return JA_SPELLING[bare] ?? text;
  // ipadic reads くださ(る) as くだす.
  const last = head[head.length - 1];
  const lemma = head.slice(0, -1).map(m => m.s).join('') + (last.s.startsWith('くださ') ? '下さる' : last.base);
  return JA_SPELLING[lemma] ?? lemma;
}

// --- Furigana: which kana sit over which kanji ---

export type Ruby = { s: string; rt?: string };
const KANJI = /[\p{Script=Han}々〆ヶ]/u;
export const hasKanji = (s: string) => KANJI.test(s);
const toHira = (s: string) => s.replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 諦める + あきらめる → 諦(あきら) める: kana in the word are matched literally, each
// kanji run takes what is between. No clean fit: the whole word carries the reading.
export function furigana(surface: string, reading?: string): Ruby[] {
  if (!reading || !hasKanji(surface)) return [{ s: surface }];
  const runs = surface.match(/[\p{Script=Han}々〆ヶ]+|[^\p{Script=Han}々〆ヶ]+/gu) ?? [surface];
  const esc = (s: string) => toHira(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^${runs.map(r => hasKanji(r) ? '(.+?)' : esc(r)).join('')}$`, 'u').exec(toHira(reading));
  if (!m) return toHira(reading) === toHira(surface) ? [{ s: surface }] : [{ s: surface, rt: toHira(reading) }];
  let k = 1;
  return runs.map(r => {
    if (!hasKanji(r)) return { s: r };
    const rt = m[k++];
    return rt === r ? { s: r } : { s: r, rt };
  });
}

// A word's reading in hiragana, or undefined without the dictionary.
export const readingOf = (text: string): string | undefined => {
  const ms = jaMorphs(text);
  return ms ? toHira(ms.map(m => m.reading ?? m.s).join('')) : undefined;
};
