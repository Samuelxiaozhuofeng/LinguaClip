import type { DictEntry, DictLang, Seg, Sense } from './dictionary';

// Pure half of the local dictionaries (docs/yomitan.md): what to look up for a
// clicked word, and Yomitan term rows turned into our entries / meanings. Written
// from Yomitan's published dictionary format, not its code.

// [headword, reading, definition tags, rules, score, glossary[], sequence, term tags]
export type Row = [string, string, string | null, string, number, unknown[], number, string];
export type TagInfo = Record<string, [string | null, string | null]>; // name → [category, notes]
export interface Hits { id: string; rows: Row[]; tags: TagInfo }
type Node = { tag?: string; content?: unknown; data?: Record<string, string>; title?: string };

const ELIDED = /^(?:l|d|j|m|n|s|t|c|qu|jusqu|lorsqu|puisqu)'(?=\p{L})/iu;

// What to try for a clicked word, in two rounds (the second only when the first
// finds nothing). After Yomitan's text preprocessors, cut to our five languages:
// the word as clicked, then its case variants; French elision (l'homme → homme)
// only when the whole token is no headword, so aujourd'hui and c'est stay whole.
// No accent stripping: esta and está are different words. Japanese: the group
// and its dictionary form, then the group shortened from the end (longest
// first), which catches what the word splitter cut wrongly.
export function candidates(word: string, lang: DictLang, lemma?: string): [string[], string[]] {
  const w = word.trim().replace(/’/g, "'");
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  if (lang === 'ja') {
    const chars = [...w];
    const shorter = chars.slice(0, -1).map((_, i) => chars.slice(0, chars.length - 1 - i).join(''));
    return [uniq([word.trim(), lemma ?? '']), uniq(shorter)];
  }
  const cases = (s: string) => {
    const lower = s.toLowerCase();
    const cap = lower.charAt(0).toUpperCase() + lower.slice(1);
    const out = [s, lower, cap];
    if (lang === 'de') out.push(...out.map(x => x.replace(/ß/g, 'ss')), ...out.map(x => x.replace(/ss/g, 'ß')));
    return out;
  };
  const stripped = lang === 'fr' && ELIDED.test(w) ? w.replace(ELIDED, '') : '';
  return [uniq([word.trim(), ...cases(w)]), uniq(stripped ? cases(stripped) : [])];
}

// A row whose glossary is [lemma, [how]] pairs is a form of another word
// (llegué → llegar, "first-person singular indicative preterite").
// A row may list one lemma several times, a label each ([rite, [alt-of]],
// [rite, [informal]]): those are merged.
export const formsOf = (row: Row): { lemma: string; how: string[] }[] => {
  const by = new Map<string, string[]>();
  for (const g of row[5]) {
    if (!Array.isArray(g) || typeof g[0] !== 'string') continue;
    const how = Array.isArray(g[1]) ? g[1].filter((h: unknown): h is string => typeof h === 'string') : [];
    by.set(g[0], [...(by.get(g[0]) ?? []), ...how]);
  }
  return [...by].map(([lemma, how]) => ({ lemma, how }));
};
export const isFormRow = (row: Row) => formsOf(row).length > 0;

// wty marks a spelling variant (right → "rite", cool → "kool") with one of
// these among its labels; anything else points from a form to its lemma. Variants
// are skipped when the word has entries of its own.
const VARIANT = new Set(['alt-of', 'alternative', 'misspelling']);
const inflected = (how: string[]) => !how.some(h => VARIANT.has(h));

// The lemmas worth looking up for the clicked form, at most three, inflections first.
export function lemmasToFollow(rows: Row[], word: string): { lemma: string; note: string }[] {
  const own = rows.some(r => !isFormRow(r));
  const found = new Map<string, { how: string[]; inflection: boolean }>();
  for (const r of rows.filter(isFormRow)) {
    for (const f of formsOf(r)) {
      if (f.lemma === word || (own && !inflected(f.how))) continue;
      const seen = found.get(f.lemma) ?? { how: [], inflection: false };
      seen.how.push(...f.how.filter(h => !VARIANT.has(h)));
      seen.inflection ||= inflected(f.how);
      found.set(f.lemma, seen);
    }
  }
  return [...found.entries()]
    .sort((a, b) => Number(b[1].inflection) - Number(a[1].inflection))
    .slice(0, 3)
    .map(([lemma, v]) => ({ lemma, note: `${[...new Set(v.how)].slice(0, 2).join('; ') || 'form'} of ${lemma}` }));
}

