import React, { useState } from 'react';
import { Field, Group, Seg } from './ui';
import { useT } from '../utils/i18n';
import { JaDictRow } from './JaSetup';
import { getWatchPrefs, saveWatchPrefs, LISTEN_TRIES } from '../utils/storage';

interface SettingsPracticeProps {
  sectionLength: number;
  setSectionLength: (value: number) => void;
}

// Settings → Practice: how a video is cut into sections, intensive listening's hard-line plays, and Japanese splitting.
const SettingsPractice: React.FC<SettingsPracticeProps> = ({
  sectionLength,
  setSectionLength,
}) => {
  const t = useT();
  const [tries, setTries] = useState(() => getWatchPrefs().listenTries);
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

      <Group title={t('settings.group.listen')}>
        <Field label={t('settingsGeneral.listenTries')} hint={t('settingsGeneral.listenTriesHint')}>
          <Seg options={LISTEN_TRIES.map(n => ({ value: n, label: String(n) }))} value={tries} onChange={n => { setTries(n); saveWatchPrefs({ listenTries: n }); }} />
        </Field>
      </Group>

      <Group title={t('settings.group.japanese')}>
        <JaDictRow />
      </Group>
    </div>
  );
};

export default SettingsPractice;
