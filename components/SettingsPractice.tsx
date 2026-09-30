import React from 'react';
import { Field, Group, Seg } from './ui';
import { useT } from '../utils/i18n';
import { JaDictRow } from './JaSetup';

interface SettingsPracticeProps {
  sectionLength: number;
  setSectionLength: (value: number) => void;
}

// Settings → Practice: how a video is cut into sections, and Japanese splitting.
const SettingsPractice: React.FC<SettingsPracticeProps> = ({
  sectionLength,
  setSectionLength,
}) => {
  const t = useT();
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

      <Group title={t('settings.group.japanese')}>
        <JaDictRow />
      </Group>
    </div>
  );
};

export default SettingsPractice;
