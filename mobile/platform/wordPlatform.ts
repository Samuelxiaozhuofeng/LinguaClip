// Web/PWA word lookup & pronunciation adapter (docs/mobile-web.md 7).
// Strictly browser-only: Wiktionary lookup only, no desktop/native runtime or aux audio.
import { lookupWiktionary, type DictEntry, type DictLang } from '../../utils/dictionary';
import { jaLemma } from '../../utils/japanese';
import type { DictCheck, LocalDict } from '../../utils/desktop';
import type { Recommended } from '../../utils/dictRecommend';

export const WORD_PLATFORM: 'web' | 'android' = 'web';
export const CAN_SPEAK_WORD: boolean = false;
export const MAX_AUX_AUDIO_BYTES = 2 * 1024 * 1024;

export type LookupError = '' | 'notFound' | 'offline' | 'noDict' | 'dictsOff' | 'noLocal';
export type LookupResult = { dict: DictEntry[] | null; error: LookupError };

export interface PhoneLocalDictState {
  list: LocalDict[];
  job: { stage: 'download' | 'import'; pct: number; title: string } | null;
  error: string | null;
  fresh: string | null;
  retryable: boolean;
}

const EMPTY_LOCAL_STATE: PhoneLocalDictState = {
  list: [],
  job: null,
  error: null,
  fresh: null,
  retryable: false,
};

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function encodeAuxAudio(buf: ArrayBuffer | null | undefined, maxBytes = MAX_AUX_AUDIO_BYTES): string | null {
  if (!buf || buf.byteLength === 0 || buf.byteLength > maxBytes) return null;
  return arrayBufferToBase64(buf);
}

export async function lookupOnlineWord(word: string, lang: DictLang | null, ja: boolean): Promise<LookupResult> {
  if (!lang) return { dict: null, error: 'noDict' };
  try {
    const dict = await lookupWiktionary(ja ? jaLemma(word) : word, lang);
    return dict && dict.length > 0 ? { dict, error: '' } : { dict: null, error: 'notFound' };
  } catch (e) {
    console.warn('Wiktionary unreachable:', e);
    return { dict: null, error: 'offline' };
  }
}

export async function speakWordAux(_word: string, _lang: DictLang | null): Promise<boolean> {
  return false;
}

export function stopWordAux(): void {}

// No-op stubs for PWA (local Yomitan dicts exist only on Android native).
export const usePhoneLocalDicts = (): PhoneLocalDictState => EMPTY_LOCAL_STATE;
export const refreshPhoneLocalDicts = async (): Promise<void> => {};
export const pickAndCheckPhoneDict = async (): Promise<{ path: string; check: DictCheck } | null> => null;
export const importPhoneDict = async (_path: string, _title: string, _replace?: string): Promise<void> => {};
export const downloadPhoneDict = async (_r: Recommended): Promise<void> => {};
export const setPhoneDictEnabled = async (_id: string, _enabled: boolean): Promise<void> => {};
export const setPhoneDictLang = async (_id: string, _lang: DictLang): Promise<void> => {};
export const movePhoneDict = async (_id: string, _step: -1 | 1): Promise<void> => {};
export const removePhoneDict = async (_id: string): Promise<void> => {};
export const retryPhoneDictJob = async (): Promise<void> => {};
export const clearPhoneDictError = (): void => {};
