// Android native dictionary lookup (online + local Yomitan), local Yomitan management,
// and non-focus-stealing aux ExoPlayer word pronunciation (docs/android-roadmap.md M1.4 & M2.4).
import { useSyncExternalStore } from 'react';
import { dictsOff, lookupWord, type DictEntry, type DictLang } from '../../utils/dictionary';
import { lookupJa } from '../../utils/jaLookup';
import { dictVoice, type Got } from '../../utils/dictVoice';
import { createVoices } from '../../utils/wordVoice';
import { VOICES } from '../../utils/speech';
import { getWordVoice } from '../../utils/storage';
import { loadLocalDicts } from '../../utils/localDict';
import { downloadJa, loadJa } from '../../utils/japanese';
import type { Recommended } from '../../utils/dictRecommend';
import {
  dictCheck, dictDownload, dictImport, dictList, dictMove, dictRemove, dictUpdate,
  onDictProgress, pickDictZip, synthesizeSpeech,
  type DictCheck, type LocalDict,
} from './desktop.android';
import { callAndroid, isAndroidNative } from './androidBridge';

export const WORD_PLATFORM: 'web' | 'android' = 'android';
export const CAN_SPEAK_WORD: boolean = true;
export const MAX_AUX_AUDIO_BYTES = 2 * 1024 * 1024;
const SPEAK_TIMEOUT_MS = 3000;
const SPEAK_DEDUPE_MS = 600;

export type LookupError = '' | 'notFound' | 'offline' | 'noDict' | 'dictsOff' | 'noLocal';
export type LookupResult = { dict: DictEntry[] | null; error: LookupError };

export interface PhoneLocalDictState {
  list: LocalDict[];
  job: { stage: 'download' | 'import'; pct: number; title: string } | null;
  error: string | null;
  fresh: string | null;
  retryable: boolean;
}

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
  const off = await dictsOff(lang);
  if (off === 'all') return { dict: null, error: 'dictsOff' };
  if (off === 'noLocal') return { dict: null, error: 'noLocal' };
  try {
    const dict = ja ? await lookupJa(word) : await lookupWord(word, lang);
    return dict && dict.length > 0 ? { dict, error: '' } : { dict: null, error: 'notFound' };
  } catch (e) {
    console.warn('Dictionary lookup failed:', e);
    return { dict: null, error: 'offline' };
  }
}

// --- Aux-channel pronunciation (dict real recording -> Edge TTS -> false) ---

const readAloud = async (word: string, lang: string): Promise<Got> => {
  const voice = VOICES[lang];
  if (!voice) return 'none';
  return (await synthesizeSpeech(word, voice)) ?? 'error';
};

const voiceFor = createVoices(dictVoice, readAloud);
let speakSeq = 0;
let auxChain: Promise<unknown> = Promise.resolve();
let inFlightSpeak: { key: string; promise: Promise<boolean> } | null = null;
let lastSpoke: { key: string; at: number } | null = null;

function enqueueAux<T>(fn: () => Promise<T>): Promise<T> {
  const next = auxChain.then(fn, fn);
  auxChain = next.catch(() => {});
  return next;
}

export async function playAuxAudioBytes(
  buf: ArrayBuffer | null | undefined,
  send: (method: string, args: Record<string, unknown>) => Promise<unknown> = callAndroid,
  native: boolean = isAndroidNative(),
): Promise<boolean> {
  if (!native) return false;
  const base64 = encodeAuxAudio(buf);
  if (!base64) return false;
  try {
    await send('playback.playAuxBytes', { base64, ext: 'mp3', pauseMain: false });
    return true;
  } catch {
    return false;
  }
}

export async function speakWordAux(word: string, lang: DictLang | null): Promise<boolean> {
  if (getWordVoice() === 'clip') return false;
  const w = word.trim();
  if (!w || !lang || !isAndroidNative()) return false;
  const key = `${lang}|${w}`;
  if (inFlightSpeak && inFlightSpeak.key === key) return inFlightSpeak.promise;
  if (lastSpoke && lastSpoke.key === key && Date.now() - lastSpoke.at < SPEAK_DEDUPE_MS) {
    return true;
  }
  // Interrupt any active or in-flight pronunciation before starting a new word.
  if (inFlightSpeak || lastSpoke) {
    stopWordAux();
  }
  const seq = ++speakSeq;
  const run = (async (): Promise<boolean> => {
    try {
      const bytes = await voiceFor(w, lang, SPEAK_TIMEOUT_MS);
      if (seq !== speakSeq) return false;
      const ok = await enqueueAux(async () => {
        if (seq !== speakSeq) return false;
        return playAuxAudioBytes(bytes);
      });
      if (ok && seq === speakSeq) {
        lastSpoke = { key, at: Date.now() };
      }
      return ok;
    } catch {
      return false;
    } finally {
      if (inFlightSpeak?.promise === run) inFlightSpeak = null;
    }
  })();
  inFlightSpeak = { key, promise: run };
  return run;
}

