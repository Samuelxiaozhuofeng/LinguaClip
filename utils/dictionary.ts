import { fetch } from '@tauri-apps/plugin-http';
import { getLang, type Lang } from './i18n';
import { parseJisho, parseWiktionary } from './dictionaryEn';
import { localDictsFor, localDictsReady, lookupLocal } from './localDict';

// Dictionary lookup without AI, after ODH (github.com/ninja33/ODH, MIT): the
// same public dictionary pages it reads, fetched through the http plugin (no
// CORS in the shell). Youdao has a JSON endpoint; Cambridge and Eudic are HTML
// and parsed here. None of these is an official API — a site redesign breaks
// its parser, and the caller falls back to AI when it can.

export type DictLang = 'en' | 'es' | 'fr' | 'de' | 'ja';
// cambridge = English-Chinese, cambridgeEn = English-English, cambridgeBi =
// Spanish / French / German-English. The English ones: docs/dictionary.md.
// local = the user's own imported dictionaries (docs/yomitan.md).
export type DictSource = 'youdao' | 'cambridge' | 'eudic' | 'cambridgeEn' | 'cambridgeBi' | 'wiktionary' | 'jisho' | 'local';

// Eudic draws some Chinese characters as tiny images (anti-scraping), so a
// definition is text interleaved with those glyph images. Local dictionaries
// keep a word's reading over it (ruby).
export type Seg = string | { img: string } | { ruby: string; rt: string };
// One numbered meaning: what the user picks and sends to Anki on its own.
// phrase = the set phrase it belongs to (Eudic, e.g. "llegar a ser").
export interface Sense { pos: string; phrase?: string; text: Seg[]; examples: Seg[][] }
// reading: the headword in kana (Japanese only). note: the clicked word is a
// form of this one ("first-person singular preterite of llegar"). dictName: which
// local dictionary it came from, shown as its source.
export interface DictEntry { word: string; phonetic: string; senses: Sense[]; source: DictSource; reading?: string; note?: string; dictName?: string }

// Which dictionaries each interface language lists; first option = the default.
// Youdao barely splits Spanish/French/German into meanings and has no examples
// there, so Eudic leads for those. An English interface lists only English ones.
const OPTIONS: Record<Lang, Record<DictLang, DictSource[]>> = {
  zh: {
    en: ['youdao', 'cambridge', 'cambridgeEn', 'wiktionary'],
    es: ['eudic', 'youdao', 'wiktionary', 'cambridgeBi'],
    fr: ['eudic', 'youdao', 'wiktionary', 'cambridgeBi'],
    de: ['eudic', 'youdao', 'wiktionary', 'cambridgeBi'],
    ja: ['youdao', 'wiktionary', 'jisho'],
  },
  en: {
    en: ['cambridgeEn', 'wiktionary'],
    es: ['wiktionary', 'cambridgeBi'],
    fr: ['wiktionary', 'cambridgeBi'],
    de: ['wiktionary', 'cambridgeBi'],
    ja: ['wiktionary', 'jisho'],
  },
};

export const dictOptions = (ui: Lang = getLang()): Record<DictLang, DictSource[]> => OPTIONS[ui];

// Online / local on or off and which goes first (docs/dictionary.md「查词顺序与开关」):
// one copy for both interface languages. Unset or unreadable = on, on, local
// first only in an English interface — the behaviour before these switches.
export interface DictSources { online: boolean; local: boolean; localFirst: boolean }
const SOURCES_KEY = 'linguaclip_dict_sources';
const readObj = (key: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
};
const storedSources = () => readObj(SOURCES_KEY) as Partial<DictSources>;
export const getDictSources = (ui: Lang = getLang()): DictSources => {
  const v = storedSources();
  return { online: v.online !== false, local: v.local !== false, localFirst: typeof v.localFirst === 'boolean' ? v.localFirst : ui === 'en' };
};
export const saveDictSources = (patch: Partial<DictSources>) => {
  try { localStorage.setItem(SOURCES_KEY, JSON.stringify({ ...storedSources(), ...patch })); } catch { /* private mode: stays default */ }
};
// Why a click on a word in this language has no dictionary to go to: 'all' =
// online and local both off, 'noLocal' = only local is on and none covers it.
export const dictsOff = async (lang: DictLang): Promise<'all' | 'noLocal' | null> => {
  const { online, local } = getDictSources();
  if (online) return null;
  await localDictsReady();
  if (!local) return 'all';
  return localDictsFor(lang).length ? null : 'noLocal';
};

