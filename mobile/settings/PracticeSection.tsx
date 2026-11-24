// Settings → Practice section (docs/android-roadmap.md M2.1):
// toggles for Home "Today" panel & "This week" stats (practice_config) and each of the
// four ways under "More" on the study page (mobile/phoneWays.ts).
import React, { useEffect, useState } from 'react';
import { useT } from '../../utils/i18n';
import { getAIConfig, getEndpoint, saveAIConfig } from '../../utils/aiConfig';
import { getTodayBar, getWeekStats, setPracticeFlag } from '../../utils/storage';
import { AI_WAYS, isWayOn, MORE_WAY_DESC_KEY, setWayOn, subscribeWays, WAY_LABEL_KEY } from '../phoneWays';
import { MORE_WAYS, type PhoneWay } from '../ways/types';
import { sheet } from '../ui';

export const PracticeSection: React.FC = () => {
  const t = useT();
  const [todayOn, setTodayOn] = useState(getTodayBar);
  const [weekOn, setWeekOn] = useState(getWeekStats);
  const [, bumpWays] = useState(0);
  const [aiCfg, setAiCfg] = useState(getAIConfig);
  // Same AI config fields as the desktop's Settings → AI (keywordPrep.keywordsOn / phrasePrep.phrasesOn).
  const toggleAi = (k: 'autoKeywords' | 'autoPhrases', on: boolean) => {
    const next = { ...getAIConfig(), [k]: on };
    saveAIConfig(next);
    setAiCfg(next);
  };
  const aiReady = !!getEndpoint();

  useEffect(() => subscribeWays(() => bumpWays(n => n + 1)), []);

  const toggleToday = (on: boolean) => {
    setTodayOn(on);
    setPracticeFlag('todayBar', on);
  };
  const toggleWeek = (on: boolean) => {
    setWeekOn(on);
    setPracticeFlag('weekStats', on);
  };
  const toggleWay = (w: PhoneWay, on: boolean) => {
    setWayOn(w, on);
  };

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-mute">{t('m.practiceTitle')}</p>
      <div className={`${sheet} flex flex-col`}>
        <label className="px-4 py-3.5 min-h-[52px] flex items-center justify-between gap-3 border-b border-shade">
          <span className="text-[15px]">{t('m.practiceTodayBar')}</span>
          <input
            type="checkbox"
            checked={todayOn}
            className="w-5 h-5 shrink-0 accent-accent"
            onChange={e => toggleToday(e.target.checked)}
          />
        </label>
        <label className="px-4 py-3.5 min-h-[52px] flex items-center justify-between gap-3">
          <span className="text-[15px]">{t('m.practiceWeekStats')}</span>
          <input
            type="checkbox"
            checked={weekOn}
            className="w-5 h-5 shrink-0 accent-accent"
            onChange={e => toggleWeek(e.target.checked)}
          />
        </label>
      </div>

      <p className="text-[13px] text-mute mt-1">{t('m.practiceMoreGroup')}</p>
      <div className={`${sheet} flex flex-col`}>
        {MORE_WAYS.map(w => {
          const needAi = AI_WAYS.includes(w) && !getEndpoint();
          const descKey = MORE_WAY_DESC_KEY[w as keyof typeof MORE_WAY_DESC_KEY];
          const hint = needAi ? t('m.practiceNeedAiKey') : descKey ? t(descKey) : '';
          return (
            <label
              key={w}
              className="px-4 py-3.5 min-h-[52px] flex items-center justify-between gap-3 border-b border-shade last:border-0"
            >
              <span className="flex flex-col gap-0.5 min-w-0">
                <span className="text-[15px]">{t(WAY_LABEL_KEY[w])}</span>
                {hint && <span className="text-xs text-mute">{hint}</span>}
              </span>
              <input
                type="checkbox"
                checked={isWayOn(w)}
                className="w-5 h-5 shrink-0 accent-accent"
                onChange={e => toggleWay(w, e.target.checked)}
              />
            </label>
          );
        })}
      </div>

      <div className={`${sheet} flex flex-col`}>
        {(['autoKeywords', 'autoPhrases'] as const).map(k => (
          <label key={k} className="px-4 py-3.5 min-h-[52px] flex items-center justify-between gap-3 border-b border-shade last:border-0">
            <span className="flex flex-col gap-0.5 min-w-0">
              <span className="text-[15px]">{t(k === 'autoKeywords' ? 'settingsAI.autoKeywords' : 'settingsAI.autoPhrases')}</span>
              {!aiReady && <span className="text-xs text-mute">{t('m.practiceNeedAiKey')}</span>}
            </span>
            <input
              type="checkbox"
              checked={aiCfg[k] === true}
              disabled={!aiReady}
              className="w-5 h-5 shrink-0 accent-accent"
              onChange={e => toggleAi(k, e.target.checked)}
            />
          </label>
        ))}
      </div>
    </section>
  );
};
