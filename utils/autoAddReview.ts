// New-user default for auto-adding stuck lines to sentence review:
// Existing users (already had practice_config, history, cards, or days) keep `false`;
// fresh installs default to `true`, without touching `linguaclip_practice_config` or sync timestamps.
import { getPracticeConfig } from './storage';
import { getAllVideosFromDB } from './fileSystemAccess';
import { getAllCards } from './review';

export const AUTO_ADD_DEFAULT_KEY = 'linguaclip_auto_add_default';

let initPromise: Promise<void> | null = null;

const readLocal = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};

const writeLocal = (key: string, value: string): void => {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
};

// Decide once at app startup (before any video is imported) whether a brand-new install
// should default `autoAddReview` to on. Never writes `linguaclip_practice_config`, so
// first-time cross-device sync will not clobber another device's explicit setting.
export function initAutoAddDefault(): Promise<void> {
  return (initPromise ??= (async () => {
    const cfg = getPracticeConfig();
    if (cfg.autoAddReview !== undefined) return;
    if (readLocal(AUTO_ADD_DEFAULT_KEY) !== null) return;
    const hasLegacyKeys = readLocal('linguaclip_practice_config') !== null
      || readLocal('linguaclip_days') !== null
      || readLocal('linguaclip_today') !== null
      || readLocal('linguaclip_saved_lines') !== null
      || readLocal('linguaclip_last_way') !== null;
    if (hasLegacyKeys) {
      writeLocal(AUTO_ADD_DEFAULT_KEY, '0');
      return;
    }
    const [videos, cards] = await Promise.all([
      getAllVideosFromDB().catch(() => null),
      getAllCards().catch(() => null),
    ]);
    // Unreadable DB: treat conservatively as existing user rather than surprising them.
    if (!videos || !cards || videos.length > 0 || cards.length > 0) {
      writeLocal(AUTO_ADD_DEFAULT_KEY, '0');
    } else {
      writeLocal(AUTO_ADD_DEFAULT_KEY, '1');
    }
  })());
}

export function getAutoAddReview(): boolean {
  const explicit = getPracticeConfig().autoAddReview;
  if (explicit !== undefined) return explicit;
  return readLocal(AUTO_ADD_DEFAULT_KEY) === '1';
}

// Test hook
export function resetAutoAddDefaultInit(): void {
  initPromise = null;
}
