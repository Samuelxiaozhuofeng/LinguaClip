import { synthesizeSpeech } from './desktop';

// Clean read-aloud for "break it down": Edge's neural voices first, the Mac's
// own speech synthesis when that fails. One clip plays at a time.

export const VOICES: Record<string, string> = {
  en: 'en-US-JennyNeural',
  es: 'es-ES-ElviraNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  it: 'it-IT-ElsaNeural',
  pt: 'pt-BR-FranciscaNeural',
  ja: 'ja-JP-NanamiNeural',
  ko: 'ko-KR-SunHiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  no: 'nb-NO-PernilleNeural',
  nb: 'nb-NO-PernilleNeural',
};

export type Clip = { text: string; lang: string; url: string | null };

export async function loadClip(text: string, lang: string): Promise<Clip> {
  const voice = VOICES[lang];
  const bytes = voice ? await synthesizeSpeech(text, voice) : null;
  const url = bytes ? URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' })) : null;
  return { text, lang, url };
}

export function releaseClip(clip: Clip) {
  if (clip.url) URL.revokeObjectURL(clip.url);
}

let playing: HTMLAudioElement | null = null;

export function stopClip() {
  playing?.pause();
  playing = null;
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

export function playClip(clip: Clip) {
  stopClip();
  if (clip.url) {
    playing = new Audio(clip.url);
    playing.play().catch(() => {});
    return;
  }
  if (typeof speechSynthesis === 'undefined') return;
  const u = new SpeechSynthesisUtterance(clip.text);
  u.lang = clip.lang;
  speechSynthesis.speak(u);
}
