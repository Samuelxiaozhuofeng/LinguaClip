import type { DictEntry, DictLang, Sense } from './dictionary';

// Dictionaries that explain in English (docs/dictionary.md), for the English
// interface: Wiktionary's REST definitions and Jisho's search, both JSON. Only
// parsing here; dictionary.ts does the requests.

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

// Wiktionary definitions are HTML: shown as plain text only, never rendered.
// Furigana (<rt>, and <rp> brackets) is dropped: 遊ぶ, not 遊(あそ)ぶ.
export const htmlText = (html: string) => html
  .replace(/<(style|rt|rp)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<[^>]+>/g, '')
  .replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== '#') return ENTITY[e.toLowerCase()] ?? m;
    const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  })
  .replace(/\s+/g, ' ')
  .trim();

const LANG_NAME: Record<DictLang, string> = { en: 'English', es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese' };

type WkDef = { definition?: string; examples?: string[]; parsedExamples?: { example?: string; translation?: string }[] };
type WkItem = { partOfSpeech?: string; definitions?: WkDef[] };

// One language's part of a Wiktionary answer: the word's own meanings, plus
// the words it is a form of (llegué → llegar, fue → ir / ser) with the grammar
// line, so the caller can show those words' meanings instead.
export const parseWiktionary = (body: any, word: string, lang: DictLang): { entry: DictEntry | null; forms: { lemma: string; note: string }[] } | null => {
  const items: WkItem[] | undefined = body?.[lang];
  if (!Array.isArray(items) || items.length === 0) return null;
  const senses: Sense[] = [];
  const forms: { lemma: string; note: string }[] = [];
  const anchor = new RegExp(`href="/wiki/([^"#]+)#${LANG_NAME[lang]}"`, 'g');
  for (const item of items) {
    const pos = htmlText(item.partOfSpeech ?? '');
    for (const d of item.definitions ?? []) {
      const html = d.definition ?? '';
      // An untranslated stub ("This term needs a translation to English").
      if (html.includes('Template:rfdef')) continue;
      const text = htmlText(html);
      if (!text) continue;
      if (html.includes('form-of-definition')) {
        const lemma = [...html.matchAll(anchor)].pop()?.[1];
        const name = lemma && decodeURIComponent(lemma).replace(/_/g, ' ');
        if (name && name !== word) { forms.push({ lemma: name, note: text }); continue; }
      }
      const examples = d.parsedExamples?.length
        ? d.parsedExamples.map(x => [[htmlText(x.example ?? ''), htmlText(x.translation ?? '')].filter(Boolean).join('\n')])
        : (d.examples ?? []).map(x => [htmlText(x)]);
      senses.push({ pos, text: [text], examples: examples.filter(x => x[0]) });
    }
  }
  return { entry: senses.length ? { word, phonetic: '', senses, source: 'wiktionary' } : null, forms };
};

type JishoItem = { japanese?: { word?: string; reading?: string }[]; senses?: { english_definitions?: string[]; parts_of_speech?: string[] }[] };

// Jisho (JMdict): one entry per headword; a sense with no part of speech shares
// the one before it, and the Wikipedia add-on senses are dropped. Its search is
// loose (食べる brings 食べるラー油), so only headwords spelled or read as the
// query are kept — or Jisho's first guess when none is.
export const parseJisho = (body: any, query: string): DictEntry[] | null => {
  const items: JishoItem[] = Array.isArray(body?.data) ? body.data : [];
  const exact = items.filter(i => i.japanese?.some(x => x.word === query || x.reading === query));
  const found = (exact.length ? exact : items.slice(0, 1)).flatMap((item): DictEntry[] => {
    const { word, reading } = item.japanese?.[0] ?? {};
    const head = word || reading;
    if (!head) return [];
    let pos = '';
    const senses: Sense[] = [];
    for (const s of item.senses ?? []) {
      if (s.parts_of_speech?.length) pos = s.parts_of_speech.join(', ');
      if (/wikipedia/i.test(pos)) continue;
      const text = (s.english_definitions ?? []).join('; ');
      if (text) senses.push({ pos, text: [text], examples: [] });
    }
    return senses.length ? [{ word: head, phonetic: reading && reading !== head ? reading : '', senses, source: 'jisho', reading: reading || head }] : [];
  });
  return found.length ? found : null;
};
