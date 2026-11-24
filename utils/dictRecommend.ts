// Recommended Yomitan local dictionaries and pure formatting / matching helpers
// shared by desktop (components/SettingsLocalDict.tsx) and mobile (mobile/settings/).
// Kept free of Tauri / runtime imports so PWA builds can import it safely if needed.
import type { DictLang } from './dictionary';
import type { LocalDict } from './desktop';

export interface Recommended {
  lang: DictLang;
  title: string;
  gloss: 'zh' | 'en';
  mb: number;
  urls: string[];
}

export const DICT_LANGS: DictLang[] = ['en', 'es', 'fr', 'de', 'ja'];

export const DICT_ERRORS = [
  'badZip', 'nested', 'badIndex', 'badRow', 'tooBig', 'noTerms',
  'busy', 'already', 'sameName', 'net', 'disk', 'gone',
] as const;

export const formatMb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1e6))} MB`;

// "JMdict [2026-09-29]" → "JMdict", matching dicts_import.rs base_title.
export const dictLabel = (title: string): string => title.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, '');

// wty is on Hugging Face (blocked in mainland China → hf-mirror.com, same path).
const wty = (src: DictLang, tgt: 'zh' | 'en', mb: number): Recommended => {
  const path = `datasets/daxida/wty-release/resolve/main/latest/dict/${src}/${tgt}/wty-${src}-${tgt}.zip`;
  return {
    lang: src,
    title: `wty-${src}-${tgt}`,
    gloss: tgt,
    mb,
    urls: [`https://huggingface.co/${path}`, `https://hf-mirror.com/${path}`],
  };
};

export const RECOMMENDED: Recommended[] = [
  { lang: 'ja', title: 'Jitendex.org', gloss: 'en', mb: 38, urls: ['https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip'] },
  wty('ja', 'zh', 7),
  wty('es', 'zh', 3), wty('es', 'en', 22),
  wty('fr', 'zh', 3), wty('fr', 'en', 11),
  wty('de', 'zh', 6), wty('de', 'en', 17),
  wty('en', 'zh', 5), wty('en', 'en', 108),
];

// An English interface lists English definitions only; a Chinese one lists both, Chinese first.
export const recommendedFor = (ui: 'zh' | 'en', lang: DictLang): Recommended[] =>
  RECOMMENDED
    .filter(r => r.lang === lang && (ui === 'zh' || r.gloss === 'en'))
    .sort((a, b) => (a.gloss === 'zh' ? -1 : 0) - (b.gloss === 'zh' ? -1 : 0));

// Downloaded from here, or the same book imported by hand (its name, dated or not).
export const isInstalled = (
  r: Recommended,
  list: Pick<LocalDict, 'downloadUrl' | 'broken' | 'title'>[],
): boolean => list.some(d => d.downloadUrl === r.urls[0] || (!d.broken && dictLabel(d.title) === r.title));
