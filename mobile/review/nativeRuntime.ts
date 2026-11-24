// Lazy bridges to Android-only M2.5 modules (utils/clips, mobile/ankiDroidExport, pro/license).
// Uses vite.android.config.ts's SWAP on mobile/platform/desktop.ts so iPhone PWA builds
// (`vite.mobile.config.ts`) never pull @tauri-apps/* or desktop-only exports into dist-mobile/.
import type * as ClipsMod from '../../utils/clips';
import type * as AnkiExportMod from '../ankiDroidExport';
import type * as LicenseMod from '../../pro/license';
import type { ReviewCard } from '../../utils/review';
import * as desktop from '../platform/desktop';

type AndroidM25Desktop = typeof desktop & {
  loadClipsRuntime?: () => Promise<typeof ClipsMod>;
  loadAnkiDroidExport?: () => Promise<typeof AnkiExportMod>;
  loadSupporterLicense?: () => Promise<typeof LicenseMod>;
};

const api = desktop as AndroidM25Desktop;

let clipsMod: typeof ClipsMod | null = null;
let clipsPromise: Promise<typeof ClipsMod | null> | null = null;
let ankiPromise: Promise<typeof AnkiExportMod | null> | null = null;
let licensePromise: Promise<typeof LicenseMod | null> | null = null;

export function getClipsRuntime(): Promise<typeof ClipsMod | null> {
  if (!api.loadClipsRuntime) return Promise.resolve(null);
  return clipsPromise ??= api.loadClipsRuntime().then(m => (clipsMod = m), () => null);
}

export function warmClipsRuntime(): void {
  void getClipsRuntime();
}

// Holds a deleted card's standalone clip files while undo is on offer (docs/review.md).
// Synchronous when pre-warmed on Android; harmless no-op on PWA.
export async function holdCardClips(card: Pick<ReviewCard, 'clip'>): Promise<() => void> {
  if (!card.clip) return () => {};
  const mod = clipsMod ?? await getClipsRuntime();
  return mod ? mod.holdClips(card) : () => {};
}

export async function refillClipsAfterRestore(): Promise<void> {
  const mod = clipsMod ?? await getClipsRuntime();
  if (mod) await mod.fillClips();
}

export function getAnkiDroidExportRuntime(): Promise<typeof AnkiExportMod | null> {
  if (!api.loadAnkiDroidExport) return Promise.resolve(null);
  return ankiPromise ??= api.loadAnkiDroidExport().catch(() => null);
}

export function getLicenseRuntime(): Promise<typeof LicenseMod | null> {
  if (!api.loadSupporterLicense) return Promise.resolve(null);
  return licensePromise ??= api.loadSupporterLicense().catch(() => null);
}
