// Web/PWA home/app native helper stubs (swapped in vite.android.config.ts for homePlatform.android.ts).
// Zero @tauri-apps/* imports so iPhone PWA builds remain strictly browser-only.
import type { ProbeTracksResult } from './androidBridge';

export const HOME_PLATFORM: 'web' | 'android' = 'web';

export async function pickAndroidMedia(): Promise<{ uri: string; probe: ProbeTracksResult } | null> {
  return null;
}

export async function probeAndroidMediaUri(_uri: string): Promise<ProbeTracksResult | null> {
  return null;
}

export async function pickAndroidSrt(): Promise<{ name: string; text: string; count: number } | null> {
  return null;
}

export async function startAndroidImport(_opts: {
  uri: string;
  displayName: string;
  trackIndex: number;
  lang: string;
  srtText?: string;
  srtName?: string;
}): Promise<string> {
  throw new Error('android:unavailable');
}

export async function repickAndroidRecordAudio(_id: string, _trackIndex?: number): Promise<string | null> {
  return null;
}

export async function clearAndroidJobTmp(_id: string): Promise<void> {}

export async function sweepAndroidMediaOrphans(): Promise<number> {
  return 0;
}
