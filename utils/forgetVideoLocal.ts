// Clears every per-video localStorage entry when a record is deleted (shared across desktop & mobile).
import { forgetCustomPos, forgetWatchPos, setLastWay } from './storage';
import { forgetLooked } from './readLooked';
import { forgetMask } from './subtitleMask';

const KEYWORDS_SEEN_KEY = 'linguaclip_keywords_seen';

export function forgetVideoLocal(videoId: string): void {
  forgetWatchPos(videoId);
  forgetCustomPos(videoId);
  setLastWay(videoId, null);
  forgetLooked(videoId);
  forgetMask(videoId);
  try {
    const raw = localStorage.getItem(KEYWORDS_SEEN_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        localStorage.setItem(KEYWORDS_SEEN_KEY, JSON.stringify(parsed.filter(x => x !== videoId)));
      } else if (parsed && typeof parsed === 'object') {
        delete (parsed as Record<string, unknown>)[videoId];
        localStorage.setItem(KEYWORDS_SEEN_KEY, JSON.stringify(parsed));
      }
    }
  } catch { /* non-critical */ }
}
