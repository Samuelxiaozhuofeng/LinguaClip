// The phone's practice ways on one study page (docs/android-roadmap.md「第 2 期施工约定」).
// Study.tsx owns the header (back, title, "line n / N") and the way switch; a way renders only
// its own body + bottom controls and never its own back button or title.
import type { VideoRecord } from '../../types';

export type PhoneWay = 'listen' | 'dict' | 'blur' | 'cloze' | 'custom' | 'read';
export const MAIN_WAYS: PhoneWay[] = ['listen', 'dict'];          // always shown, never switched off
export const MORE_WAYS: PhoneWay[] = ['blur', 'cloze', 'custom', 'read']; // under "More", each can be switched off in Settings

export interface WayProps {
  record: VideoRecord;
  /** Where to start, in seconds: the line that holds this time (shared by every way, linguaclip_watch_pos). */
  startSec: number;
  /** Report the current line's start time whenever it changes: switching ways resumes from here. */
  onPos: (sec: number) => void;
  /** Report "line n of N" for the shared header (n is 1-based); call again when it changes. */
  onLine?: (n: number, total: number) => void;
  /** Leave the study page (e.g. a summary's "back home" button). */
  onExit: () => void;
}