export function stopWordAux(): void {
  speakSeq++;
  inFlightSpeak = null;
  lastSpoke = null;
  if (!isAndroidNative()) return;
  void enqueueAux(() => callAndroid('playback.stopAux').catch(() => {}));
}

// --- Local Yomitan dictionary management (module-level state survives closing DictPage) ---

let dictState: PhoneLocalDictState = {
  list: [],
  job: null,
  error: null,
  fresh: null,
  retryable: false,
};
let lastRetry: (() => Promise<void>) | null = null;
const dictListeners = new Set<() => void>();

const setDictState = (patch: Partial<PhoneLocalDictState>) => {
  dictState = { ...dictState, ...patch };
  dictListeners.forEach(fn => fn());
};

const subscribePhoneLocalDicts = (fn: () => void) => {
  dictListeners.add(fn);
  return () => { dictListeners.delete(fn); };
};

export const usePhoneLocalDicts = (): PhoneLocalDictState =>
  useSyncExternalStore(subscribePhoneLocalDicts, () => dictState);

export async function refreshPhoneLocalDicts(): Promise<void> {
  if (!isAndroidNative()) return;
  try {
    const list = await dictList();
    setDictState({ list });
    void loadLocalDicts();
  } catch (e) {
    console.warn('Local dictionaries unreadable:', e);
  }
}

async function runDictJob(
  title: string,
  stage: 'download' | 'import',
  work: () => Promise<LocalDict[]>,
  retryFn: () => Promise<void>,
): Promise<void> {
  lastRetry = retryFn;
  setDictState({ job: { stage, pct: 0, title }, error: null, retryable: false });
  const off = await onDictProgress(p => setDictState({ job: { ...p, title } })).catch(() => () => {});
  const before = new Set(dictState.list.map(d => d.id));
  try {
    const list = await work();
    const added = list.find(d => !before.has(d.id));
    lastRetry = null;
    setDictState({
      list,
      fresh: added && !added.lang ? added.id : dictState.fresh,
      error: null,
      retryable: false,
    });
    void loadLocalDicts();
  } catch (e) {
    setDictState({ error: String(e), retryable: true });
  } finally {
    off();
    setDictState({ job: null });
  }
}

export async function pickAndCheckPhoneDict(): Promise<{ path: string; check: DictCheck } | null> {
  if (!isAndroidNative()) return null;
  setDictState({ error: null, retryable: false });
  let path: string | null;
  try {
    path = await pickDictZip();
  } catch (e) {
    setDictState({ error: String(e), retryable: false });
    return null;
  }
  if (!path) return null;
  try {
    const check = await dictCheck(path);
    return { path, check };
  } catch (e) {
    setDictState({ error: String(e), retryable: false });
    return null;
  }
}

export async function importPhoneDict(path: string, title: string, replace?: string): Promise<void> {
  await runDictJob(title, 'import', () => dictImport(path, replace), () => importPhoneDict(path, title, replace));
}

export async function downloadPhoneDict(r: Recommended): Promise<void> {
  // Japanese forms are reduced to dictionary form by the kuromoji word splitter.
  if (r.lang === 'ja' && !(await loadJa())) void downloadJa();
  await runDictJob(r.title, 'download', () => dictDownload(r.urls), () => downloadPhoneDict(r));
}

async function editLocalDict(work: () => Promise<LocalDict[]>): Promise<void> {
  try {
    const list = await work();
    setDictState({ list, error: null, retryable: false });
    void loadLocalDicts();
  } catch (e) {
    setDictState({ error: String(e), retryable: false });
  }
}

export const setPhoneDictEnabled = (id: string, enabled: boolean): Promise<void> =>
  editLocalDict(() => dictUpdate(id, { enabled }));

export const setPhoneDictLang = (id: string, lang: DictLang): Promise<void> => {
  if (dictState.fresh === id) setDictState({ fresh: null });
  return editLocalDict(() => dictUpdate(id, { lang }));
};

export const movePhoneDict = (id: string, step: -1 | 1): Promise<void> =>
  editLocalDict(() => dictMove(id, step));

export const removePhoneDict = (id: string): Promise<void> =>
  editLocalDict(() => dictRemove(id));

export async function retryPhoneDictJob(): Promise<void> {
  if (lastRetry && !dictState.job) await lastRetry();
}

export function clearPhoneDictError(): void {
  lastRetry = null;
  setDictState({ error: null, retryable: false });
}
