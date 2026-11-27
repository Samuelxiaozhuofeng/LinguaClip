// Unified full-screen study page for one record (docs/android-roadmap.md M2.1, docs/android.md「手机学习闭环」).
// Owns the shared header (back, title, section/line position), the way switcher
// ("Listen | Dictation" + "More ▾" drawer), shared Japanese dictionary banner,
// no-audio read-only fallback, position continuity across ways via linguaclip_watch_pos,
// desktop progress/way fallback via resumePos.ts, and the app-wide practice clock.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { detectLang } from '../utils/dictionary';
import { useT } from '../utils/i18n';
import { loadJa } from '../utils/japanese';
import { parseSRT } from '../utils/srtParser';
import { buildSections, sectionLengthOf } from '../utils/sections';
import { setWatchPos } from '../utils/storage';
import { usePracticeClock } from '../utils/today';
import { useRecordAudio } from './audioAvail';
import { JaBanner } from './JaBanner';
import {
  lineNumberAt,
  MORE_WAY_DESC_KEY,
  moreWaysOn,
  setPhoneLastWay,
  subscribeWays,
  WAY_LABEL_KEY,
} from './phoneWays';
import { resumeSecOf, resumeWayOf } from './resumePos';
import { WAY_VIEWS } from './ways/registry';
import { MAIN_WAYS, MORE_WAYS, type PhoneWay } from './ways/types';
import { useBackClose } from './backClose';

const SWITCH_TOAST_MS = 1800;
const NO_AUDIO_TOAST_MS = 3200;

