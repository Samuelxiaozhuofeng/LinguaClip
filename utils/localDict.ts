import { useSyncExternalStore } from 'react';
import type { DictEntry, DictLang } from './dictionary';
import { dictCheck, dictDownload, dictImport, dictList, dictLookup, dictMove, dictRemove, dictUpdate, onDictProgress, pickDictZip, type LocalDict } from './desktop';
import { downloadJa, jaLemma, loadJa } from './japanese';
import { candidates, lemmasToFollow, toEntries, type Hits, type Row } from './yomitanContent';
import { dialog } from '../components/Dialog';
import { t } from './i18n';

// Local dictionaries (docs/yomitan.md): the list the settings page shows and the
// lookups use (one copy, here), import / download jobs, and the lookup itself.
// The files and their settings live on the Rust side (src-tauri/src/dicts.rs).

export type { LocalDict };
export type LocalState = {
  list: LocalDict[];
  job: { stage: 'download' | 'import'; pct: number; title: string } | null;
  error: string | null; // an error code from Rust, shown until the next job
  fresh: string | null; // id of the book just added whose language we could not tell
};
let state: LocalState = { list: [], job: null, error: null, fresh: null };
const listeners = new Set<() => void>();
const set = (next: Partial<LocalState>) => { state = { ...state, ...next }; listeners.forEach(f => f()); };
export const subscribeLocal = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const useLocalDicts = () => useSyncExternalStore(subscribeLocal, () => state);

// Read once, and again whenever the settings page opens. A read that fails or
// hangs counts as "no local dictionaries" after 3s, so it can never hold up a
// lookup for people who have none.
let loaded: Promise<void> | null = null;
export function loadLocalDicts(): Promise<void> {
  const read = dictList().then(list => set({ list })).catch(e => console.warn('Local dictionaries unreadable:', e));
  loaded = Promise.race([read, new Promise<void>(r => setTimeout(r, 3000))]);
  return loaded;
}
export const localDictsReady = () => loaded ?? loadLocalDicts();

export const usable = (d: LocalDict) => d.enabled && !d.broken && !d.needsReimport && !!d.lang;
export const localDictsFor = (lang: DictLang) => state.list.filter(d => usable(d) && d.lang === lang);
// "JMdict [2026-09-29]" → "JMdict", as the popup's source label (only a
// release date goes, as in dicts_import.rs base_title).
export const dictLabel = (title: string) => title.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, '');

// --- Recommended dictionaries: one tap downloads and imports ---

export interface Recommended { lang: DictLang; title: string; gloss: 'zh' | 'en'; mb: number; urls: string[] }
// wty is on Hugging Face (blocked in mainland China → hf-mirror.com, same path).
const wty = (src: DictLang, tgt: 'zh' | 'en', mb: number): Recommended => {
  const path = `datasets/daxida/wty-release/resolve/main/latest/dict/${src}/${tgt}/wty-${src}-${tgt}.zip`;
  return { lang: src, title: `wty-${src}-${tgt}`, gloss: tgt, mb, urls: [`https://huggingface.co/${path}`, `https://hf-mirror.com/${path}`] };
};
const RECOMMENDED: Recommended[] = [
  { lang: 'ja', title: 'Jitendex.org', gloss: 'en', mb: 38, urls: ['https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip'] },
  wty('ja', 'zh', 7),
  wty('es', 'zh', 3), wty('es', 'en', 22),
  wty('fr', 'zh', 3), wty('fr', 'en', 11),
  wty('de', 'zh', 6), wty('de', 'en', 17),
  wty('en', 'zh', 5), wty('en', 'en', 108),
];
// An English interface lists English definitions only; a Chinese one lists both
// (user's call, 2026-09-30), Chinese first.
export const recommendedFor = (ui: 'zh' | 'en', lang: DictLang) =>
  RECOMMENDED.filter(r => r.lang === lang && (ui === 'zh' || r.gloss === 'en')).sort((a, b) => (a.gloss === 'zh' ? -1 : 0) - (b.gloss === 'zh' ? -1 : 0));
// Downloaded from here, or the same book imported by hand (its name, dated or not).
export const isInstalled = (r: Recommended, list = state.list) =>
  list.some(d => d.downloadUrl === r.urls[0] || (!d.broken && dictLabel(d.title) === r.title));

// --- Jobs (one at a time on the Rust side; a second one gets "busy") ---

async function run(title: string, stage: 'download' | 'import', work: () => Promise<LocalDict[]>): Promise<void> {
  set({ job: { stage, pct: 0, title }, error: null });
  const off = await onDictProgress(p => set({ job: { ...p, title } })).catch(() => () => {});
  const before = new Set(state.list.map(d => d.id));
  try {
    const list = await work();
    const added = list.find(d => !before.has(d.id));
    set({ list, fresh: added && !added.lang ? added.id : state.fresh });
  } catch (e) {
    set({ error: String(e) });
  } finally {
    off();
    set({ job: null });
  }
}