// --- structured content → text ---

const BLOCK = new Set(['div', 'p', 'li', 'ol', 'ul', 'tr', 'table', 'details', 'summary', 'br']);
const isNode = (n: unknown): n is Node => !!n && typeof n === 'object' && !Array.isArray(n);
const kind = (n: Node) => (isNode(n) && n.data && typeof n.data.content === 'string' ? n.data.content : '');
const kids = (n: unknown): unknown[] => (Array.isArray(n) ? n : isNode(n) ? (Array.isArray(n.content) ? n.content : n.content == null ? [] : [n.content]) : []);

// Text of a tree as segments: blocks break lines, <ruby> keeps its reading,
// images and anything in `skip` are dropped. Never HTML: every string is text.
export function segs(n: unknown, skip: (n: Node) => boolean = () => false): Seg[] {
  const out: Seg[] = [];
  const push = (s: string) => {
    const last = out[out.length - 1];
    if (typeof last === 'string') out[out.length - 1] = last + s;
    else out.push(s);
  };
  const walk = (x: unknown) => {
    if (typeof x === 'string') return push(x);
    if (typeof x === 'number') return push(String(x));
    if (Array.isArray(x)) return x.forEach(walk);
    if (!isNode(x) || skip(x) || x.tag === 'img' || x.tag === 'rt' || x.tag === 'rp') return;
    if (x.tag === 'ruby') {
      const base = kids(x).filter(c => !(isNode(c) && (c.tag === 'rt' || c.tag === 'rp'))).map(c => plain(segs(c))).join('');
      const rt = kids(x).filter((c): c is Node => isNode(c) && c.tag === 'rt').map(c => plain(segs(c.content))).join('');
      if (rt) out.push({ ruby: base, rt }); else push(base);
      return;
    }
    const block = BLOCK.has(x.tag ?? '');
    if (block) push('\n');
    if (x.tag === 'td' || x.tag === 'th') push(' ');
    walk(x.content);
    if (block) push('\n');
  };
  walk(n);
  // Tidy the line breaks: none at the ends, never two in a row.
  const tidy = out.map(p => (typeof p === 'string' ? p.replace(/[ \t]*\n[\s]*/g, '\n') : p));
  if (typeof tidy[0] === 'string') tidy[0] = tidy[0].replace(/^\n+/, '');
  const end = tidy.length - 1;
  if (typeof tidy[end] === 'string') tidy[end] = (tidy[end] as string).replace(/\n+$/, '');
  return tidy.filter(p => p !== '');
}

export const plain = (line: Seg[]) => line.map(p => (typeof p === 'string' ? p : 'ruby' in p ? p.ruby : '')).join('');

const find = (n: unknown, test: (n: Node) => boolean, out: Node[] = [], stopAtHit = true): Node[] => {
  if (Array.isArray(n)) n.forEach(c => find(c, test, out, stopAtHit));
  else if (isNode(n)) {
    if (test(n)) { out.push(n); if (stopAtHit) return out; }
    find(n.content, test, out, stopAtHit);
  }
  return out;
};

// Example sentences: the original, and its translation on the next line.
function examplesIn(n: unknown): Seg[][] {
  return find(n, x => kind(x) === 'example-sentence').map(ex => {
    const a = find(ex, x => kind(x) === 'example-sentence-a').flatMap(x => segs(x));
    const b = find(ex, x => kind(x) === 'example-sentence-b').flatMap(x => segs(x, y => kind(y) === 'attribution-footnote'));
    return b.length ? [...a, '\n', ...b] : a;
  }).filter(e => plain(e).trim());
}

const NOT_MEANING = new Set(['preamble', 'backlink', 'extra-info', 'details-entry-examples', 'formsTable', 'references', 'refGlosses', 'sourceLanguages', 'antonyms', 'attribution-footnote', 'forms', 'xref']);
const meaningOnly = (x: Node) => NOT_MEANING.has(kind(x)) || x.tag === 'details';

