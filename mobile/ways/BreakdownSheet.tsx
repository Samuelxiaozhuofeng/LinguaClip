// "Break it down for me" bottom sheet (拆开教我 + 听力难点; docs/breakdown.md, android-roadmap.md M2.3).
// Reuses utils/breakdownPrep.ts and utils/aiDrills.ts pure logic directly (never imports desktop components).
// Half-screen drawer expandable to full-screen via swipe on the handle or the expand toggle.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import {
  BREAKDOWN_MIN_WORDS,
  askBreakdown,
  askSounds,
  canCloze,
  soundsOn,
  spaceWords,
  type Breakdown,
  type BreakdownPoint,
} from '../../utils/aiDrills';
import { cachedBreakdown } from '../../utils/breakdownPrep';
import { detectLang, type DictLang } from '../../utils/dictionary';
import { getLang, useT } from '../../utils/i18n';
import { parseSRT } from '../../utils/srtParser';
import { useBackClose } from '../backClose';
import { AUDIO_ENGINE_PLATFORM } from '../platform/audioEngine';
import { prepareSrc, videoSrcFromPath } from '../platform/desktop';
import { CAN_SPEAK_WORD, speakWordAux, stopWordAux } from '../platform/wordPlatform';

export interface BreakdownSheetProps {
  record: VideoRecord;
  line: Subtitle;
  /** The lines around it, for the AI (as desktop hooks/useLookup aroundOf). */
  around?: string;
  onClose: () => void;
  /** Optional callback to play the original line through the caller's audio engine. */
  onPlayLine?: () => void;
  /** Optional language hint for aux pronunciation (auto-detected if omitted). */
  lang?: DictLang | null;
}

const VALID_DICT_LANGS = new Set<string>(['en', 'ja', 'es', 'fr', 'de', 'zh', 'ko', 'it', 'pt', 'ru']);
const toDictLang = (code: string | undefined, fallback: DictLang | null): DictLang | null =>
  code && VALID_DICT_LANGS.has(code) ? (code as DictLang) : fallback;

type SheetState =
  | { status: 'loading' }
  | { status: 'no_ai' }
  | { status: 'too_short' }
  | { status: 'failed' }
  | { status: 'ready'; data: Breakdown; soundsLoading: boolean };

const SpeakerSvg: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={active ? 'animate-pulse' : ''}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