// Each interface language keeps its own choice, so switching back restores it.
// The Chinese one stays in the key older versions read.
const storageKey = (ui: Lang) => (ui === 'zh' ? 'linguaclip_dict_choice' : 'linguaclip_dict_choice_en');

const storedChoice = (ui: Lang) => readObj(storageKey(ui));

export const getDictChoice = (ui: Lang = getLang()): Record<DictLang, DictSource> => {
  const stored = storedChoice(ui);
  const options = dictOptions(ui);
  const pick = {} as Record<DictLang, DictSource>;
  for (const lang of Object.keys(options) as DictLang[]) {
    const v = stored[lang] as DictSource;
    pick[lang] = options[lang].includes(v) ? v : options[lang][0];
  }
  return pick;
};

// Only the language the user touched is stored, so the others keep following
// the default.
export const saveDictChoice = (lang: DictLang, source: DictSource, ui: Lang = getLang()) => {
  localStorage.setItem(storageKey(ui), JSON.stringify({ ...storedChoice(ui), [lang]: source }));
};

// One word says little about its language (parler is also an English
// headword), so the whole subtitle file votes with its function words.
const STOPWORDS: Record<Exclude<DictLang, 'ja'>, string[]> = {
  en: ['the', 'and', 'is', 'you', 'to', 'of', 'it', 'that', 'what', 'this', 'have', 'with', 'are', 'was', 'i', 'my', "it's", "don't"],
  es: ['el', 'la', 'que', 'y', 'los', 'las', 'es', 'por', 'se', 'una', 'con', 'para', 'lo', 'qué', 'está', 'pero', 'yo', 'muy'],
  fr: ['le', 'la', 'les', 'et', 'est', 'que', 'je', 'vous', 'pas', 'une', 'des', 'du', 'il', 'ce', 'qui', "c'est", 'ne', 'mais'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'zu', 'ein', 'eine', 'sie', 'es', 'mit', 'den', 'dem', 'auf', 'wir', 'du'],
};

