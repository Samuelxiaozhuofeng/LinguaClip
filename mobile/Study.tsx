// Unified full-screen study page for one record (docs/android-roadmap.md M2.1).
// Owns the shared header (back, title, section/line position), the way switcher
// ("Listen | Dictation" + "More ▾" drawer), position continuity across ways via
// linguaclip_watch_pos, and the app-wide practice clock.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { parseSRT } from '../utils/srtParser';
import { buildSections, sectionLengthOf } from '../utils/sections';
import { getWatchPos, setWatchPos } from '../utils/storage';
import { usePracticeClock } from '../utils/today';
import {
  getPhoneLastWay,
  lineNumberAt,
  MORE_WAY_DESC_KEY,
  moreWaysOn,
  setPhoneLastWay,
  subscribeWays,
  WAY_LABEL_KEY,
} from './phoneWays';
import { WAY_VIEWS } from './ways/registry';
import { MAIN_WAYS, MORE_WAYS, type PhoneWay } from './ways/types';
import { useBackClose } from './backClose';

const SWITCH_TOAST_MS = 1600;

export const Study: React.FC<{
  record: VideoRecord;
  onBack: () => void;
}> = ({ record, onBack }) => {
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

  const initialPos = useMemo(() => getWatchPos(record.id), [record.id]);
  const [way, setWay] = useState<PhoneWay>(() => getPhoneLastWay(record.id));
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
  const toastTimer = useRef<number | null>(null);

  useEffect(() => subscribeWays(() => setMoreList(moreWaysOn())), []);
  useEffect(() => () => { if (toastTimer.current) window.clearTimeout(toastTimer.current); }, []);

  // Keep local state in sync if the record prop changes.
  useEffect(() => {
    const pos = getWatchPos(record.id);
    posRef.current = pos;
    setStartSec(pos);
    setWay(getPhoneLastWay(record.id));
    setLineInfo({ n: lineNumberAt(lines, pos), total: lines.length });
  }, [record.id, lines]);

  const handlePos = useCallback((sec: number) => {
    if (!Number.isFinite(sec) || sec < 0) return;
    posRef.current = sec;
    setWatchPos(record.id, sec);
  }, [record.id]);

  const handleLine = useCallback((n: number, total: number) => {
    setLineInfo(prev => (prev.n === n && prev.total === total ? prev : { n, total }));
  }, []);

  const switchTo = (nextWay: PhoneWay) => {
    setMoreOpen(false);
    if (nextWay === way) return;
    const curPos = posRef.current;
    setPhoneLastWay(record.id, nextWay);
    setWatchPos(record.id, curPos);
    setStartSec(curPos);
    setWay(nextWay);

    const n = lineInfo.total > 0 ? lineInfo.n : lineNumberAt(lines, curPos);
    const label = t(WAY_LABEL_KEY[nextWay]);
    setToast(n > 0 ? t('m.switchedWay', { way: label, n }) : t('m.switchedWayPlain', { way: label }));
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => {
      toastTimer.current = null;
      setToast(null);
    }, SWITCH_TOAST_MS);
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

  const isMoreActive = MORE_WAYS.includes(way);
  const View = WAY_VIEWS[way];

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
          {posText && <span className="text-xs text-mute tabular-nums truncate">{posText}</span>}
        </div>
      </header>

      <div className="px-4 pb-2 flex items-center gap-2 shrink-0">
        <div className="inline-flex items-center bg-page rounded-full p-0.5 shadow-card" role="tablist" aria-label={t('m.practiceTitle')}>
          {MAIN_WAYS.map(w => {
            const active = way === w;
            return (
              <button
                key={w}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => switchTo(w)}
                className={`min-h-[44px] px-4 rounded-full text-[13px] whitespace-nowrap ${active ? 'bg-ink text-white font-medium' : 'text-mute'}`}
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
          <span>{isMoreActive ? t(WAY_LABEL_KEY[way]) : t('m.moreWays')}</span>
          <span aria-hidden className="text-[11px] leading-none">▾</span>
        </button>
      </div>

      {toast && (
        <p
          role="status"
          data-testid="way-switch-toast"
          className="fixed left-1/2 -translate-x-1/2 top-[calc(env(safe-area-inset-top)+112px)] z-30 px-4 py-2 rounded-full bg-ink text-white text-[13px] whitespace-nowrap shadow-lift pointer-events-none"
        >
          {toast}
        </p>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        <View
          key={`${record.id}:${way}`}
          record={record}
          startSec={startSec}
          onPos={handlePos}
          onLine={handleLine}
          onExit={onBack}
        />
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
            {moreList.length === 0 ? (
              <p className="py-4 text-sm text-mute text-center">{t('m.moreWaysAllOff')}</p>
            ) : (
              <div className="flex flex-col divide-y divide-shade">
                {moreList.map(w => {
                  const selected = way === w;
                  const descKey = MORE_WAY_DESC_KEY[w as keyof typeof MORE_WAY_DESC_KEY];
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => switchTo(w)}
                      className="w-full min-h-[56px] py-3 text-left flex items-center justify-between gap-3"
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
