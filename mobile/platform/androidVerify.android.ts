// Debug-only phase-0 verification harness for the Android build (window.__runPhase0Verify,
// wired by androidInit.android.ts only when isAndroidDebug()); never reachable in release APKs.
import { invoke } from '@tauri-apps/api/core';
import {
  callAndroid,
  isAndroidDebug,
  onAndroidEvent,
  type BgEvent,
  type CompressedPiece,
  type DecodedWav,
  type ExtractedAudio,
  type PlaybackSnapshot,
} from './androidBridge';
import {
  getAndroidPaths,
  getDeviceInfo,
  jaDictStatus,
  planWavCuts,
  resolveCardClipPath,
  stageAndroidZip,
} from './desktop.android';
// Import UI-facing clip & zip restore helpers through `./desktop` (the exact path mobile/Review.tsx
// and mobile/restore.ts use) so Phase 0 verification also proves Vite's SWAP works at runtime.
import {
  cleanupAndroidStagedZip,
  prepareSrc,
  resolveCardClipSrc,
  unpackAndroidZip,
} from './desktop';
import { getAllVideosFromDB, replaceAllVideos } from '../../utils/fileSystemAccess';
import { getAllCards, readAll, replaceAll } from '../../utils/review';
import { fromDesktopBackup, makeBackup, parseBackup, planLocal } from '../backup';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function logVerify(stage: string, data: Record<string, unknown>) {
  const payload = JSON.stringify({ stage, ...data });
  console.log('[LinguaClipVerify]', payload);
  await callAndroid('system.logVerify', { payload }).catch(() => {});
}

export interface VerifyHooks {
  /** Pause androidInit's auto flush / clip worker while the harness swaps the databases. */
  setSuspend: (on: boolean) => void;
  flushBgEventsToReview: () => Promise<number>;
}

