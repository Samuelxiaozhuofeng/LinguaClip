// Pure helpers for phone home, language display names, track language matching,
// weekly/today visibility checks, and missing/desktop audio classification.
import type { VideoRecord } from '../types';
import type { ReviewCard } from '../utils/review';
import type { Today } from '../utils/today';
import { getToday } from '../utils/today';
import { blobId } from './backup';
import type { AudioTrackInfo } from './platform/androidBridge';

const ISO3_TO_2: Record<string, string> = {
  eng: 'en',
  jpn: 'ja',
  spa: 'es',
  fra: 'fr',
  fre: 'fr',
  deu: 'de',
  ger: 'de',
  kor: 'ko',
  nor: 'no',
  nob: 'no',
  nno: 'no',
  zho: 'zh',
  chi: 'zh',
  cmn: 'zh',
  yue: 'zh',
};

const LANG_NAMES: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    en: '英语',
    ja: '日语',
    es: '西班牙语',
    fr: '法语',
    de: '德语',
    ko: '韩语',
    no: '挪威语',
    zh: '中文',
  },
  en: {
    en: 'English',
    ja: 'Japanese',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    ko: 'Korean',
    no: 'Norwegian',
    zh: 'Chinese',
  },
};

/** Normalizes ISO-639-1, ISO-639-2/B/T, and BCP-47 tags (e.g. "jpn", "en-US") to a 2-letter code. */
export function normalizeLangCode(raw?: string | null): string {
  if (!raw) return '';
  const cleaned = raw.trim().toLowerCase().replace(/_/g, '-');
  if (!cleaned || cleaned === 'und' || cleaned === 'unknown') return '';
  const primary = cleaned.split('-')[0];
  return ISO3_TO_2[primary] ?? primary;
}

/** Reliable localized language name that does not degrade to raw codes on minimal WebView ICU builds. */
export function phoneLangName(code: string, ui: string): string {
  const norm = normalizeLangCode(code);
  const table = ui === 'zh' ? LANG_NAMES.zh : LANG_NAMES.en;
  if (norm && table[norm]) return table[norm];
  try {
    const out = new Intl.DisplayNames([ui === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(norm || code);
    if (out) return out;
  } catch { /* ignore */ }
  return code;
}

/** Picks the best supported audio track matching `lang` (prefers isDefault among matches), or null. */
export function matchTrackForLang(tracks: AudioTrackInfo[], lang: string): number | null {
  const target = normalizeLangCode(lang);
  if (!target || target === 'auto') return null;
  let firstMatch: number | null = null;
  for (const tr of tracks) {
    if (tr.supported === false) continue;
    if (normalizeLangCode(tr.language) !== target) continue;
    if (tr.isDefault) return tr.index;
    if (firstMatch === null) firstMatch = tr.index;
  }
  return firstMatch;
}

const localDayStr = (ms: number): string => {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export function isSameLocalDay(ms: number | undefined, now = Date.now()): boolean {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return false;
  return localDayStr(ms) === localDayStr(now);
}

/** True when at least one review card was graded or marked mastered today (local time). */
export function reviewedToday(cards: Pick<ReviewCard, 'fsrs' | 'mastered'>[], now = Date.now()): boolean {
  return cards.some(c => isSameLocalDay(c.fsrs?.last_review, now) || isSameLocalDay(c.mastered, now));
}

/** True when the 7-day chart has zero practice activity and zero remembered lines. */
export function isWeekEmpty(days: Pick<Today, 'sec' | 'lines'>[], remembered: number): boolean {
  return remembered <= 0 && days.every(d => d.sec <= 0 && d.lines <= 0);
}

/** True when the learner has practiced for at least 1 second today or on any recorded past day. */
export function hasEverPracticed(now = Date.now()): boolean {
  if (getToday(now).sec > 0) return true;
  try {
    const raw = localStorage.getItem('linguaclip_days');
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.values(parsed as Record<string, { sec?: unknown }>).some(d => Number(d?.sec) > 0);
  } catch {
    return false;
  }
}

/** Heuristic for paths originating from a desktop machine (macOS / Windows / Linux). */
export function isDesktopPath(path?: string): boolean {
  if (!path) return false;
  const p = path.trim();
  if (!p) return false;
  if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\')) return true;
  if (/^\/(Users|home|Volumes|mnt|media|opt)\//.test(p)) return true;
  return false;
}

/**
 * True on web/PWA when a finished (or errored) record has no playable audio on this browser:
 * missing videoPath, unstored blob:<id>, or a local filesystem path (e.g. from desktop/Android).
 */
export function isWebAudioMissing(r: VideoRecord, have: Set<string> | null): boolean {
  if (r.importJob && !r.importJob.error) return false;
  const p = r.videoPath ?? r.importJob?.source ?? '';
  if (!p) return !r.importJob;
  if (/^https?:\/\//i.test(p) || p.startsWith('/starter/')) return false;
  const bid = blobId(p);
  if (bid) return have !== null && !have.has(bid);
  return true;
}

/** Formats a backup timestamp concisely in the current UI language. */
export function formatBackupDate(ms: number, ui: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  try {
    return new Intl.DateTimeFormat(ui === 'zh' ? 'zh-CN' : 'en', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}
