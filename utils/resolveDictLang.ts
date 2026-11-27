import { detectLang, type DictLang } from './dictionary';

// Dictionary language for a video / audio: a hand-picked language wins over subtitle guessing.
export const resolveDictLang = (manual: DictLang | undefined, lines: string[]): DictLang | null =>
  manual ?? detectLang(lines);