// Pick a zip, ask before replacing an older version of the same book, import it.
export async function importDictFile(): Promise<void> {
  const path = await pickDictZip();
  if (!path) return;
  let check;
  try {
    check = await dictCheck(path);
  } catch (e) {
    return set({ error: String(e) });
  }
  let replace: string | undefined;
  if (check.same) {
    if (check.same.revision === check.revision) {
      await dialog.alert(t('localDict.already', { title: dictLabel(check.title) }));
      return;
    }
    const ok = await dialog.confirm(t('localDict.replaceTitle', { title: dictLabel(check.title) }),
      t('localDict.replaceBody', { old: check.same.revision, next: check.revision }), { ok: t('localDict.replace') });
    if (ok !== true) return; // Esc / click outside = keep the old one
    replace = check.same.id;
  }
  await run(dictLabel(check.title), 'import', () => dictImport(path, replace));
}

export async function downloadDict(r: Recommended): Promise<void> {
  // Japanese forms are taken back to their dictionary form by the word splitter.
  if (r.lang === 'ja' && !(await loadJa())) downloadJa();
  await run(r.title, 'download', () => dictDownload(r.urls));
}

const edit = async (work: () => Promise<LocalDict[]>) => {
  try { set({ list: await work(), error: null }); } catch (e) { set({ error: String(e) }); }
};
export const setDictEnabled = (id: string, enabled: boolean) => edit(() => dictUpdate(id, { enabled }));
export const setDictLang = (id: string, lang: DictLang) => { if (state.fresh === id) set({ fresh: null }); return edit(() => dictUpdate(id, { lang })); };
export const moveDict = (id: string, step: -1 | 1) => edit(() => dictMove(id, step));
export async function removeDict(d: LocalDict): Promise<void> {
  const ok = await dialog.confirm(t('localDict.removeTitle', { title: dictLabel(d.title) }), undefined, { ok: t('localDict.remove'), danger: true });
  if (ok === true) await edit(() => dictRemove(d.id));
}

// --- Lookup ---

// Entries for a clicked word from this language's local dictionaries, in their
// order; null = none of them has it. A form (llegué) shows its lemma's entry
// with how it is formed underneath.
export async function lookupLocal(word: string, lang: DictLang): Promise<DictEntry[] | null> {
  await localDictsReady();
  const dicts = localDictsFor(lang);
  if (!dicts.length) return null;
  const ids = dicts.map(d => d.id);
  const [first, second] = candidates(word, lang, lang === 'ja' ? jaLemma(word) : undefined);
  let keys = first;
  let hits = await dictLookup<Hits>(ids, keys);
  if (!hits.length && second.length) {
    hits = await dictLookup<Hits>(ids, second);
    // Japanese: only the longest shortening that is a word.
    const best = lang === 'ja' ? second.find(c => hits.some(h => h.rows.some(r => r[0] === c || r[1] === c))) : undefined;
    keys = best ? [best] : second;
    if (best) hits = hits.map(h => ({ ...h, rows: h.rows.filter(r => r[0] === best || r[1] === best) })).filter(h => h.rows.length);
  }
  if (!hits.length) return null;

  const lemmas = new Map<string, { lemma: string; note: string }[]>();
  for (const h of hits) lemmas.set(h.id, lemmasToFollow(h.rows, word));
  const wanted = [...new Set([...lemmas.values()].flat().map(l => l.lemma))];
  const lemmaHits = wanted.length ? await dictLookup<Hits>(ids, wanted) : [];

  // Nearer candidates first (as clicked > lowercase > …), then the dictionary's
  // own score (JMdict ranks common words higher), then file order.
  const rank = (r: Row) => { const i = keys.findIndex(k => k === r[0] || k === r[1]); return i < 0 ? keys.length : i; };
  const out: DictEntry[] = [];
  for (const d of dicts) {
    const name = dictLabel(d.title);
    const own = hits.find(h => h.id === d.id);
    if (own) {
      const rows = own.rows.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || (b.r[4] ?? 0) - (a.r[4] ?? 0) || a.i - b.i).map(x => x.r);
      out.push(...toEntries(rows, own.tags, name));
    }
    const lh = lemmaHits.find(h => h.id === d.id);
    for (const l of lemmas.get(d.id) ?? []) {
      if (lh) out.push(...toEntries(lh.rows.filter(r => r[0] === l.lemma), lh.tags, name, l.note));
    }
  }
  return out.length ? out : null;
}
