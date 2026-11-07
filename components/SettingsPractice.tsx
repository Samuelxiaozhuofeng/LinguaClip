import React, { useState } from 'react';
import { Field, Group, Seg } from './ui';
import { useT } from '../utils/i18n';
import { JaDictRow } from './JaSetup';
import { refreshShortcuts } from '../utils/shortcuts';
import { getWatchPrefs, saveWatchPrefs, LISTEN_TRIES, getWeekStats, getTodayBar, getLooseJudge, getSubtitleMaskOn, setPracticeFlag } from '../utils/storage';

interface SettingsPracticeProps {
  sectionLength: number;
  setSectionLength: (value: number) => void;
}

// Settings → Practice: how a video is cut into sections, how dictation is judged, the hard-subtitle cover, intensive listening's hard-line plays, Japanese splitting, and the home screen's "Today" bar and week.
const SettingsPractice: React.FC<SettingsPracticeProps> = ({
  sectionLength,
  setSectionLength,
}) => {
  const t = useT();
  const [tries, setTries] = useState(() => getWatchPrefs().listenTries);
  const [week, setWeek] = useState(getWeekStats);
  const [today, setToday] = useState(getTodayBar);
  const [lenient, setLenient] = useState(getLooseJudge);
  const [mask, setMaskOn] = useState(getSubtitleMaskOn);
  const SECTION_OPTS = [
    { value: 0, label: t('settingsGeneral.optFull') },
    { value: 1, label: '1' },
    { value: 2, label: '2' },
    { value: 3, label: '3' },
    { value: 4, label: '4' },
    { value: 5, label: '5' },
    { value: 10, label: t('settingsGeneral.opt10min') },
  ];
  return (
    <div className="space-y-10">
      <Group title={t('settings.group.sections')}>
        <Field
          label={t('settingsGeneral.sectionLength')}
          hint={
            sectionLength === 0
              ? t('settingsGeneral.sectionLengthHintFull')
              : t('settingsGeneral.sectionLengthHint', { n: sectionLength })
          }
        >
          <Seg options={SECTION_OPTS} value={sectionLength} onChange={setSectionLength} className="flex-wrap" />
        </Field>
      </Group>

      <Group title={t('settings.group.dictation')}>
        <div>
          <label className="flex items-center gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={lenient} onChange={e => { setLenient(e.target.checked); setPracticeFlag('looseJudge', e.target.checked); }} className="w-4 h-4 accent-accent" />
            {t('settingsGeneral.looseJudge')}
          </label>
          <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('settingsGeneral.looseJudgeHint')}</p>
        </div>
        <div>
          <label className="flex items-center gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={mask} onChange={e => { setMaskOn(e.target.checked); setPracticeFlag('subtitleMask', e.target.checked); refreshShortcuts(); }} className="w-4 h-4 accent-accent" />
            {t('settingsGeneral.subtitleMask')}
          </label>
          <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('settingsGeneral.subtitleMaskHint')}</p>
        </div>
      </Group>

      <Group title={t('settings.group.listen')}>
        <Field label={t('settingsGeneral.listenTries')} hint={t('settingsGeneral.listenTriesHint')}>
          <Seg options={LISTEN_TRIES.map(n => ({ value: n, label: String(n) }))} value={tries} onChange={n => { setTries(n); saveWatchPrefs({ listenTries: n }); }} />
        </Field>
      </Group>

      <Group title={t('settings.group.japanese')}>
        <JaDictRow />
      </Group>

      <Group title={t('settings.group.home')}>
        <div>
          <label className="flex items-center gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={today} onChange={e => { setToday(e.target.checked); setPracticeFlag('todayBar', e.target.checked); }} className="w-4 h-4 accent-accent" />
            {t('settingsGeneral.todayBar')}
          </label>
          <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('settingsGeneral.todayBarHint')}</p>
        </div>
        <div>
          <label className="flex items-center gap-2.5 text-sm cursor-pointer">
            <input type="checkbox" checked={week} onChange={e => { setWeek(e.target.checked); setPracticeFlag('weekStats', e.target.checked); }} className="w-4 h-4 accent-accent" />
            {t('settingsGeneral.weekStats')}
          </label>
          <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('settingsGeneral.weekStatsHint')}</p>
        </div>
      </Group>
    </div>
  );
};

export default SettingsPractice;
