import type { DictLang } from './dictionary';

// Guesses a subtitle file's language from its function words (docs/languages.md「猜语言」).

// One word says little about its language (parler is also an English
// headword), so the whole subtitle file votes with its function words.
// Norwegian shares its first ten with Danish; the last eight are spelt the
// Bokmål way. `da` only competes: Danish winning = null. Norwegian comes first,
// so a tie goes to it.
// No 'er' / 'vi': German 'er' (he), English 'er', Spanish 'vi' would outvote those languages.
const STOPWORDS: Record<Exclude<DictLang, 'ja'> | 'da', string[]> = {
  en: ['the', 'and', 'is', 'you', 'to', 'of', 'it', 'that', 'what', 'this', 'have', 'with', 'are', 'was', 'i', 'my', "it's", "don't"],
  es: ['el', 'la', 'que', 'y', 'los', 'las', 'es', 'por', 'se', 'una', 'con', 'para', 'lo', 'qué', 'está', 'pero', 'yo', 'muy'],
  fr: ['le', 'la', 'les', 'et', 'est', 'que', 'je', 'vous', 'pas', 'une', 'des', 'du', 'il', 'ce', 'qui', "c'est", 'ne', 'mais'],
  de: ['der', 'die', 'das', 'und', 'ist', 'ich', 'nicht', 'zu', 'ein', 'eine', 'sie', 'es', 'mit', 'den', 'dem', 'auf', 'wir', 'du'],
  no: ['og', 'skal', 'ikke', 'jeg', 'det', 'på', 'som', 'har', 'til', 'hvor', 'av', 'hva', 'meg', 'deg', 'seg', 'noe', 'nå', 'mye'],
  da: ['og', 'skal', 'ikke', 'jeg', 'det', 'på', 'som', 'har', 'til', 'hvor', 'af', 'hvad', 'mig', 'dig', 'sig', 'noget', 'nu', 'meget'],
};

// null = a language with no dictionary here (Chinese, Danish, …). Japanese is
// told by its kana, which Chinese never has.
export const detectLang = (texts: string[]): DictLang | null => {
  const letters = texts.join('').match(/\p{L}/gu)?.length ?? 0;
  const kana = texts.join('').match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu)?.length ?? 0;
  if (kana >= 5 && kana / letters >= 0.2) return 'ja';
  const words = texts.join(' ').toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) ?? [];
  if (words.length === 0) return null;
  const latin = words.filter(w => /^[\p{Script=Latin}']+$/u.test(w)).length;
  if (latin / words.length < 0.8) return null;
  let best: keyof typeof STOPWORDS | null = null;
  let bestScore = 0;
  for (const lang of Object.keys(STOPWORDS) as (keyof typeof STOPWORDS)[]) {
    const set = new Set(STOPWORDS[lang]);
    const score = words.filter(w => set.has(w)).length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  // ponytail: a few subtitle lines can tie or barely score (short Danish can read as Norwegian); fine for whole files.
  return bestScore >= 3 && best !== 'da' ? best : null;
};