export const BreakdownSheet: React.FC<BreakdownSheetProps> = ({
  record,
  line,
  onClose,
  onPlayLine,
  lang: langProp,
}) => {
  const t = useT();
  useBackClose(true, onClose);
  const [full, setFull] = useState(false);
  const [state, setState] = useState<SheetState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [speakingKey, setSpeakingKey] = useState<string | null>(null);
  const [linePlaying, setLinePlaying] = useState(false);

  const aliveRef = useRef(true);
  const dragStartY = useRef<number | null>(null);
  const webAudioRef = useRef<HTMLAudioElement | null>(null);
  const webTimerRef = useRef<number | null>(null);

  const words = useMemo(() => spaceWords(line.text), [line.text]);
  const detectedLang = useMemo(() => {
    if (langProp !== undefined) return langProp;
    const fromLine = detectLang([line.text]);
    if (fromLine) return fromLine;
    return detectLang(parseSRT(record.subtitleText).slice(0, 20).map(l => l.text));
  }, [langProp, line.text, record.subtitleText]);

  const stopLocalAudio = useCallback(() => {
    if (webTimerRef.current !== null) {
      window.clearTimeout(webTimerRef.current);
      webTimerRef.current = null;
    }
    if (webAudioRef.current) {
      webAudioRef.current.pause();
      webAudioRef.current = null;
    }
    setLinePlaying(false);
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      stopWordAux();
      stopLocalAudio();
    };
  }, [stopLocalAudio]);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    const run = async () => {
      const prepared = await cachedBreakdown(record.id, line.text).catch(() => null);
      if (!live) return;

      if (prepared) {
        const needSounds = soundsOn() && prepared.sounds === undefined && canCloze();
        setState({ status: 'ready', data: prepared, soundsLoading: needSounds });
        if (needSounds) {
          const extra = await askSounds(words, getLang()).catch(() => null);
          if (!live) return;
          setState(prev => (prev.status === 'ready'
            ? { status: 'ready', data: extra ? { ...prev.data, sounds: extra } : prev.data, soundsLoading: false }
            : prev));
        }
        return;
      }

      if (!canCloze()) {
        setState({ status: 'no_ai' });
        return;
      }

      if (words.length < BREAKDOWN_MIN_WORDS) {
        setState({ status: 'too_short' });
        return;
      }

      const fresh = await askBreakdown(words, getLang()).catch(() => null);
      if (!live) return;
      if (!fresh) {
        setState({ status: 'failed' });
        return;
      }
      setState({ status: 'ready', data: fresh, soundsLoading: false });
    };

    void run();
    return () => { live = false; };
  }, [record.id, line.text, words, attempt]);

  const playLang = state.status === 'ready' ? toDictLang(state.data.lang, detectedLang) : detectedLang;

  const speakPhrase = async (key: string, text: string) => {
    if (!CAN_SPEAK_WORD || !playLang) return;
    setSpeakingKey(key);
    await speakWordAux(text, playLang);
    if (aliveRef.current) setSpeakingKey(cur => (cur === key ? null : cur));
  };

  const handlePlayLine = async () => {
    if (onPlayLine) {
      onPlayLine();
      return;
    }
    if (CAN_SPEAK_WORD && playLang) {
      setLinePlaying(true);
      await speakWordAux(line.text, playLang);
      if (aliveRef.current) setLinePlaying(false);
      return;
    }
    if (AUDIO_ENGINE_PLATFORM === 'web' && record.videoPath) {
      stopLocalAudio();
      try {
        await prepareSrc(record.videoPath);
        if (!aliveRef.current) return;
        const audio = new Audio(videoSrcFromPath(record.videoPath));
        webAudioRef.current = audio;
        audio.currentTime = Math.max(0, line.startTime);
        setLinePlaying(true);
        await audio.play();
        const ms = Math.max(300, Math.round((line.endTime - line.startTime) * 1000));
        webTimerRef.current = window.setTimeout(() => {
          stopLocalAudio();
        }, ms);
      } catch {
        stopLocalAudio();
      }
    }
  };

  const onHandlePointerDown = (e: React.PointerEvent) => {
    dragStartY.current = e.clientY;
  };
  const onHandlePointerUp = (e: React.PointerEvent) => {
    if (dragStartY.current === null) return;
    const dy = e.clientY - dragStartY.current;
    dragStartY.current = null;
    if (dy < -36) setFull(true);
    else if (dy > 36) {
      if (full) setFull(false);
      else onClose();
    }
  };

  const renderHighlightedLine = (points?: BreakdownPoint[]) => {
    if (!points?.length) return line.text;
    const inPoint = new Set<number>();
    for (const p of points) {
      for (let i = p.from; i <= p.to; i++) inPoint.add(i);
    }
    return words.map((w, i) => (
      <React.Fragment key={i}>
        {i > 0 ? ' ' : ''}
        <span className={inPoint.has(i) ? 'underline decoration-accent/70 decoration-2 underline-offset-4' : undefined}>
          {w}
        </span>
      </React.Fragment>
    ));
  };

  const sounds = state.status === 'ready' && soundsOn() ? (state.data.sounds ?? []) : [];
  const canPlayOrig = !!onPlayLine || (CAN_SPEAK_WORD && !!playLang) || (AUDIO_ENGINE_PLATFORM === 'web' && !!record.videoPath);

  return (
    <div
      className="fixed inset-0 z-40 flex flex-col justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={t('m.breakdownTitle')}
      data-testid="breakdown-sheet"
    >
      <button
        type="button"
        aria-label={t('m.close')}
        className="absolute inset-0 bg-black/25"
        onClick={onClose}
      />

      <div
        className={`relative bg-page rounded-t-[22px] shadow-lift flex flex-col transition-all duration-200 ${
          full
            ? 'h-[90vh] supports-[height:1dvh]:h-[90dvh]'
            : 'max-h-[68vh] supports-[height:1dvh]:max-h-[68dvh]'
        }`}
      >
        <div
          onPointerDown={onHandlePointerDown}
          onPointerUp={onHandlePointerUp}
          onClick={() => setFull(v => !v)}
          className="pt-2.5 pb-1 flex flex-col items-center cursor-ns-resize touch-none shrink-0"
        >
          <div className="w-10 h-[5px] rounded-full bg-line" />
        </div>

        <div className="px-5 pb-2.5 flex items-center gap-2 border-b border-shade shrink-0">
          <h2 className="text-[17px] font-semibold text-ink flex-1 truncate">{t('m.breakdownTitle')}</h2>
          {canPlayOrig && (
            <button
              type="button"
              onClick={() => { void handlePlayLine(); }}
              className={`min-h-[44px] px-3.5 rounded-full text-xs font-medium shrink-0 ${
                linePlaying ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
              }`}
            >
              ▶ {t('m.breakdownOrigLine')}
            </button>
          )}
          <button
            type="button"
            onClick={() => setFull(v => !v)}
            aria-label={t(full ? 'm.breakdownCollapse' : 'm.breakdownExpand')}
            className="w-11 h-11 rounded-full text-mute flex items-center justify-center text-base shrink-0"
          >
            {full ? '⤡' : '⤢'}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('m.close')}
            className="w-11 h-11 -mr-2 text-mute text-xl flex items-center justify-center shrink-0"
          >
            ×
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-4">
          <div className="rounded-2xl bg-paper px-4 py-3.5 border border-shade">
            <p className="font-serif text-[19px] leading-relaxed text-ink">
              {state.status === 'ready' ? renderHighlightedLine(state.data.points) : line.text}
            </p>
          </div>

          {state.status === 'loading' && (
            <p className="py-4 text-sm text-mute text-center" role="status">
              {t('m.breakdownLoading')}
            </p>
          )}

          {state.status === 'no_ai' && (
            <p className="rounded-xl bg-shade px-4 py-3.5 text-sm text-mute leading-relaxed" role="status">
              {t('m.breakdownNoAi')}
            </p>
          )}

          {state.status === 'too_short' && (
            <p className="rounded-xl bg-shade px-4 py-3.5 text-sm text-mute leading-relaxed" role="status">
              {t('m.breakdownTooShort')}
            </p>
          )}

          {state.status === 'failed' && (
            <div className="rounded-xl bg-accent-soft/70 px-4 py-3.5 flex items-center justify-between gap-3">
              <p className="text-sm text-ink leading-relaxed">{t('m.breakdownFail')}</p>
              <button
                type="button"
                onClick={() => setAttempt(n => n + 1)}
                className="min-h-[44px] px-4 rounded-[10px] bg-ink text-white text-sm font-medium shrink-0"
              >
                {t('m.retry')}
              </button>
            </div>
          )}

          {state.status === 'ready' && (
            <>
              <section className="flex flex-col gap-2.5">
                <h3 className="text-xs font-medium text-mute tracking-wide">{t('m.breakdownPoints')}</h3>
                {state.data.points.map((p, idx) => {
                  const phrase = words.slice(p.from, p.to + 1).join(' ');
                  const key = `p-${idx}`;
                  return (
                    <div key={key} className="rounded-xl bg-paper border border-shade px-4 py-3 flex items-start gap-2.5">
                      <div className="flex-1 min-w-0 flex flex-col gap-1">
                        <span className="font-serif text-[17px] font-semibold text-ink">{phrase}</span>
                        <p className="text-[14px] text-ink/85 leading-relaxed">{p.note}</p>
                      </div>
                      {CAN_SPEAK_WORD && playLang && (
                        <button
                          type="button"
                          onClick={() => { void speakPhrase(key, phrase); }}
                          aria-label={`${t('m.speakWord')}: ${phrase}`}
                          className={`w-11 h-11 shrink-0 rounded-[10px] inline-flex items-center justify-center ${
                            speakingKey === key ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'
                          }`}
                        >
                          <SpeakerSvg active={speakingKey === key} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </section>

              {soundsOn() && (sounds.length > 0 || state.soundsLoading) && (
                <section className="rounded-2xl bg-shade px-4 py-3.5 flex flex-col gap-2.5" data-testid="breakdown-sounds">
                  <h3 className="text-xs font-medium text-mute">{t('studio.soundsTitle')}</h3>
                  {state.soundsLoading && sounds.length === 0 ? (
                    <p className="text-[13px] text-mute" role="status">{t('m.breakdownSoundsLoading')}</p>
                  ) : (
                    sounds.map((s, idx) => {
                      const span = words.slice(s.from, s.to + 1).join(' ');
                      const key = `s-${idx}`;
                      return (
                        <div key={key} className="flex items-start gap-2">
                          <p className="flex-1 min-w-0 text-[14px] leading-relaxed text-ink">
                            <span className="font-semibold text-accent">{span}</span>
                            {' · '}
                            {s.note}
                          </p>
                          {CAN_SPEAK_WORD && playLang && (
                            <button
                              type="button"
                              onClick={() => { void speakPhrase(key, span); }}
                              aria-label={`${t('m.speakWord')}: ${span}`}
                              className={`w-10 h-10 shrink-0 rounded-[10px] inline-flex items-center justify-center ${
                                speakingKey === key ? 'bg-accent-soft text-accent' : 'bg-page text-ink'
                              }`}
                            >
                              <SpeakerSvg active={speakingKey === key} />
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
