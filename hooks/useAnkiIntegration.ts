import { useState, useCallback } from 'react';
import { Subtitle, AnkiConfig, AnkiCardTemplateConfig } from '../types';
import * as Anki from '../utils/anki';
import * as Storage from '../utils/storage';
import { dialog } from '../components/Dialog';
import { t } from '../utils/i18n';
import { getVideoFromDB } from '../utils/fileSystemAccess';
import { videoLang } from '../utils/deckLang';

export type AnkiStatus = 'idle' | 'recording' | 'adding' | 'success' | 'error';

export interface UseAnkiIntegrationParams {
  videoRef: React.RefObject<HTMLVideoElement>;
  videoFileName: string | null;
  videoId?: string | null; // picks the language's own Anki deck, if one is set
}

// The card goes to its video's language deck when Settings → Anki names one; otherwise
// (or if the record can't be read) to the target deck.
const withLangDeck = async (template: AnkiCardTemplateConfig, videoId?: string | null): Promise<AnkiCardTemplateConfig> => {
  if (!template.deckByLang || !videoId) return template;
  const record = await getVideoFromDB(videoId).catch(() => null);
  const lang = record ? videoLang(record) : 'other';
  const deck = lang === 'other' ? '' : template.deckByLang[lang];
  return deck ? { ...template, deckName: deck } : template;
};

export interface UseAnkiIntegrationReturn {
  // State
  ankiConfig: AnkiConfig | null;
  ankiStatus: AnkiStatus;

  // Actions
  setAnkiConfig: (config: Anki.AnkiConfig | null) => void;
  setAnkiStatus: (status: AnkiStatus) => void;
  handleAddToAnki: (subtitle: Subtitle) => Promise<void>;
  handleWordToAnki: (word: string, definition: string, subtitle: Subtitle, example?: string) => Promise<void>;
  reloadConfig: () => void;
}

type VideoAudioTap = {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
};

const videoAudioTaps = new WeakMap<HTMLVideoElement, VideoAudioTap>();

function tapVideo(video: HTMLVideoElement): VideoAudioTap {
  const existing = videoAudioTaps.get(video);
  if (existing) return existing;
  const ctx = new AudioContext();
  const source = ctx.createMediaElementSource(video);
  source.connect(ctx.destination);
  const tap = { ctx, source };
  videoAudioTaps.set(video, tap);
  return tap;
}

// AAC/m4a first: AnkiMobile (iPad/iPhone) can't play webm/opus; desktop and AnkiDroid play m4a too.
function pickRecorderMime(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4;codecs=mp4a.40.2')) {
    return { mimeType: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' };
  }
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm')) {
    return { mimeType: 'audio/webm', ext: 'webm' };
  }
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/mp4')) {
    return { mimeType: 'audio/mp4', ext: 'mp4' };
  }
  return { mimeType: '', ext: 'webm' };
}

class AudioCaptureError extends Error {}

const alertAudioFailed = (e: AudioCaptureError) =>
  dialog.alert(t('anki.audioFailedTitle'), `${t('anki.audioFailedBody')}\n\n${e.message}`);

