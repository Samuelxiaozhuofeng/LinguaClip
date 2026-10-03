import React, { useState } from 'react';
import { useLang, useT } from '../utils/i18n';
import { getWeekStats } from '../utils/storage';
import { getDays } from '../utils/today';

// The home screen's practice line: 7 thin bars (oldest → today) plus "practised d of the
// last 7 days · today m min · n remembered" (docs/stats.md). Switched off in settings, it is
// the old one-line "Today: 12 min · 18 lines · 34 lines remembered". Read once on entering home.
const WeekStats: React.FC<{ remembered: number }> = ({ remembered }) => {
  const t = useT();
  const lang = useLang();
  const [on] = useState(getWeekStats);
  const [days] = useState(() => getDays());
  const today = days[days.length - 1];
  const min = (sec: number) => Math.floor(sec / 60);

  if (!on) {
    // Each part only once it's above zero.
    const todayWhat = [today.sec >= 60 && t('home.todayMin', { n: min(today.sec) }), today.lines && t('home.reviewLine', { n: today.lines })].filter(Boolean).join(' · ');
    const stats = [todayWhat && t('home.today', { what: todayWhat }), remembered > 0 && t('home.remembered', { n: remembered })].filter(Boolean).join(' · ');
    return stats ? <span title={t('home.rememberedTitle')}>{stats}</span> : null;
  }

  const practised = days.filter(d => d.sec >= 60).length;
  const text = [practised > 0 && t('home.weekDays', { n: practised }), today.sec >= 60 && t('home.todayMinOnly', { n: min(today.sec) }), remembered > 0 && t('home.remembered', { n: remembered })].filter(Boolean).join(' · ');
  const top = Math.max(...days.map(d => min(d.sec)));
  const weekday = new Intl.DateTimeFormat(lang === 'zh' ? 'zh-CN' : 'en', { weekday: 'short' });
  return (
    <span className="flex items-center gap-3">
      <span className="flex items-end gap-[3px] h-5">
        {days.map((d, i) => {
          const [y, m, day] = d.date.split('-').map(Number);
          const h = top > 0 && min(d.sec) > 0 ? Math.max(3, Math.round(min(d.sec) / top * 20)) : 2;
          return (
            <span key={d.date} title={t('home.dayTip', { day: weekday.format(new Date(y, m - 1, day)), min: min(d.sec), lines: d.lines })}
              className={`w-[5px] rounded-full ${h <= 2 ? 'bg-line' : i === days.length - 1 ? 'bg-accent' : 'bg-mute/50'}`} style={{ height: h }} />
          );
        })}
      </span>
      {text && <span title={t('home.rememberedTitle')}>{text}</span>}
    </span>
  );
};

export default WeekStats;
