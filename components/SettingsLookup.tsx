import React, { useState } from 'react';
import { Field, Group, Seg } from './ui';
import { useT, useLang } from '../utils/i18n';
import { DictLang, dictOptions, getDictChoice, saveDictChoice } from '../utils/dictionary';
import SettingsLocalDict from './SettingsLocalDict';
import { useLocalDicts } from '../utils/localDict';

// Settings → Look up: which dictionary a clicked word goes to; `children` is the AI fallback prompt.
const DictionaryPicker: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  // Each interface language lists and keeps its own dictionaries (docs/dictionary.md).
  const ui = useLang();
  useLocalDicts(); // redraw once the local list is read: it adds "Local dictionaries" to the options
  const options = dictOptions(ui);
  const [, redraw] = useState(0);
  const choice = getDictChoice(ui);
  return (
    <Field label={t('settingsGeneral.dictionary')} hint={t('settingsGeneral.dictionaryHint')}>
      <div className="space-y-2.5">
        {(Object.keys(options) as DictLang[]).map(lang => (
          <div key={lang} className="flex items-center gap-4">
            <span className="w-20 text-sm text-mute">{t(`dict.${lang}`)}</span>
            <Seg
              options={options[lang].map(v => ({ value: v, label: t(`dict.${v}`) }))}
              value={choice[lang]}
              onChange={v => { saveDictChoice(lang, v, ui); redraw(n => n + 1); onSaved(); }}
            />
          </div>
        ))}
      </div>
    </Field>
  );
};

const SettingsLookup: React.FC<{ onSaved: () => void; children: React.ReactNode }> = ({ onSaved, children }) => {
  const t = useT();
  return (
    <div className="space-y-10">
      <Group title={t('settings.group.dictionary')}>
        <DictionaryPicker onSaved={onSaved} />
        <SettingsLocalDict />
      </Group>
      {children}
    </div>
  );
};

export default SettingsLookup;
