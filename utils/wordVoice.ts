// A word's sound read aloud by Edge's voices in its video's language, when Settings says "read aloud" (docs/word-audio.md).
import { synthesizeSpeech } from './desktop';
import { VOICES } from './speech';
import { getVideoRecord } from './videoStorage';
import { videoLang } from './deckLang';

const bytes = new Map<string, Promise<ArrayBuffer | null>>(); // lang|word → one request; a failed one is dropped
const urls = new Map<string, string>();

export const voiceBytes = (word: string, lang: string): Promise<ArrayBuffer | null> => {
  const voice = VOICES[lang];
  if (!voice) return Promise.resolve(null);
  const key = `${lang}|${word}`;
  let p = bytes.get(key);
  if (!p) {
    p = synthesizeSpeech(word, voice).catch(() => null);
    bytes.set(key, p);
    p.then(b => { if (!b) bytes.delete(key); });
  }
  return p;
};

const forVideo = async (word: string, videoId: string) => {
  const r = await getVideoRecord(videoId).catch(() => null);
  if (!r) return null;
  const lang = videoLang(r);
  return { lang, data: await voiceBytes(word, lang) };
};

// ponytail: blob URLs are kept, never revoked — one small mp3 per word read this session.
const urlOf = async (word: string, videoId: string): Promise<string | null> => {
  const v = await forVideo(word, videoId);
  if (!v?.data) return null;
  const key = `${v.lang}|${word}`;
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([v.data], { type: 'audio/mpeg' })));
  return urls.get(key)!;
};

// null = no voice / failed / not back within waitMs (the request carries on into the cache).
export const wordVoiceUrl = (word: string, videoId: string, waitMs?: number): Promise<string | null> => {
  const p = urlOf(word, videoId).catch(() => null);
  return waitMs === undefined ? p : Promise.race([p, new Promise<null>(res => setTimeout(() => res(null), waitMs))]);
};

// For Anki: base64 mp3; undefined on any failure or after 5 s (then the line's own sound, never a stopped card).
export const wordVoiceB64 = async (word: string, videoId: string, waitMs = 5000): Promise<string | undefined> => {
  try {
    const d = (await Promise.race([forVideo(word, videoId), new Promise<null>(res => setTimeout(() => res(null), waitMs))]))?.data;
    if (!d) return undefined;
    const b = new Uint8Array(d);
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  } catch {
    return undefined;
  }
};
