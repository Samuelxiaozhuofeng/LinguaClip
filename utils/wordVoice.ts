// A word's sound when Settings says "dictionary voice": the dictionary's recording, else Edge reading it, in its video's language (docs/word-audio.md).
import { synthesizeSpeech } from './desktop';
import { VOICES } from './speech';
import { getVideoRecord } from './videoStorage';
import { videoLang } from './deckLang';
import { dictVoice, type Got } from './dictVoice';

type Fetch = (word: string, lang: string) => Promise<Got>;
const OFFLINE_MS = 60_000;

// Dictionary first, then read aloud; the two asked at once. A 'none' is kept for the run, an 'error' is asked again.
// Both unreachable → for a minute nothing is asked and null comes back at once.
export const createVoices = (dict: Fetch, tts: Fetch, now = () => performance.now()) => {
  const caches = [new Map<string, Promise<Got>>(), new Map<string, Promise<Got>>()];
  let offlineAt: number | null = null;
  const ask = (i: number, f: Fetch, word: string, lang: string) => {
    const key = `${lang}|${word}`;
    let p = caches[i].get(key);
    if (!p) {
      p = f(word, lang).catch((): Got => 'error');
      caches[i].set(key, p);
      p.then(g => { if (g === 'error') caches[i].delete(key); });
    }
    return p;
  };
  // null = nothing within waitMs (late answers still land in the cache).
  return (word: string, lang: string, waitMs: number): Promise<ArrayBuffer | null> => {
    if (offlineAt !== null && now() - offlineAt < OFFLINE_MS) return Promise.resolve(null);
    const d = ask(0, dict, word, lang), t = ask(1, tts, word, lang);
    Promise.all([d, t]).then(([a, b]) => { if (a === 'error' && b === 'error') offlineAt = now(); });
    return new Promise(res => {
      let dv: Got | undefined, tv: Got | undefined;
      const bytes = (g?: Got) => (g instanceof ArrayBuffer ? g : null);
      const done = (v: ArrayBuffer | null) => { clearTimeout(timer); res(v); };
      const settle = () => {
        if (bytes(dv)) done(bytes(dv));
        else if (dv !== undefined && tv !== undefined) done(bytes(tv));
      };
      const timer = setTimeout(() => done(bytes(dv) ?? bytes(tv)), waitMs);
      d.then(v => { dv = v; settle(); });
      t.then(v => { tv = v; settle(); });
    });
  };
};

const readAloud: Fetch = async (word, lang) => {
  const voice = VOICES[lang];
  if (!voice) return 'none';
  return (await synthesizeSpeech(word, voice)) ?? 'error';
};
const voiceFor = createVoices(dictVoice, readAloud);

const forVideo = async (word: string, videoId: string, waitMs: number) => {
  const r = await getVideoRecord(videoId).catch(() => null);
  if (!r) return null;
  const lang = videoLang(r);
  return { lang, data: await voiceFor(word, lang, waitMs) };
};

// ponytail: blob URLs are kept, never revoked — one small mp3 per recording played this session.
// Keyed by the bytes, not the word: a read-aloud used once is not kept over the recording that came later.
const urls = new WeakMap<ArrayBuffer, string>();

// null = no sound / failed / not back within waitMs (then the caller plays the video's own sound).
export const wordVoiceUrl = async (word: string, videoId: string, waitMs = 2000): Promise<string | null> => {
  const v = await forVideo(word, videoId, waitMs).catch(() => null);
  if (!v?.data) return null;
  if (!urls.has(v.data)) urls.set(v.data, URL.createObjectURL(new Blob([v.data], { type: 'audio/mpeg' })));
  return urls.get(v.data)!;
};

// For Anki: base64 mp3; undefined on any failure or after 5 s (then the line's own sound, never a stopped card).
export const wordVoiceB64 = async (word: string, videoId: string, waitMs = 5000): Promise<string | undefined> => {
  try {
    const d = (await forVideo(word, videoId, waitMs))?.data;
    if (!d) return undefined;
    const b = new Uint8Array(d);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  } catch {
    return undefined;
  }
};
