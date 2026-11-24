// Phone home's "Today" panel & "This week" stats card (docs/android-roadmap.md M2.1 & docs/stats.md).
// Controlled by practice_config.todayBar and practice_config.weekStats; switched off = renders nothing.
import React, { useMemo } from 'react';
import type { VideoRecord } from '../types';
import { useLang, useT } from '../utils/i18n';
import { parseSRT } from '../utils/srtParser';
import { getTodayBar, getWatchPos, getWeekStats } from '../utils/storage';
import { getDays, getToday } from '../utils/today';
import { getPhoneLastWay, lineNumberAt, WAY_LABEL_KEY } from './phoneWays';
import { sheet } from './ui';

export const TodayPanel: React.FC<{
  due: number;
  last?: VideoRecord;
  onReview: () => void;
  onOpen: (id: string) => void;
  onPodcast: () => void;
}> = ({ due, last, onReview, onOpen, onPodcast }) => {
  const t = useT();
  const on = getTodayBar();
  const lastLines = useMemo(() => (last?.subtitleText ? parseSRT(last.subtitleText) : []), [last?.id, last?.subtitleText]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!on) return null;

  const today = getToday();
  const todayMin = Math.floor(today.sec / 60);
  const reviewMin = Math.max(1, Math.ceil(due * 0.5));
  const lastWay = last ? getPhoneLastWay(last.id) : null;
  const lastLineNum = last ? lineNumberAt(lastLines, getWatchPos(last.id)) : 0;

  return (
    <section aria-label={t('home.todayLabel')} className="flex flex-col gap-2">
      <p className="text-[13px] text-mute tabular-nums">
        {t('m.todayHead', { min: todayMin, lines: today.lines })}
      </p>
      <div className={`${sheet} shadow-card flex flex-col divide-y divide-shade overflow-hidden`}>
        {due > 0 && (
          <button
            type="button"
            onClick={onReview}
            className="w-full min-h-[56px] px-4 py-3 text-left flex items-center gap-3 active:bg-shade/60"
          >
            <span className="w-2 h-2 rounded-full bg-accent shrink-0" aria-hidden />
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-[15px] font-medium text-ink truncate">
                {t('m.todayReview', { n: due, min: reviewMin })}
              </span>
              <span className="text-xs text-mute truncate">{t('m.todayReviewSub')}</span>
            </span>
            <span className="text-lg text-mute shrink-0" aria-hidden>›</span>
          </button>
        )}
        {last && lastWay && (
          <button
            type="button"
            onClick={() => onOpen(last.id)}
            className="w-full min-h-[56px] px-4 py-3 text-left flex items-center gap-3 active:bg-shade/60"
          >
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-[15px] font-medium text-ink truncate">
                {t('m.todayContinue', { name: last.displayName })}
              </span>
              <span className="text-xs text-mute truncate">
                {lastLineNum > 0
                  ? t('m.todayContinueLine', { way: t(WAY_LABEL_KEY[lastWay]), n: lastLineNum })
                  : t(WAY_LABEL_KEY[lastWay])}
              </span>
            </span>
            <span className="text-lg text-mute shrink-0" aria-hidden>›</span>
          </button>
        )}
        <button
          type="button"
          onClick={onPodcast}
          className="w-full min-h-[56px] px-4 py-3 text-left flex items-center gap-3 active:bg-shade/60"
        >
          <span className="flex-1 min-w-0 flex flex-col gap-0.5">
            <span className="text-[15px] font-medium text-ink truncate">{t('m.todayNew')}</span>
            <span className="text-xs text-mute truncate">{t('m.todayNewSub')}</span>
          </span>
          <span className="text-lg text-mute shrink-0" aria-hidden>›</span>
        </button>
      </div>
    </section>
  );
};

export const WeekCard: React.FC<{ remembered: number }> = ({ remembered }) => {
  const t = useT();
  const lang = useLang();
  if (!getWeekStats()) return null;

  const days = getDays(7);
  const practised = days.filter(d => d.sec >= 60).length;
  const top = Math.max(...days.map(d => d.sec), 0);
  const labelFmt = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { weekday: lang === 'zh' ? 'narrow' : 'short' });
  const tipFmt = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { weekday: 'short' });

  return (
    <section aria-label={t('m.weekTitle')} className={`${sheet} shadow-card p-4 flex flex-col gap-3`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{t('m.weekTitle')}</span>
        <span className="text-xs text-mute tabular-nums">
          {t('m.weekSummary', { days: practised, n: remembered })}
        </span>
      </div>
      <div className="grid grid-cols-7 gap-2 items-end pt-1">
        {days.map((d, i) => {
          const [y, m, day] = d.date.split('-').map(Number);
          const date = new Date(y, m - 1, day);
          const isToday = i === days.length - 1;
          const mins = Math.floor(d.sec / 60);
          const h = top > 0 && d.sec > 0 ? Math.max(8, Math.round((d.sec / top) * 48)) : 4;
          const barColor = isToday ? 'bg-accent' : d.sec > 0 ? 'bg-faint' : 'bg-line';
          return (
            <div
              key={d.date}
              title={t('home.dayTip', { day: tipFmt.format(date), min: mins, lines: d.lines })}
              className="flex flex-col items-center gap-1.5"
            >
              <div className="h-12 w-full flex items-end justify-center">
                <span className={`w-2.5 rounded-full ${barColor}`} style={{ height: h }} />
              </div>
              <span className={`text-[11px] leading-none ${isToday ? 'text-ink font-semibold' : 'text-mute'}`}>
                {labelFmt.format(date)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
};
