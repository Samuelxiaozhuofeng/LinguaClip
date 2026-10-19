// A word's own recording from a dictionary site, by video language (Cambridge / Eudic / Jisho, then Youdao; docs/word-audio.md).
import { EUDIC_HOST, get, pickEudicTerms } from './dictionary';

// bytes = got it; 'none' = the sites answered but have no recording; 'error' = couldn't reach them (not to be remembered).
export type Got = ArrayBuffer | 'none' | 'error';

const HOSTS = new Set(['dictionary.cambridge.org', 'fs-gateway.frdic.com', 'd1vjc5dkcd3yh2.cloudfront.net', 'dict.youdao.com']);
const MS = 8_000;

// Only https on the hosts above; a page-given address must also end in .mp3.
const allowed = (src: string | null | undefined, base: string, mp3 = true): string | null => {
  if (!src) return null;
  try {
    const u = new URL(src, base);
    return u.protocol === 'https:' && HOSTS.has(u.hostname) && (!mp3 || u.pathname.endsWith('.mp3')) ? u.href : null;
  } catch {
    return null;
  }
};

// Pages are parsed only to read attributes; nothing is put into the app's page or run.
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

// The entry's first US recording (UK if none); the Word of the Day box outside the entry is left alone.
export const cambridgeAudio = (html: string): string | null => {
  const d = parse(html);
  const src = (r: string) => d.querySelector(`.entry-body .${r}.dpron-i source[type="audio/mpeg"]`)?.getAttribute('src');
  return allowed(src('us') ?? src('uk'), 'https://dictionary.cambridge.org/');
};

// The first "global voice" (a person's recording); .voice-js beside the phonetics is synthesized and skipped.
export const eudicAudio = (html: string): string | null =>
  allowed(parse(html).querySelector('.gv-voice[data-rel]')?.getAttribute('data-rel'), 'https://fs-gateway.frdic.com/');

// Only the recording of this word (id="audio_<word>:<reading>"): a search page also lists other words, some with recordings.
export const jishoAudio = (html: string, word: string): string | null => {
  const mine = [...parse(html).querySelectorAll('audio[id^="audio_"]')].find(a => a.id.slice(6).split(':').includes(word));
  const src = [...(mine?.querySelectorAll('source[src]') ?? [])].map(s => s.getAttribute('src')!).find(s => s.endsWith('.mp3'));
  return allowed(src, 'https://jisho.org/');
};

const isMissing = (e: unknown) => (e as { status?: number }).status === 404;

const download = async (url: string | null, youdao = false): Promise<ArrayBuffer | 'none'> => {
  if (!url) return 'none';
  let res: Response;
  try {
    res = await get(url, undefined, MS);
  } catch (e) {
    if (isMissing(e)) return 'none';
    // Youdao says "no such word" as a 500 with this JSON; any other 500 is the service failing.
    const { status, res: r } = e as { status?: number; res?: Response };
    if (youdao && status === 500 && (await r?.text().catch(() => ''))?.includes('returned null audio')) return 'none';
    throw e;
  }
  if (!(res.headers.get('content-type') ?? '').startsWith('audio/')) return 'none';
  const b = await res.arrayBuffer();
  return b.byteLength > 1000 ? b : 'none';
};

const page = async (url: string, pick: (html: string) => string | null) => {
  try {
    return pick(await (await get(url, undefined, MS)).text());
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
};

const cambridge = async (w: string) => download(await page(`https://dictionary.cambridge.org/dictionary/english/${encodeURIComponent(w)}`, cambridgeAudio));
const jisho = async (w: string) => download(await page(`https://jisho.org/search/${encodeURIComponent(w)}`, h => jishoAudio(h, w)));
// A conjugated form leads to its lemma's page, so hablábamos plays hablar's recording.
const eudic = (lang: 'es' | 'fr' | 'de') => async (w: string) => {
  const host = EUDIC_HOST[lang];
  const [t] = pickEudicTerms(await (await get(`${host}/dicts/prefix/${encodeURIComponent(w)}`, undefined, MS)).json(), w);
  if (!t) return 'none';
  return download(await page(`${host}/dicts/${lang}/${encodeURIComponent(t.value!)}?recordid=${t.recordid}`, eudicAudio));
};
const youdao = (q: string) => (w: string) =>
  download(allowed(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w)}&${q}`, 'https://dict.youdao.com/', false), true);

// The one table of where each language's recordings come from, tried in order.
const SOURCES: Record<string, ((w: string) => Promise<ArrayBuffer | 'none'>)[]> = {
  en: [cambridge, youdao('type=2')],
  es: [eudic('es'), youdao('le=es')],
  fr: [eudic('fr'), youdao('le=fr')],
  de: [eudic('de'), youdao('le=de')],
  ja: [jisho, youdao('le=jap')],
};

// First recording wins; 'error' when none was found and at least one site couldn't be reached.
export const dictVoice = async (word: string, lang: string): Promise<Got> => {
  let failed = false;
  for (const src of SOURCES[lang] ?? []) {
    try {
      const got = await src(word);
      if (got !== 'none') return got;
    } catch {
      failed = true;
    }
  }
  return failed ? 'error' : 'none';
};
