// Android native home/app helpers (swapped for mobile/platform/homePlatform.ts in vite.android.config.ts).
import { invoke } from '@tauri-apps/api/core';
import { callAndroid, type ExtractedAudio, type ProbeTracksResult } from './androidBridge';
import {
  pickAndroidMediaFile,
  pickAndroidSrtFile,
  selectDefaultTrack,
  startAndroidLocalImport,
  type LocalImportArgs,
} from './importAndroid';
import { sweepAndroidOrphans } from './deleteAndroid';

export const HOME_PLATFORM: 'web' | 'android' = 'android';

export const pickAndroidMedia = pickAndroidMediaFile;

export async function probeAndroidMediaUri(uri: string): Promise<ProbeTracksResult | null> {
  const probe = await callAndroid<ProbeTracksResult>('media.probeTracks', { input: uri });
  const tracks = Array.isArray(probe?.tracks) ? probe.tracks : [];
  if (tracks.length === 0) throw new Error('audio:no_track');
  const defIdx = typeof probe.defaultTrackIndex === 'number' && probe.defaultTrackIndex >= 0
    ? probe.defaultTrackIndex
    : selectDefaultTrack(tracks);
  if (defIdx < 0) {
    const firstMime = tracks[0]?.mime || 'unknown';
    throw new Error(`audio:unsupported_codec:${firstMime}`);
  }
  return { ...probe, tracks, defaultTrackIndex: defIdx };
}

export const pickAndroidSrt = pickAndroidSrtFile;

export const startAndroidImport = (opts: LocalImportArgs): Promise<string> =>
  startAndroidLocalImport(opts);

export async function repickAndroidRecordAudio(id: string, trackIndex = -1): Promise<string | null> {
  const picked = await pickAndroidMediaFile();
  if (!picked) return null;
  const paths = await invoke<{ mediaDir: string }>('android_paths');
  const chosenTrack = trackIndex >= 0 ? trackIndex : picked.probe.defaultTrackIndex;
  const jobId = `repick-${id}`;
  await callAndroid('processing.begin', {
    jobId,
    title: picked.probe.displayName || 'Audio',
    detail: '',
    percent: -1,
  });
  try {
    const res = await callAndroid<ExtractedAudio>('processing.runExtract', {
      jobId,
      input: picked.uri,
      outStemPath: `${paths.mediaDir}/${id}`,
      trackIndex: chosenTrack,
    });
    return res.path;
  } finally {
    await callAndroid('processing.end', { jobId }).catch(() => {});
  }
}

export async function clearAndroidJobTmp(id: string): Promise<void> {
  await invoke('android_reset_job', { id, clearTmp: true });
}

export const sweepAndroidMediaOrphans = sweepAndroidOrphans;