// One glossary item → meanings, for the dictionaries we know the markings of:
// wty (a "glosses" list, one item a meaning), Jitendex ("sense" items),
// JMdict (a "glossary" list = one meaning, its items synonyms). Anything else
// becomes one meaning with the whole text, lines kept.
export function sensesOf(item: unknown, pos: string): Sense[] {
  if (typeof item === 'string') return item.trim() ? [{ pos, text: [item], examples: [] }] : [];
  if (!isNode(item) || (item as { type?: string }).type !== 'structured-content') return [];
  const tree = item.content;
  const lists = find(tree, x => kind(x) === 'glosses');
  if (lists.length) {
    // A meaning's own labels (vt, fig) join its part of speech, in full words.
    return lists.flatMap(l => kids(l).filter(isNode).filter(li => li.tag === 'li')).map(li => {
      const labels = find(li, x => kind(x) === 'tags').flatMap(tg => kids(tg).filter(isNode).map(x => x.title ?? plain(segs(x))));
      return {
        pos: [pos, ...labels].filter(Boolean).join(', '),
        text: segs(li, x => meaningOnly(x) || kind(x) === 'tags' || x.tag === 'ol' || x.tag === 'ul'),
        examples: examplesIn(li),
      };
    }).filter(s => plain(s.text).trim());
  }
  const senses = find(tree, x => kind(x) === 'sense');
  if (senses.length) {
    // Jitendex tags each group of senses with its parts of speech.
    return find(tree, x => kind(x) === 'sense-group').flatMap(group => {
      const gpos = find(group, x => kind(x) === 'part-of-speech-info', [], false).map(x => x.title ?? plain(segs(x))).join(', ') || pos;
      return find(group, x => kind(x) === 'sense').map(s => ({
        pos: gpos, text: glossary(s), examples: examplesIn(s),
      }));
    }).filter(s => plain(s.text).trim());
  }
  const gl = find(tree, x => kind(x) === 'glossary');
  if (gl.length) {
    const notes = find(tree, x => kind(x) === 'notes' || kind(x) === 'infoGlossary').flatMap(x => ['\n', ...segs(x)]);
    return [{ pos, text: [...glossary(tree), ...notes], examples: examplesIn(tree) }].filter(s => plain(s.text).trim());
  }
  const text = segs(tree, x => kind(x) === 'backlink');
  return plain(text).trim() ? [{ pos, text, examples: [] }] : [];
}

// A glossary list's items on one line: "to live on; to live off".
function glossary(n: unknown): Seg[] {
  const items = find(n, x => kind(x) === 'glossary').flatMap(g => kids(g).filter(isNode).filter(li => li.tag === 'li'));
  const parts = items.map(li => segs(li, meaningOnly));
  return parts.flatMap((p, i) => (i ? ['; ', ...p] : p));
}

// Parts of speech from a row's definition tags, in the dictionary's own words
// ("noun, feminine", "Ichidan verb, transitive verb").
export const posOf = (row: Row, tags: TagInfo) =>
  (row[2] ?? '').split(/\s+/).filter(Boolean)
    .map(t => tags[t]).filter((t): t is [string, string] => !!t && !!t[1] && (t[0] === 'partOfSpeech' || (t[0] ?? '').startsWith('gender')))
    .map(t => t[1]).join(', ');

// Rows of one dictionary → entries, one per headword + reading (+ sequence
// number when the dictionary has them), in the rows' order.
export function toEntries(rows: Row[], tags: TagInfo, dictName: string, note?: string): DictEntry[] {
  const groups = new Map<string, DictEntry>();
  for (const r of rows) {
    if (isFormRow(r)) continue;
    const key = `${r[0]}\u0000${r[1]}\u0000${r[6] > 0 ? r[6] : ''}`;
    const pos = posOf(r, tags);
    const senses = r[5].flatMap(g => sensesOf(g, pos));
    if (!senses.length) continue;
    const e = groups.get(key);
    if (e) e.senses.push(...senses);
    else {
      const reading = r[1] && r[1] !== r[0] ? r[1] : undefined;
      groups.set(key, { word: r[0], reading, phonetic: reading ?? '', senses, source: 'local', dictName, note });
    }
  }
  return [...groups.values()];
}