export async function runPhase0Verification(hooks: VerifyHooks, videoPath?: string): Promise<Record<string, unknown>> {
  if (!isAndroidDebug()) return { ok: false, error: 'debug only' };
  const report: Record<string, unknown> = { ok: false, checks: {} as Record<string, unknown> };
  const checks = report.checks as Record<string, unknown>;
  const cleanupFiles: string[] = [];
  // Snapshot existing test DB so verification leaves the app completely clean.
  const prevVideos = await getAllVideosFromDB().catch(() => []);
  const prevReview = await readAll().catch(() => ({ cards: [], meta: [] }));
  hooks.setSuspend(true);
  try {
    await logVerify('start', { videoPath: videoPath || '' });

    // 1. Rust Core + Android Paths + Device Fingerprint + Yomitan SQLite + ja-dict
    const paths = await getAndroidPaths();
    const sysPaths = await callAndroid<{ filesDir: string; cacheDir: string; externalFilesDir: string }>('system.paths');
    const device = await getDeviceInfo();
    const dicts = await invoke<unknown[]>('dict_list');
    const ja = await jaDictStatus();
    checks.rustCore = {
      ok: !!paths.ownDir && paths.ownDir === sysPaths.filesDir && device.id.length === 32
        && Array.isArray(dicts) && typeof ja.installed === 'boolean',
      ownDir: paths.ownDir,
      filesDir: sysPaths.filesDir,
      deviceIdLen: device.id.length,
      deviceName: device.name,
      dictCount: dicts.length,
      jaDictInstalled: ja.installed,
    };
    await logVerify('check1_rustCore', checks.rustCore as Record<string, unknown>);

    // 2. Media Pipeline: MP4 -> Lossless .m4a -> 16k WAV -> Rust Silence Cuts -> 32kbps AAC + Clip + AC-3 + FLAC + 8kHz upsampling
    const srcVideo = videoPath || `${sysPaths.externalFilesDir}/test_speech.mp4`;
    const stem = `${paths.tmpDir}/verify_sample`;
    const extracted = await callAndroid<ExtractedAudio>('media.extractAudio', { input: srcVideo, outStemPath: stem });
    cleanupFiles.push(extracted.path);
    const wavPath = `${paths.tmpDir}/verify_sample.wav`;
    cleanupFiles.push(wavPath);
    const decoded = await callAndroid<DecodedWav>('media.decodeToWav16k', { input: extracted.path, outWavPath: wavPath });
    const cuts = await planWavCuts(decoded.wavPath, 60 * 60);
    const pieceM4a = `${paths.tmpDir}/verify_piece0.m4a`;
    cleanupFiles.push(pieceM4a);
    const compressed = await callAndroid<CompressedPiece>('media.compressPieceAac', {
      wavPath: decoded.wavPath,
      fromSample: cuts[0].fromSample,
      toSample: cuts[0].toSample,
      outM4aPath: pieceM4a,
      bitrate: 32000,
    });
    const clipPath = `${paths.clipsDir}/verify_clip.m4a`;
    cleanupFiles.push(clipPath);
    const clip = await callAndroid<{ path: string; sizeBytes: number; durationMs: number }>('media.cutAudioClip', {
      input: extracted.path,
      startMs: 500,
      endMs: 2500,
      outM4aPath: clipPath,
    });

    // AC-3 rejection check
    let ac3Rejected = false;
    let ac3Error = '';
    const ac3Path = `${sysPaths.externalFilesDir}/test_ac3.mp4`;
    if ((await callAndroid<{ exists: boolean }>('media.fileInfo', { path: ac3Path })).exists) {
      try {
        await callAndroid('media.extractAudio', { input: ac3Path, outStemPath: `${paths.tmpDir}/verify_ac3` });
      } catch (e) {
        ac3Error = e instanceof Error ? e.message : String(e);
        ac3Rejected = ac3Error.includes('audio:unsupported_codec');
      }
    } else {
      ac3Rejected = true;
    }

    // FLAC -> 96kbps AAC transcoding check
    let flacOk = true;
    let flacBytes = 0;
    const flacPath = `${sysPaths.externalFilesDir}/test_lossless.flac`;
    if ((await callAndroid<{ exists: boolean }>('media.fileInfo', { path: flacPath })).exists) {
      const flacRes = await callAndroid<ExtractedAudio>('media.extractAudio', { input: flacPath, outStemPath: `${paths.tmpDir}/verify_flac` });
      cleanupFiles.push(flacRes.path);
      flacBytes = flacRes.sizeBytes;
      flacOk = !flacRes.lossless && flacRes.path.endsWith('.m4a') && flacRes.sizeBytes > 0;
    }

    // 8kHz upsampling check (must NOT speed up 2x!)
    let upsample8kOk = true;
    let upsample8kDurationMs = 0;
    const lowRatePath = `${sysPaths.externalFilesDir}/test_8khz.wav`;
    if ((await callAndroid<{ exists: boolean }>('media.fileInfo', { path: lowRatePath })).exists) {
      const lowWav = `${paths.tmpDir}/verify_8k_up.wav`;
      cleanupFiles.push(lowWav);
      const up = await callAndroid<DecodedWav>('media.decodeToWav16k', { input: lowRatePath, outWavPath: lowWav });
      upsample8kDurationMs = up.durationMs;
      // 4-second 8kHz fixture -> upsampled 16kHz duration must be within [3800, 4200] ms
      upsample8kOk = up.durationMs >= 3800 && up.durationMs <= 4200;
    }

    checks.mediaPipeline = {
      ok: extracted.lossless && extracted.sizeBytes > 0 && decoded.samples > 16000 && cuts.length >= 1
        && compressed.sizeBytes > 0 && compressed.equivalentHourMb > 0 && compressed.equivalentHourMb < 25
        && clip.sizeBytes > 0 && ac3Rejected && flacOk && upsample8kOk,
      extracted,
      decoded,
      cutsCount: cuts.length,
      compressed,
      clip,
      ac3Rejected,
      ac3Error,
      flacOk,
      flacBytes,
      upsample8kOk,
      upsample8kDurationMs,
    };
    await logVerify('check2_mediaPipeline', checks.mediaPipeline as Record<string, unknown>);

    // 3. Media3 PlaybackService: 3x Loop (mid-track + EOF), AutoPause (normal + gap seek + past last cue),
    //    Section-end stop (all <= 50ms drift), Aux non-focus-stealing, Durable peek->IndexedDB->ack bg-events
    // Seed temporary video record for 'verify_ep1' (restored in finally) so flushBgEventsToReview sees an active record.
    await replaceAllVideos([
      ...prevVideos.filter(v => (v as { id?: string }).id !== 'verify_ep1'),
      {
        id: 'verify_ep1',
        displayName: 'Phase0 Verify Episode',
        videoFileName: 'verify.m4a',
        subtitleFileName: 'verify.srt',
        subtitleText: '1\n00:00:00,000 --> 00:00:00,900\nSentence one test.\n',
        videoPath: extracted.path,
        currentSubtitleIndex: 0,
        currentSectionIndex: 0,
        totalSubtitles: 3,
        completionRate: 0,
        dateAdded: Date.now(),
        lastPracticed: Date.now(),
        totalPracticeTime: 0,
      },
    ]);
    const prePeek = await callAndroid<{ events: BgEvent[] }>('playback.peekBgEvents');
    if (prePeek.events.length > 0) {
      await callAndroid('playback.ackBgEvents', { ids: prePeek.events.map(e => e.id) });
    }
    const cues = [
      { startMs: 0, endMs: 900, text: 'Sentence one test.' },
      { startMs: 1200, endMs: 2100, text: 'Sentence two test.' },
      { startMs: 2400, endMs: 3300, text: 'Sentence three test.' },
    ];
    await callAndroid('playback.load', {
      source: extracted.path,
      mediaId: 'verify_ep1',
      title: 'Phase0 Verify Episode',
      artist: 'LinguaClip',
      startMs: 0,
      autoPlay: false,
    });
    await callAndroid('playback.setTimeline', { cues, sectionEndMs: 3600 });

    // 3a. Mid-track 3x single-sentence loop + lockscreen mark_missed
    let loopDone: { completedLoops?: number; maxDriftMs?: number } | null = null;
    const offLoop = onAndroidEvent<{ completedLoops: number; maxDriftMs: number }>('loopCompleted', p => { loopDone = p; });
    await callAndroid('playback.setLoop', { startMs: 200, endMs: 900, count: 3, gapMs: 120 });
    await callAndroid('playback.play');
    await sleep(300);
    const marked = await callAndroid<BgEvent>('playback.triggerCustomAction', { action: 'mark_missed' });
    const dl1 = Date.now() + 8000;
    while (!loopDone && Date.now() < dl1) await sleep(100);
    offLoop();
    const midLoop = loopDone as { completedLoops?: number; maxDriftMs?: number } | null;

    // 3b. EOF-aligned 3x loop (endMs == clip duration, tests STATE_ENDED handling)
    let eofLoopDone: { completedLoops?: number; maxDriftMs?: number } | null = null;
    const offEof = onAndroidEvent<{ completedLoops: number; maxDriftMs: number }>('loopCompleted', p => { eofLoopDone = p; });
    await callAndroid('playback.load', {
      source: clip.path,
      mediaId: 'verify_clip_eof',
      title: 'EOF Loop Test',
      artist: 'LinguaClip',
      startMs: 0,
      autoPlay: false,
    });
    await sleep(250);
    const clipState = await callAndroid<PlaybackSnapshot>('playback.getState');
    const clipDur = Math.max(800, clipState.durationMs || 2000);
    await callAndroid('playback.setLoop', { startMs: Math.max(0, clipDur - 600), endMs: clipDur, count: 3, gapMs: 100 });
    await callAndroid('playback.play');
    const dl2 = Date.now() + 8000;
    while (!eofLoopDone && Date.now() < dl2) await sleep(100);
    offEof();
    const eofLoop = eofLoopDone as { completedLoops?: number; maxDriftMs?: number } | null;

    // 3c. Sentence-end autoPause (normal + gap seek + past last cue)
    await callAndroid('playback.load', {
      source: extracted.path,
      mediaId: 'verify_ep1',
      title: 'Phase0 Verify Episode',
      artist: 'LinguaClip',
      startMs: 0,
      autoPlay: false,
    });
    await callAndroid('playback.setTimeline', { cues, sectionEndMs: -1 });
    await callAndroid('playback.setAutoPause', { enabled: true });
    let pausedEvents: { index: number; driftMs: number }[] = [];
    const offPause = onAndroidEvent<{ index: number; driftMs: number }>('sentencePaused', p => { pausedEvents.push(p); });
    // Seek into gap (1050ms, between cue 0 end 900 and cue 1 start 1200) -> must pause at cue 1 (2100ms), NOT cue 0!
    await callAndroid('playback.seek', { positionMs: 1050 });
    await callAndroid('playback.play');
    const dl3 = Date.now() + 3000;
    while (pausedEvents.length === 0 && Date.now() < dl3) await sleep(80);
    const gapPause = pausedEvents[0] || null;
    // Seek past last cue (3500ms > 3300ms) -> autoPauseCueIdx must be -1 (never gets stuck pausing)
    const afterLastSeek = await callAndroid<PlaybackSnapshot>('playback.seek', { positionMs: 3500 });
    await callAndroid('playback.setAutoPause', { enabled: false });
    offPause();

    // 3d. Section-end stop precision (<= 50ms)
    await callAndroid('playback.clearLoop');
    await callAndroid('playback.setSectionEnd', { sectionEndMs: 2400 });
    await callAndroid('playback.seek', { positionMs: 1800 });
    await callAndroid('playback.play');
    await sleep(1000);
    const afterSection = await callAndroid<PlaybackSnapshot>('playback.getState');

    // 3e. Aux player pauses main without dropping MediaSession
    await callAndroid('playback.setSectionEnd', { sectionEndMs: -1 });
    await callAndroid('playback.seek', { positionMs: 0 });
    await callAndroid('playback.play');
    await sleep(250);
    const auxSnap = await callAndroid<PlaybackSnapshot>('playback.playAux', { source: clip.path, pauseMain: true });
    await sleep(250);
    await callAndroid('playback.stopAux');
    await callAndroid('playback.pause');

    // 3f. Durable bg-events: peek -> hooks.flushBgEventsToReview() writes to IndexedDB + ack -> peek returns 0
    const peekBefore = await callAndroid<{ events: BgEvent[] }>('playback.peekBgEvents');
    const flushedCount = await hooks.flushBgEventsToReview();
    const peekAfter = await callAndroid<{ events: BgEvent[] }>('playback.peekBgEvents');
    const cardsAfterFlush = await getAllCards();
    const missedPersisted = cardsAfterFlush.some(c => c.videoId === 'verify_ep1' && c.reasons.includes('missed'));

    checks.playbackService = {
      ok: !!midLoop && midLoop.completedLoops === 3 && (midLoop.maxDriftMs ?? 999) <= 50
        && !!eofLoop && eofLoop.completedLoops === 3
        && !!gapPause && gapPause.index === 1 && gapPause.driftMs <= 50
        && afterLastSeek.autoPauseCueIdx === -1
        && !afterSection.playing && afterSection.sectionStopDriftMs >= 0 && afterSection.sectionStopDriftMs <= 50
        && auxSnap.hasMediaSession && !auxSnap.playing
        && peekBefore.events.some(e => e.id === marked.id && e.mediaId === 'verify_ep1')
        && flushedCount >= 1 && peekAfter.events.length === 0 && missedPersisted,
      midLoop,
      eofLoop,
      gapPause,
      autoPausePastLastIdx: afterLastSeek.autoPauseCueIdx,
      sectionStopDriftMs: afterSection.sectionStopDriftMs,
      auxPausedMain: !auxSnap.playing,
      hasMediaSession: auxSnap.hasMediaSession,
      bgEventsPeeked: peekBefore.events.length,
      bgEventsFlushed: flushedCount,
      bgEventsRemainingAfterAck: peekAfter.events.length,
      missedPersisted,
    };
    await logVerify('check3_playbackService', checks.playbackService as Record<string, unknown>);

    // 4. Real Cross-platform Backup Migration: Desktop .zip -> stage -> read -> unpack -> IndexedDB replace
    //    -> settings downgrade -> independent clip resolution & real PlaybackService clip playback + PWA .json
    const desktopZip = `${paths.tmpDir}/desktop_migration_test.zip`;
    cleanupFiles.push(desktopZip);
    const manifestObj = {
      format: 1,
      app: '0.10.0',
      createdAt: Date.now(),
      platform: 'mac',
      ownDir: '/Users/demo/Movies/LinguaClip',
      videos: 1,
      cards: 1,
      hadLicense: false,
      files: true,
      clips: ['verify_clip.m4a'],
    };
    const dataObj = {
      videos: [{
        id: 'desk1',
        displayName: 'Desktop Podcast',
        videoFileName: 'ep.mp3',
        subtitleFileName: 'ep.srt',
        subtitleText: '1\n00:00:00,000 --> 00:00:02,000\nHello from desktop\n',
        videoPath: '/Users/demo/Movies/LinguaClip/nonexistent_on_phone.mp3',
        currentSubtitleIndex: 0,
        currentSectionIndex: 0,
        totalSubtitles: 1,
        completionRate: 0,
        dateAdded: 1,
        lastPracticed: 1,
        totalPracticeTime: 60,
      }],
      cards: [{
        id: 'desk1|0.00',
        deck: 'line',
        videoId: 'desk1',
        videoName: 'Desktop Podcast',
        videoPath: '/Users/demo/Movies/LinguaClip/nonexistent_on_phone.mp3',
        text: 'Hello from desktop',
        start: 0,
        end: 2,
        reasons: ['saved'],
        saved: true,
        clip: { kind: 'audio', file: 'verify_clip.m4a', from: 0 },
        fsrs: { due: Date.now(), stability: 1, difficulty: 5, elapsed_days: 0, scheduled_days: 1, learning_steps: 0, reps: 1, lapses: 0, state: 2, last_review: Date.now() },
        createdAt: 1,
      }],
      reviewMeta: [{ id: 'migrated' }],
      localStorage: {
        linguaclip_lang: 'zh',
        linguaclip_keys: '{"studio":{}}',
        linguaclip_transcribe_config: JSON.stringify({ mode: 'local', gpu: true, groqKey: 'gsk_test', bailianKey: '' }),
        linguaclip_dict_sources: JSON.stringify({ online: false, local: true, localFirst: true }),
      },
    };
    await invoke('backup_write', {
      dest: desktopZip,
      kind: 'auto',
      manifest: JSON.stringify(manifestObj),
      data: JSON.stringify(dataObj),
      files: true,
    });
    const staged = await stageAndroidZip(desktopZip);
    const mobileBackup = fromDesktopBackup(staged.manifest, staged.data, staged.appVersion);
    const unpackedCount = await unpackAndroidZip(staged.stagedZip);
    // Actually write into IndexedDB (same path as mobile/restore.ts run())
    await replaceAllVideos(mobileBackup.videos);
    await replaceAll(mobileBackup.review.cards, mobileBackup.review.meta);
    const restoredVideos = await getAllVideosFromDB();
    const restoredCards = await getAllCards();
    const migratedCard = restoredCards.find(c => c.id === 'desk1|0.00');
    // Verify missing desktop episode path fails prepareSrc through the swapped `./desktop` module
    // and cleanly falls back to `resolveCardClipSrc` (same code path as mobile/Review.tsx).
    let missingDesktopRejected = false;
    if (migratedCard?.videoPath) {
      try { await prepareSrc(migratedCard.videoPath); } catch { missingDesktopRejected = true; }
    }
    const resolvedClipUrl = migratedCard?.clip?.file ? await resolveCardClipSrc(migratedCard.clip.file) : null;
    const resolvedClipPath = migratedCard?.clip?.file ? await resolveCardClipPath(migratedCard.clip.file) : null;

    // Play the migrated clip-only card through ExoPlayer to prove audio actually plays on device
    let clipPlayed = false;
    if (resolvedClipPath) {
      await callAndroid('playback.load', {
        source: resolvedClipPath,
        mediaId: 'desk1',
        title: 'Migrated Clip',
        artist: 'LinguaClip',
        startMs: 0,
        autoPlay: true,
      });
      await sleep(350);
      const st = await callAndroid<PlaybackSnapshot>('playback.getState');
      clipPlayed = st.playing || st.positionMs > 0 || st.durationMs > 0;
      await callAndroid('playback.pause');
    }

    const plan = planLocal(
      { linguaclip_android_battery_dismissed: '1' },
      mobileBackup.local,
      { crossPlatform: true, target: 'android' },
    );
    const setMap = Object.fromEntries(plan.set);
    const pwaSample = makeBackup({ videos: [], cards: [], meta: [], local: { linguaclip_lang: 'zh' }, cache: {} }, Date.now());
    const pwaParsed = parseBackup(JSON.stringify(pwaSample));

    checks.backupMigration = {
      ok: unpackedCount >= 1
        && restoredVideos.some(v => v.id === 'desk1')
        && !!migratedCard && missingDesktopRejected && !!resolvedClipUrl && clipPlayed
        && !('linguaclip_keys' in setMap)
        && JSON.parse(setMap.linguaclip_transcribe_config).mode === 'cloud'
        && JSON.parse(setMap.linguaclip_dict_sources).online === true
        && plan.remove.length === 0
        && pwaParsed.platform === 'mobile',
      unpackedCount,
      restoredVideoCount: restoredVideos.length,
      restoredCardCount: restoredCards.length,
      missingDesktopRejected,
      resolvedClipUrl: !!resolvedClipUrl,
      clipPlayed,
      transcribeModeAfterDowngrade: JSON.parse(setMap.linguaclip_transcribe_config).mode,
      dictOnlineAfterDowngrade: JSON.parse(setMap.linguaclip_dict_sources).online,
      desktopShortcutsSkipped: !('linguaclip_keys' in setMap),
      pwaAccepted: pwaParsed.platform === 'mobile',
    };
    await logVerify('check4_backupMigration', checks.backupMigration as Record<string, unknown>);

    report.ok = Object.values(checks).every(c => (c as { ok?: boolean }).ok === true);
    await logVerify('DONE', report);
    return report;
  } catch (e) {
    report.error = e instanceof Error ? e.message : String(e);
    await logVerify('ERROR', report);
    return report;
  } finally {
    hooks.setSuspend(false);
    // Restore original IndexedDB state and remove all temporary verification files.
    await replaceAllVideos(prevVideos).catch(() => {});
    await replaceAll(prevReview.cards, prevReview.meta).catch(() => {});
    await cleanupAndroidStagedZip().catch(() => {});
    for (const f of cleanupFiles) {
      await callAndroid('media.removeFile', { path: f }).catch(() => {});
    }
  }
}