export const Study: React.FC<{
  record: VideoRecord;
  onBack: () => void;
  onReview?: () => void;
}> = ({ record, onBack, onReview }) => {
  const t = useT();
  usePracticeClock();

  const lines = useMemo(
    () => [...parseSRT(record.subtitleText)].sort((a, b) => a.startTime - b.startTime),
    [record.subtitleText],
  );
  const sections = useMemo(
    () => buildSections(lines, sectionLengthOf(record)),
    [lines], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const sectionOf = useMemo(
    () => new Map(sections.flatMap((s, i) => s.subtitles.map(l => [l.id, i] as const))),
    [sections],
  );

  const lang = useMemo(() => detectLang(lines.map(l => l.text)), [lines]);
  const ja = lang === 'ja';
  useEffect(() => { if (ja) void loadJa(); }, [ja]);

  const audioAvail = useRecordAudio(record);
  const noAudio = audioAvail === false;

  const initialPos = useMemo(() => resumeSecOf(record, lines), [record.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [way, setWay] = useState<PhoneWay>(() => resumeWayOf(record));
  const [startSec, setStartSec] = useState<number>(initialPos);
  const [lineInfo, setLineInfo] = useState<{ n: number; total: number }>(() => ({
    n: lineNumberAt(lines, initialPos),
    total: lines.length,
  }));
  const [moreOpen, setMoreOpen] = useState(false);
  useBackClose(moreOpen, () => setMoreOpen(false));
  const [moreList, setMoreList] = useState<PhoneWay[]>(moreWaysOn);
  const [toast, setToast] = useState<string | null>(null);

  const posRef = useRef(initialPos);
  const prevRecordIdRef = useRef(record.id);
  const toastTimer = useRef<number | null>(null);

  useEffect(() => subscribeWays(() => setMoreList(moreWaysOn())), []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  // Keep local state in sync only when switching to a different record.
  useEffect(() => {
    if (prevRecordIdRef.current === record.id) return;
    prevRecordIdRef.current = record.id;
    const pos = resumeSecOf(record, lines);
    posRef.current = pos;
    setStartSec(pos);
    setWay(resumeWayOf(record));
    setLineInfo({ n: lineNumberAt(lines, pos), total: lines.length });
  }, [record, lines]);

  const showToast = useCallback((msg: string, ms = SWITCH_TOAST_MS) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, ms);
  }, []);

  const handlePos = useCallback((sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return;
    posRef.current = sec;
    setWatchPos(record.id, sec);
  }, [record.id]);

  const handleLine = useCallback((n: number, total: number) => {
    const safeTotal = Math.max(0, total);
    const safeN = safeTotal > 0 ? Math.min(Math.max(n, 1), safeTotal) : 0;
    setLineInfo(prev => (prev.n === safeN && prev.total === safeTotal ? prev : { n: safeN, total: safeTotal }));
  }, []);

  const activeWay: PhoneWay = noAudio ? 'read' : way;

  const switchTo = (nextWay: PhoneWay) => {
    setMoreOpen(false);
    if (noAudio && nextWay !== 'read') {
      showToast(t('m.w4NoAudioBanner'), NO_AUDIO_TOAST_MS);
      return;
    }
    if (nextWay === activeWay) return;
    const curPos = posRef.current;
    setPhoneLastWay(record.id, nextWay);
    setWatchPos(record.id, curPos);
    setStartSec(curPos);
    setWay(nextWay);

    const n = lineInfo.total > 0 ? lineInfo.n : lineNumberAt(lines, curPos);
    const label = t(WAY_LABEL_KEY[nextWay]);
    showToast(n > 0 ? t('m.switchedWay', { way: label, n }) : t('m.switchedWayPlain', { way: label }));
  };

  const secIdx = useMemo(() => {
    if (sections.length <= 1 || lineInfo.n < 1) return -1;
    const line = lines[lineInfo.n - 1];
    return line ? (sectionOf.get(line.id) ?? -1) : -1;
  }, [sections.length, lines, lineInfo.n, sectionOf]);

  const posText = lineInfo.total > 0
    ? secIdx >= 0
      ? t('m.studyPosSec', { sec: secIdx + 1, n: lineInfo.n, total: lineInfo.total })
      : t('m.studyPos', { n: lineInfo.n, total: lineInfo.total })
    : '';

  const isMoreActive = MORE_WAYS.includes(activeWay);
  const drawerWays = useMemo(
    () => (noAudio && !moreList.includes('read') ? [...moreList, 'read' as PhoneWay] : moreList),
    [noAudio, moreList],
  );
  const readyToMount = audioAvail !== null || activeWay === 'read';
  const View = WAY_VIEWS[activeWay];

  return (
    <div className="fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <header className="pt-2 px-3 pb-1 flex items-center gap-1 shrink-0">
        <button
          type="button"
          aria-label={t('m.back')}
          onClick={onBack}
          className="w-11 h-11 shrink-0 flex items-center justify-center text-2xl"
        >
          ‹
        </button>
        <div className="flex-1 min-w-0 flex flex-col">
          <h1 className="text-[15px] font-semibold truncate">{record.displayName}</h1>
          {posText && <span data-testid="study-pos" className="text-xs text-mute tabular-nums truncate">{posText}</span>}
        </div>
      </header>

      <div className="px-4 pb-2 flex items-center gap-2 shrink-0">
        <div className="inline-flex items-center bg-page rounded-full p-0.5 shadow-card" role="tablist" aria-label={t('m.practiceTitle')}>
          {MAIN_WAYS.map(w => {
            const active = activeWay === w;
            const locked = noAudio && w !== 'read';
            return (
              <button
                key={w}
                type="button"
                role="tab"
                aria-selected={active}
                data-locked={locked || undefined}
                onClick={() => switchTo(w)}
                className={`min-h-[44px] px-4 rounded-full text-[13px] whitespace-nowrap ${
                  active ? 'bg-ink text-white font-medium' : locked ? 'text-mute/50' : 'text-mute'
                }`}
              >
                {t(WAY_LABEL_KEY[w])}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(true)}
          className={`min-h-[44px] px-3.5 rounded-full text-[13px] whitespace-nowrap shadow-card flex items-center gap-1 ${isMoreActive ? 'bg-ink text-white font-medium' : 'bg-page text-mute'}`}
        >
          <span>{isMoreActive ? t(WAY_LABEL_KEY[activeWay]) : t('m.moreWays')}</span>
          <span aria-hidden className="text-[11px] leading-none">▾</span>
        </button>
      </div>

      {noAudio && (
        <p
          role="status"
          data-testid="study-no-audio-banner"
          className="mx-4 mb-2 px-3.5 py-2.5 rounded-xl bg-page shadow-card text-[13px] text-mute leading-snug shrink-0"
        >
          {t('m.w4NoAudioBanner')}
        </p>
      )}

      {ja && <JaBanner />}

      {toast && (
        <p
          role="status"
          data-testid="way-switch-toast"
          className="fixed left-1/2 -translate-x-1/2 max-w-[calc(100vw-32px)] top-[calc(env(safe-area-inset-top)+112px)] z-30 px-4 py-2 rounded-2xl bg-ink text-white text-[13px] text-center shadow-lift pointer-events-none"
        >
          {toast}
        </p>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        {readyToMount && (
          <View
            key={`${record.id}:${activeWay}`}
            record={record}
            startSec={startSec}
            onPos={handlePos}
            onLine={handleLine}
            noAudio={noAudio}
            onExit={onBack}
            onReview={onReview}
          />
        )}
      </div>

      {moreOpen && (
        <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-label={t('m.moreWaysTitle')}>
          <button
            type="button"
            aria-label={t('m.close')}
            className="absolute inset-0 bg-black/30"
            onClick={() => setMoreOpen(false)}
          />
          <div className="relative max-h-[80vh] supports-[height:1dvh]:max-h-[80dvh] overflow-y-auto bg-page rounded-t-[22px] shadow-lift px-5 pt-5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-3">
            <h2 className="text-[17px] font-semibold">{t('m.moreWaysTitle')}</h2>
            {drawerWays.length === 0 ? (
              <p className="py-4 text-sm text-mute text-center">{t('m.moreWaysAllOff')}</p>
            ) : (
              <div className="flex flex-col divide-y divide-shade">
                {drawerWays.map(w => {
                  const selected = activeWay === w;
                  const locked = noAudio && w !== 'read';
                  const descKey = MORE_WAY_DESC_KEY[w as keyof typeof MORE_WAY_DESC_KEY];
                  return (
                    <button
                      key={w}
                      type="button"
                      data-locked={locked || undefined}
                      onClick={() => switchTo(w)}
                      className={`w-full min-h-[56px] py-3 text-left flex items-center justify-between gap-3 ${locked ? 'opacity-50' : ''}`}
                    >
                      <span className="flex flex-col gap-0.5 min-w-0">
                        <span className={`text-[15px] ${selected ? 'font-semibold text-accent' : 'font-medium text-ink'}`}>
                          {t(WAY_LABEL_KEY[w])}
                        </span>
                        {descKey && <span className="text-xs text-mute">{t(descKey)}</span>}
                      </span>
                      {selected && <span className="text-accent font-semibold shrink-0" aria-hidden>✓</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