// null = a language with no dictionary here (Chinese, …). Japanese is told by
// its kana, which Chinese never has.
export const detectLang = (texts: string[]): DictLang | null => {
  const letters = texts.join('').match(/\p{L}/gu)?.length ?? 0;
  const kana = texts.join('').match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (kana >= 5 && kana / letters >= 0.2) return 'ja';
  const words = texts.join(' ').toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return null;
  const latin = words.filter(w => /^[\p{Script=Latin}']+$/u.test(w)).length;
  if (latin / words.length < 0.8) return null;
  let best: DictLang | null = null;
  let bestScore = 0;
  for (const lang of Object.keys(STOPWORDS) as (keyof typeof STOPWORDS)[]) {
    const set = new Set(STOPWORDS[lang]);
    const score = words.filter(w => set.has(w)).length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  // ponytail: a few subtitle lines can tie or barely score; fine for whole files.
  return bestScore >= 3 ? best : null;
};

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

type YdTr = { l?: { i?: string[] | string } };
type YdWord = { phone?: string; usphone?: string; ukphone?: string; 'return-phrase'?: string | { l?: { i?: string } }; trs?: { pos?: string; tran?: string; tr?: YdTr[] }[] };
type YdCollins = { headword?: string; entries?: { entry?: { tran_entry?: { pos_entry?: { pos?: string }; tran?: string; exam_sents?: { sent?: { eng_sent?: string; chn_sent?: string }[] } }[] }[] } };

const CJK = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
const stripTags = (s: string) => clean(s.replace(/<[^>]+>/g, ''));

// Collins EN-CN inside the Youdao JSON: one meaning per entry, English
// explanation then its Chinese, with examples.
const collinsSenses = (list: YdCollins[] | undefined): Sense[] =>
  (list ?? []).flatMap(c => c.entries?.entry ?? []).flatMap(x => x.tran_entry ?? []).flatMap(t => {
    const tran = stripTags(t.tran ?? '');
    if (!tran) return [];
    const i = tran.search(CJK);
    const en = i < 0 ? tran : tran.slice(0, i).trim();
    const zh = i < 0 ? '' : tran.slice(i).trim();
    const examples = (t.exam_sents?.sent ?? [])
      .filter(e => e.eng_sent)
      .map(e => [clean(e.eng_sent) + (e.chn_sent ? `\n${clean(e.chn_sent)}` : '')]);
    return [{ pos: clean(t.pos_entry?.pos), text: [zh ? `${en}\n${zh}` : en], examples }];
  });

// Youdao's jsonapi_s: `ec` for English (Collins preferred unless it is a lone
// example-less stub like "past tense of go"), `fc` for French, `multle` for the rest.
export const parseYoudao = (body: any, word: string): DictEntry | null => {
  const w: YdWord | undefined = body?.ec?.word ?? body?.fc?.word?.[0] ?? body?.multle?.word?.[0];
  const collins = collinsSenses(body?.collins?.collins_entries);
  const useCollins = collins.length >= 2 || collins.some(s => s.examples.length > 0);
  const senses: Sense[] = useCollins ? collins : (w?.trs ?? [])
    .map(t => ({
      pos: clean(t.pos),
      text: clean(t.tran ?? (t.tr ?? []).flatMap(x => x.l?.i ?? []).join('；')),
    }))
    .filter(s => s.text && !/cop\s?yright/i.test(s.text))
    .map(s => ({ pos: s.pos, text: [s.text], examples: [] }));
  if (senses.length === 0) return null;
  const rp = w?.['return-phrase'];
  const phonetic = w?.usphone || w?.ukphone || w?.phone || '';
  const headword = useCollins ? body.collins.collins_entries[0]?.headword : undefined;
  return {
    word: headword || (typeof rp === 'string' ? rp : rp?.l?.i) || word,
    phonetic: phonetic ? `/${phonetic}/` : '',
    senses,
    source: 'youdao',
  };
};

type YdJaPhr = { jmsy?: string; jmsyT?: string; lj?: string[]; ljT?: string[] };
type YdJaWord = { head?: { hw?: string; pjm?: string; tone?: string }; sense?: { cx?: string; phrList?: YdJaPhr[] }[]; homonymD?: YdJaWord[] };

const jaEntry = (w: YdJaWord): DictEntry | null => {
  const senses: Sense[] = (w.sense ?? []).flatMap(s => (s.phrList ?? []).flatMap(p => {
    const zh = stripTags(p.jmsy ?? '');
    if (!zh) return [];
    const ja = stripTags(p.jmsyT ?? '');
    const examples = (p.lj ?? []).map((l, i) => [[stripTags(l), stripTags(p.ljT?.[i] ?? '')].filter(Boolean).join('\n')]).filter(e => e[0]);
    return [{ pos: clean(s.cx), text: [ja ? `${zh}\n${ja}` : zh], examples }];
  }));
  if (senses.length === 0) return null;
  const { hw = '', pjm = '', tone = '' } = w.head ?? {};
  return { word: clean(hw), phonetic: clean(`${pjm !== hw ? pjm : ''} ${tone}`), senses, source: 'youdao', reading: clean(pjm || hw) };
};

// Youdao's Japanese-Chinese (`newjc`). A kana query lists its kanji spellings
// in homonymD after its own entry, which leads: する is 干，做 before 擦る.
export const parseYoudaoJa = (body: any): DictEntry[] | null => {
  const w: YdJaWord | undefined = body?.newjc?.word;
  if (!w) return null;
  const found = [w, ...(w.homonymD ?? [])].map(jaEntry).filter((e): e is DictEntry => !!e);
  return found.length ? found : null;
};

const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');

// English-Chinese and English-English pages hold entries in .entry-body__el; the
// Spanish / French / German-English ones in .pr.di, where the English is the
// translation (.trans) and leads, above the definition in the language itself.
// Those two pages stack several dictionaries (learner's, American, business…):
// only the first is read.
export const parseCambridge = (html: string, word: string, source: DictSource = 'cambridge'): DictEntry | null => {
  const doc = parseHtml(html);
  const bi = source === 'cambridgeBi';
  const scope = source === 'cambridge' ? doc : doc.querySelector('.pr.dictionary') ?? doc;
  const entries = [...scope.querySelectorAll(bi ? '.pr.di' : '.pr .entry-body__el')];
  const senses: Sense[] = [];
  for (const entry of entries) {
    const pos = clean(entry.querySelector('.posgram, .dpos-g')?.textContent);
    for (const block of entry.querySelectorAll('.def-block')) {
      const en = clean(block.querySelector('.ddef_h .def')?.textContent).replace(/:$/, '');
      const zh = clean(block.querySelector('.def-body > .trans')?.textContent);
      const examples = [...block.querySelectorAll('.def-body .examp')].map(x => {
        const eg = clean(x.querySelector('.eg')?.textContent);
        const tr = clean(x.querySelector('.trans')?.textContent);
        return [tr ? `${eg}\n${tr}` : eg];
      }).filter(x => x[0]);
      if (bi ? zh : en) senses.push({ pos, text: [bi ? (en ? `${zh}\n${en}` : zh) : zh ? `${en}\n${zh}` : en], examples });
    }
  }
  if (senses.length === 0) return null;
  const first = entries[0];
  const ipa = clean(first?.querySelector('.us .ipa')?.textContent || first?.querySelector('.ipa')?.textContent);
  return { word: clean(first?.querySelector('.headword, .dhw')?.textContent) || word, phonetic: ipa ? `/${ipa}/` : '', senses, source };
};

const EUDIC_HOST: Record<Exclude<DictLang, 'en' | 'ja'>, string> = {
  es: 'https://www.esdict.cn',
  fr: 'https://www.frdic.com',
  de: 'https://www.godic.net',
};
const GLYPH = /^https:\/\/www\.(esdict\.cn|frdic\.com|godic\.net)\/tmp\/wordimg\/[\w@=.-]+$/;

type EudicTerm = { value?: string; recordid?: string | null; recordtype?: string | null; iscghint?: boolean };

// The prefix list mixes the word itself, its lemma (for a conjugated form) and
// unrelated completions; keep only the first two kinds.
export const pickEudicTerms = (terms: EudicTerm[], word: string): EudicTerm[] => {
  const lower = word.toLowerCase();
  const exact = terms.filter(t => t.recordid && t.recordtype !== 'CG' && t.value?.toLowerCase() === lower);
  const lemma = terms.filter(t => t.recordid && t.recordtype === 'Dict' && t.iscghint);
  return [...exact, ...lemma].filter((t, i, all) => all.findIndex(x => x.recordid === t.recordid) === i).slice(0, 2);
};

// Text plus glyph images, in order; <br> becomes a line break. Descendants
// matching `skip` (examples nested in a meaning) are left to their own pass.
const segs = (node: Node, skip?: string): Seg[] => {
  const out: Seg[] = [];
  const walk = (n: Node) => {
    if (skip && n !== node && n instanceof Element && n.matches(skip)) return;
    if (n.nodeType === Node.TEXT_NODE) out.push(n.textContent ?? '');
    else if (n instanceof Element && n.tagName === 'BR') out.push('\n');
    else if (n instanceof Element && n.tagName === 'IMG') {
      const src = n.getAttribute('src') ?? '';
      if (GLYPH.test(src)) out.push({ img: src });
    } else n.childNodes.forEach(walk);
  };
  walk(node);
  // Trim the run's ends; inner whitespace collapsed per text piece.
  const merged = out
    .map(s => (typeof s === 'string' && s !== '\n' ? s.replace(/\s+/g, ' ') : s))
    .filter((s, i, all) => !(s === '\n' && all[i - 1] === '\n'));
  while (typeof merged[0] === 'string' && !(merged[0] as string).trim()) merged.shift();
  while (typeof merged[merged.length - 1] === 'string' && !(merged[merged.length - 1] as string).trim()) merged.pop();
  return merged;
};

const lineText = (line: Seg[]) => line.map(p => (typeof p === 'string' ? p : 'ruby' in p ? p.ruby : '□')).join('');
const hasCjk = (line: Seg[]) => line.some(p => typeof p !== 'string' || CJK.test(p));

// Seg run -> lines, split at <br>.
const splitLines = (run: Seg[]): Seg[][] => {
  const lines: Seg[][] = [[]];
  for (const p of run) {
    if (p === '\n') lines.push([]);
    else lines[lines.length - 1].push(p);
  }
  return lines
    .map(l => l.map((p, i) => (typeof p !== 'string' ? p : i === 0 ? p.trimStart() : i === l.length - 1 ? p.trimEnd() : p)))
    .filter(l => lineText(l).trim());
};

// "1. 移近. <br>2. 聚拢" is two meanings; an unnumbered line continues the last.
const NUMBERED = /^\s*(\d+\s*\.|[①-⑳]|[⑴-⒇])/;
const groupSenses = (lines: Seg[][]): Seg[][] => {
  const groups: Seg[][] = [];
  for (const line of lines) {
    if (groups.length === 0 || NUMBERED.test(lineText(line))) groups.push([...line]);
    else groups[groups.length - 1].push('\n', ...line);
  }
  return groups;
};

// "~" stands for the headword in Eudic's phrases and examples.
const tilde = (line: Seg[], word: string): Seg[] =>
  line.map(p => (typeof p === 'string' && word ? p.replace(/~/g, word) : p));

export const parseEudic = (html: string): DictEntry | null => {
  const doc = parseHtml(html);
  const body = doc.querySelector('#ExpFCchild');
  if (!body) return null;
  const head = doc.querySelector('#exp-head');
  const word = clean(head?.querySelector('.word')?.textContent);
  // Links (the conjugation hint) and the invisible watermark span go.
  body.querySelectorAll('script, a, [style]').forEach(n => n.remove());
  const senses: Sense[] = [];
  let pos = '';
  let phrase = '';
  for (const el of body.querySelectorAll('.cara, .exp, .eg, [id="phrase"]')) {
    if (el.classList.contains('cara')) { pos = clean(el.textContent); phrase = ''; }
    else if (el.id === 'phrase') phrase = clean(el.textContent).replace(/~/g, word);
    else if (el.classList.contains('exp')) {
      for (const text of groupSenses(splitLines(segs(el, '.exp, .eg')))) {
        // A set phrase is listed after the last part of speech but is not one.
        senses.push(phrase ? { pos: '', phrase, text, examples: [] } : { pos, text, examples: [] });
      }
      // A phrase holds until the next phrase or part of speech: it can have
      // several numbered meanings, each its own .exp.
    } else {
      const last = senses[senses.length - 1];
      if (!last) continue;
      for (const line of splitLines(segs(el)).map(l => tilde(l, word))) {
        // German gives the sentence and its Chinese as two .eg; rejoin them.
        const prev = last.examples[last.examples.length - 1];
        if (prev && !hasCjk(prev) && hasCjk(line)) prev.push('\n', ...line);
        else last.examples.push(line);
      }
    }
  }
  // Some entries (many German nouns) are one run of text with no .exp.
  if (senses.length === 0) {
    const cara = body.querySelector('.cara');
    pos = clean(cara?.textContent);
    cara?.remove();
    body.querySelectorAll('.eg').forEach(n => n.remove());
    const groups = groupSenses(splitLines(segs(body)));
    // An unnumbered first line before numbered ones is grammar ("..-er"), not a meaning.
    if (groups.length > 1 && !NUMBERED.test(lineText(groups[0]))) pos = clean(`${pos} ${lineText(groups.shift()!)}`);
    for (const text of groups) senses.push({ pos, text, examples: [] });
  }
  if (senses.length === 0) return null;
  return { word, phonetic: clean(head?.querySelector('.Phonitic')?.textContent), senses, source: 'eudic' };
};

// Origin '' drops the tauri://localhost Origin the http plugin adds by
// default (needs its unsafe-headers feature): Youdao answers that with 400.
// Wikimedia asks for a User-Agent that names the app; a 404 there = no such word.
// Cambridge's bot check sometimes holds a request open rather than refusing it,
// so it gets a shorter wait before the next dictionary takes over.
const get = async (url: string, ua = 'Mozilla/5.0', ms = 15_000): Promise<Response> => {
  const res = await fetch(url, { headers: { 'User-Agent': ua, Origin: '' }, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  return res;
};

const WIKI_UA = 'LinguaClip (https://linguaclipapp.com; support@linguaclipapp.com)';
const wiktionary = async (word: string, lang: DictLang) => {
  try {
    const body = await (await get(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`, WIKI_UA)).json();
    return parseWiktionary(body, word, lang);
  } catch (e) {
    if ((e as { status?: number }).status === 404) return null;
    throw e;
  }
};

// The clicked word's own meanings lead; a word that is only a form of others
// shows those (at most two: fue → ir, ser) with the grammar line as their note.
// Sentence-initial capitals (Llegué) are retried in lower case, but only when
// the page has nothing in this language: German Haus stays Haus.
const lookupWiktionary = async (word: string, lang: DictLang): Promise<DictEntry[] | null> => {
  let found = await wiktionary(word, lang);
  if (!found && word !== word.toLowerCase()) found = await wiktionary(word.toLowerCase(), lang);
  if (!found) return null;
  const out: DictEntry[] = found.entry ? [found.entry] : [];
  const forms = found.forms.filter((f, i, all) => all.findIndex(x => x.lemma === f.lemma) === i).slice(0, 2);
  for (const [i, lemma] of (await Promise.all(forms.map(f => wiktionary(f.lemma, lang).catch(() => null)))).entries()) {
    if (lemma?.entry) out.push({ ...lemma.entry, note: forms[i].note });
  }
  // Lemma pages unreachable or empty: the grammar lines are still worth showing.
  if (out.length === 0 && forms.length) out.push({ word, phonetic: '', source: 'wiktionary', senses: forms.map(f => ({ pos: '', text: [f.note], examples: [] })) });
  return out.length ? out : null;
};

const CAMBRIDGE_BI: Partial<Record<DictLang, string>> = { es: 'spanish-english', fr: 'french-english', de: 'german-english' };

const fromSource = async (source: DictSource, word: string, lang: DictLang): Promise<DictEntry[] | null> => {
  const q = encodeURIComponent(word);
  if (source === 'cambridge' || source === 'cambridgeEn' || (source === 'cambridgeBi' && CAMBRIDGE_BI[lang])) {
    const path = source === 'cambridge' ? 'english-chinese-simplified' : source === 'cambridgeEn' ? 'english' : CAMBRIDGE_BI[lang];
    const entry = parseCambridge(await (await get(`https://dictionary.cambridge.org/dictionary/${path}/${q}`, undefined, 8_000)).text(), word, source);
    return entry ? [entry] : null;
  }
  if (source === 'wiktionary') return lookupWiktionary(word, lang);
  if (source === 'jisho' && lang === 'ja') return parseJisho(await (await get(`https://jisho.org/api/v1/search/words?keyword=${q}`)).json(), word);
  if (source === 'eudic' && lang !== 'en' && lang !== 'ja') {
    const host = EUDIC_HOST[lang];
    const terms = pickEudicTerms(await (await get(`${host}/dicts/prefix/${q}`)).json(), word);
    const pages = await Promise.all(terms.map(async t =>
      parseEudic(await (await get(`${host}/dicts/${lang}/${encodeURIComponent(t.value!)}?recordid=${t.recordid}`)).text())));
    const found = pages.filter((p): p is DictEntry => !!p);
    return found.length ? found : null;
  }
  // The older endpoint, asked for newjc alone, keeps to Japanese; jsonapi_s
  // takes 高い or 皆さん for English and answers without newjc.
  if (lang === 'ja') return parseYoudaoJa(await (await get(`https://dict.youdao.com/jsonapi?le=jap&dicts=${encodeURIComponent('{"count":99,"dicts":[["newjc"]]}')}&q=${q}`)).json());
  const body = await (await get(`https://dict.youdao.com/jsonapi_s?doctype=json&jsonversion=4&le=${lang}&q=${q}`)).json();
  const entry = parseYoudao(body, word);
  return entry ? [entry] : null;
};

// null = the dictionary has no such word; throws when it cannot be reached.
// Online: Cambridge sits behind a bot check that turns requests away now and
// then, and Cambridge's Spanish-English has no conjugated forms, so they are
// tried in turn: the chosen one, then the interface's default, then the rest.
// One that cannot be reached hands over to the next. One that lacks the word
// hands over only if it is the chosen (non-default) one — what an online
// default lacks, the other online ones are not asked for. Local dictionaries
// (when on) come after online whatever online said, or before it with "local
// first". If nothing answers and something was unreachable, that error stands
// ("unreachable", not "no such word").
export const lookupWord = async (word: string, lang: DictLang): Promise<DictEntry[] | null> => {
  await localDictsReady();
  const ui = getLang();
  const { online, local, localFirst } = getDictSources(ui);
  const list = dictOptions(ui)[lang];
  const source = getDictChoice(ui)[lang];
  let failure: unknown = null;
  const fromOnline = async () => {
    if (!online) return null;
    for (const s of [...new Set([source, ...list])]) {
      try {
        const found = await fromSource(s, word, lang);
        if (found) return found;
        // A definite "no such word" from the online default ends online, and the answer is
        // "no such word" even after a failure.
        if (!(s === source && s !== list[0])) { failure = null; return null; }
      } catch (e) {
        console.warn(`Dictionary ${s} unreachable:`, e);
        failure ??= e;
      }
    }
    return null;
  };
  const fromLocal = () => (local ? lookupLocal(word, lang) : null);
  const found = localFirst ? (await fromLocal()) ?? (await fromOnline()) : (await fromOnline()) ?? (await fromLocal());
  if (found) return found;
  if (failure) throw failure;
  return null;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const segsToHtml = (line: Seg[]) =>
  line.map(p => (typeof p === 'string' ? esc(p).replace(/\n/g, '<br/>')
    : 'ruby' in p ? `<ruby>${esc(p.ruby)}<rt>${esc(p.rt)}</rt></ruby>` : `<img src="${p.img}">`)).join('');

// One meaning as Anki fields: the definition (headword, pos, set phrase and
// meaning) and its first two examples. Glyph images stay as <img>.
export const senseToAnki = (entry: DictEntry, sense: Sense): { definition: string; example: string } => {
  const head = `<b>${esc(entry.word)}</b>${entry.phonetic ? ` ${esc(entry.phonetic)}` : ''}`;
  const meaning = [
    sense.pos && `<i>${esc(sense.pos)}</i>`,
    sense.phrase && `<b>${esc(sense.phrase)}</b>`,
    segsToHtml(sense.text),
  ].filter(Boolean).join(' ');
  return {
    definition: `${head}<br/>${meaning}`,
    example: sense.examples.slice(0, 2).map(segsToHtml).join('<br/><br/>'),
  };
};

// Every meaning across the entries, numbered from 1, as plain text for the AI
// to pick from (glyph images read as □, so the first example helps it).
export const senseList = (entries: DictEntry[]): { entry: number; sense: number; line: string }[] => {
  const out: { entry: number; sense: number; line: string }[] = [];
  entries.forEach((e, entry) => e.senses.forEach((s, sense) => {
    const text = [e.word, s.pos, s.phrase, lineText(s.text).replace(/\n/g, ' ')].filter(Boolean).join(' | ');
    const eg = s.examples[0] ? ` e.g. ${lineText(s.examples[0]).split('\n')[0]}` : '';
    out.push({ entry, sense, line: `${out.length + 1}. ${text}${eg}` });
  }));
  return out;
};
