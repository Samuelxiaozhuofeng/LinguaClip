import { DictEntry, getDictChoice, lookupWord } from './dictionary';
import { localDictsReady, lookupLocal } from './localDict';
import { jaLemma, jaMorphs, kanaFold } from './japanese';
import { JA_ALSO } from './jaPhrases';

// What a click on a Japanese group shows: Youdao's entries for its word in
// dictionary form (食べました → 食べる), led by an entry for the clicked phrase
// itself when Youdao has one (すみません, 見ている).

// The dictionaries' part-of-speech labels (Youdao's, then the English ones'), by ipadic's.
const POS: Record<string, string[]> = {
  動詞: ['动词', 'verb'], 形容詞: ['形容', 'adjective'], 名詞: ['名', 'noun'], 副詞: ['副', 'adverb'],
  連体詞: ['连体', 'pre-noun'], 感動詞: ['感', 'interjection'], 代名詞: ['代', 'pronoun'],
};
const han = (s: string) => s.match(/\p{Script=Han}/gu) ?? [];

// Youdao answers a word it lacks with some other word (お話し → おいしい): an
// entry is kept only if it is spelled, read or written with a kanji like the
// query. Then the entries of the query's part of speech lead, so a kana verb
// shows 来る before くる「佝偻病」.
export function rankJa(entries: DictEntry[], query: string): DictEntry[] {
  const morphs = jaMorphs(query);
  const reading = morphs && kanaFold(morphs.map(m => m.reading ?? m.s).join(''));
  const last = morphs?.[morphs.length - 1];
  const pos = POS[last?.d1 === '代名詞' ? '代名詞' : last?.pos ?? ''];
  const kept = entries.filter(e =>
    e.word === query || (!!reading && kanaFold(e.reading ?? e.word) === reading) || han(e.word).some(c => query.includes(c)));
  const fits = (e: DictEntry) => !!pos && e.senses.some(s => pos.some(p => s.pos.toLowerCase().includes(p)));
  return [...kept.filter(fits), ...kept.filter(e => !fits(e))];
}

export async function lookupJa(word: string): Promise<DictEntry[] | null> {
  // Local dictionaries find the dictionary form themselves; what they lack goes
  // the usual way below (the choice stays "local", so lookupWord moves on to the default).
  await localDictsReady(); // until the list is read, "local" is not a choice yet
  if (getDictChoice().ja === 'local') {
    const local = await lookupLocal(word, 'ja');
    if (local) return local;
  }
  const lemma = jaLemma(word);
  // Only a group of several words can be a phrase of its own; a lone kana word
  // would bring back the homophone its spelling fix avoids (くる「佝偻病」).
  const several = (jaMorphs(word)?.filter(m => !m.punct).length ?? 0) > 1;
  const [whole, base] = await Promise.all([several && lemma !== word ? lookupWord(word, 'ja') : null, lookupWord(lemma, 'ja')]);
  const found = [...(whole ?? []).filter(e => e.word === word), ...rankJa(base ?? [], lemma)];
  // JA_ALSO patches Youdao's gaps and homophones; the other dictionaries don't need it.
  const also = getDictChoice().ja === 'youdao' ? JA_ALSO[lemma] ?? [] : [];
  for (const r of await Promise.all(also.map(v => lookupWord(v, 'ja')))) found.push(...(r ?? []));
  // Katakana nouns in a row are grouped as one loanword (スマートフォン); two
  // words Youdao has no entry for together (フランスパリ) are looked up apart.
  const parts = jaMorphs(lemma)?.map(m => m.s) ?? [];
  if (found.length === 0 && parts.length > 1 && parts.every(p => /^[\p{Script=Katakana}ー]+$/u.test(p))) {
    for (const r of await Promise.all(parts.map(p => lookupWord(p, 'ja')))) found.push(...(r ?? []));
  }
  return found.length ? found : null;
}