export function useAnkiIntegration(params: UseAnkiIntegrationParams): UseAnkiIntegrationReturn {
  const { videoRef, videoFileName, videoId } = params;

  const [ankiConfig, setAnkiConfig] = useState<AnkiConfig | null>(Anki.getAnkiConfig());
  const [ankiStatus, setAnkiStatus] = useState<AnkiStatus>('idle');

  // Reload config from storage
  const reloadConfig = useCallback(() => {
    setAnkiConfig(Anki.getAnkiConfig());
  }, []);

  // Capture audio clip from video with padding
  const captureAudioClip = useCallback(async (start: number, end: number): Promise<{ base64: string; ext: string } | null> => {
    const video = videoRef.current;
    if (!video) return null;

    // Get audio padding configuration
    const paddingConfig = Storage.getAudioPaddingConfig();
    const startPaddingSec = paddingConfig.startPadding / 1000;
    const endPaddingSec = paddingConfig.endPadding / 1000;

    // Apply padding
    const paddedStart = start - startPaddingSec;
    const paddedEnd = end + endPaddingSec;

    // Boundary checks
    if (paddedStart < 0) {
      throw new Error(`Audio padding error: Start time (${paddedStart.toFixed(2)}s) is before video start. Please reduce start padding.`);
    }
    if (paddedEnd > video.duration) {
      throw new Error(`Audio padding error: End time (${paddedEnd.toFixed(2)}s) exceeds video duration (${video.duration.toFixed(2)}s). Please reduce end padding.`);
    }

    const tap = tapVideo(video);
    await tap.ctx.resume();

    const dest = tap.ctx.createMediaStreamDestination();
    tap.source.connect(dest);

    const { mimeType, ext } = pickRecorderMime();
    const recorder = mimeType
      ? new MediaRecorder(dest.stream, { mimeType })
      : new MediaRecorder(dest.stream);
    const chunks: BlobPart[] = [];
    const originalTime = video.currentTime;
    const wasPlaying = !video.paused;
    // Recorded at 1×: at 2× the clip would sound sped up and, timed in real time, run past the line.
    const originalRate = video.playbackRate;
    video.playbackRate = 1;
    const blobType = mimeType || 'audio/webm';

    return new Promise((resolve, reject) => {
        let done = false;
        const teardown = () => {
            try { tap.source.disconnect(dest); } catch { /* already disconnected */ }
            video.playbackRate = originalRate;
        };

        recorder.ondataavailable = e => {
            if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.onstop = () => {
            teardown();
            const blob = new Blob(chunks, { type: blobType });
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onloadend = () => {
                // Restore state
                video.currentTime = originalTime;
                if (!wasPlaying) video.pause();

                if (done) return;
                done = true;
                const result = reader.result;
                if (typeof result !== 'string' || !result) {
                    reject(reader.error ?? new Error('Audio encode failed'));
                    return;
                }
                resolve({ base64: result.includes(',') ? result.split(',')[1] : result, ext });
            }
        };

        // Start recording sequence with padded times
        video.currentTime = paddedStart;
        recorder.start();
        video.play().catch(e => {
            console.error("Record playback failed", e);
            if (recorder.state !== 'inactive') recorder.stop();
            teardown();
            if (!done) {
                done = true;
                reject(e);
            }
        });

        const duration = (paddedEnd - paddedStart) * 1000;

        // Stop slightly after duration to ensure we catch the end
        setTimeout(() => {
            if (recorder.state !== 'inactive') {
                recorder.stop();
                video.pause();
            }
        }, duration + 50); // 50ms buffer
    });
  }, [videoRef]);

  // Capture media (screenshot and/or audio) for a subtitle
  const captureMedia = useCallback(async (currentSub: Subtitle, template: AnkiCardTemplateConfig | null) => {
      let screenshotBase64 = undefined;
      let audioBase64 = undefined;
      let audioExt = undefined;

      if (!template) return { screenshotBase64, audioBase64, audioExt };

      const mappingValues = Object.values(template.fieldMapping);
      const needsScreenshot = mappingValues.includes('screenshot');
      const needsAudio = mappingValues.includes('audio');

      // 1. Capture Screenshot (a sound-only file has no picture: no image rather than a blank one)
      if (videoRef.current?.videoWidth && needsScreenshot) {
          try {
              const canvas = document.createElement('canvas');
              canvas.width = videoRef.current.videoWidth;
              canvas.height = videoRef.current.videoHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                  ctx.drawImage(videoRef.current, 0, 0, canvas.width, canvas.height);
                  screenshotBase64 = canvas.toDataURL('image/jpeg', 0.8);
              }
          } catch (e) {
              console.error("Screenshot capture failed", e);
          }
      }

      // 2. Capture Audio. A card whose audio field comes out empty is worse
      // than no card: the caller stops and says why.
      if (needsAudio) {
          let result: { base64: string; ext: string } | null = null;
          try {
              result = await captureAudioClip(currentSub.startTime, currentSub.endTime);
          } catch (e) {
              console.error("Audio capture failed", e);
              throw new AudioCaptureError(e instanceof Error ? e.message : String(e));
          }
          if (!result) throw new AudioCaptureError('no video');
          if (!result.base64) throw new AudioCaptureError('empty recording');
          audioBase64 = result.base64;
          audioExt = result.ext;
      }

      return { screenshotBase64, audioBase64, audioExt };
  }, [ankiConfig, videoRef, captureAudioClip]);

  // Add current subtitle to Anki
  const handleAddToAnki = useCallback(async (subtitle: Subtitle) => {
    if (!ankiConfig) {
      dialog.alert(t('anki.notConnectedTitle'), t('anki.notConnectedBody'));
      return;
    }
    if (ankiStatus !== 'idle') return;

    const template = ankiConfig.card;

    if (!template) {
      dialog.alert(t('anki.noCardTitle'), t('anki.noCardBody'));
      return;
    }

    const needsAudio = Object.values(template.fieldMapping).includes('audio');
    if (needsAudio) setAnkiStatus('recording');
    else setAnkiStatus('adding');

    let media: Awaited<ReturnType<typeof captureMedia>>;
    try {
        media = await captureMedia(subtitle, template);
    } catch (e) {
        setAnkiStatus('error');
        if (e instanceof AudioCaptureError) alertAudioFailed(e);
        setTimeout(() => setAnkiStatus('idle'), 3000);
        return;
    }
    const { screenshotBase64, audioBase64, audioExt } = media;

    setAnkiStatus('adding');
    try {
        await Anki.addNote(ankiConfig.url, await withLangDeck(template, videoId), {
            sentence: subtitle.text,
            videoName: videoFileName || 'Unknown',
            timestamp: Storage.formatTimeCode(subtitle.startTime),
            screenshotBase64,
            audioBase64,
            audioExt,
        });
        setAnkiStatus('success');
        setTimeout(() => setAnkiStatus('idle'), 2000);
    } catch (e: any) {
        console.error(e);
        setAnkiStatus('error');
        dialog.alert(t('anki.refusedTitle'), e.message);
        setTimeout(() => setAnkiStatus('idle'), 3000);
    }
  }, [ankiConfig, ankiStatus, captureMedia, videoFileName, videoId]);

  // Add word with definition to Anki
  const handleWordToAnki = useCallback(async (word: string, definition: string, subtitle: Subtitle, example?: string) => {
      if (!ankiConfig) {
        dialog.alert(t('anki.notConnectedTitle'), t('anki.notConnectedBody'));
        throw new Error('Anki not configured');
      }

      const template = ankiConfig.card;

      if (!template) {
        dialog.alert(t('anki.noCardTitle'), t('anki.noCardBody'));
        throw new Error('Anki card not configured');
      }

      let media: Awaited<ReturnType<typeof captureMedia>>;
      try {
          media = await captureMedia(subtitle, template);
      } catch (e) {
          if (e instanceof AudioCaptureError) alertAudioFailed(e);
          throw e;
      }
      const { screenshotBase64, audioBase64, audioExt } = media;

      try {
          await Anki.addNote(ankiConfig.url, await withLangDeck(template, videoId), {
              sentence: subtitle.text,
              videoName: videoFileName || 'Unknown',
              timestamp: Storage.formatTimeCode(subtitle.startTime),
              screenshotBase64,
              audioBase64,
              audioExt,
              word,
              definition,
              example
          });
      } catch (e: any) {
          dialog.alert(t('anki.refusedTitle'), e?.message ?? String(e));
          throw e;
      }
  }, [ankiConfig, captureMedia, videoFileName, videoId]);

  // Moving to another line clears the badge, but never one still recording or
  // adding: that card isn't done, and its own finish sets the badge.
  const clearAnkiStatus = useCallback((status: AnkiStatus) => {
    setAnkiStatus(s => (status === 'idle' && (s === 'recording' || s === 'adding') ? s : status));
  }, []);

  return {
    ankiConfig,
    ankiStatus,
    setAnkiConfig,
    setAnkiStatus: clearAnkiStatus,
    handleAddToAnki,
    handleWordToAnki,
    reloadConfig
  };
}
