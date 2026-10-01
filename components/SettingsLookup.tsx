import React, { useState } from 'react';
import { Btn, Card, Field, Seg } from './ui';
import { useT, useLang } from '../utils/i18n';
import { DictLang, DictSources, dictOptions, getDictChoice, getDictSources, saveDictChoice, saveDictSources } from '../utils/dictionary';
import SettingsLocalDict from './SettingsLocalDict';

// Settings → Look up (docs/dictionary.md「查词顺序与开关」): the order a clicked
// word goes through, then one card each — online, local, AI (`children`, the prompt).
const DictionaryPicker: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  // Each interface language lists and keeps its own dictionaries (docs/dictionary.md).
  const ui = useLang();
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

const NUM = ['①', '②', '③'];

// One numbered card (n = -1: off, no number); with `on` it has a switch, and switched off it folds to its header.
const Step: React.FC<{ n: number; title: string; sub: string; on?: boolean; setOn?: (v: boolean) => void; children: React.ReactNode }> = ({
  n, title, sub, on = true, setOn, children,
}) => {
  const t = useT();
  return (
    <Card flat className="p-5">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-semibold">{NUM[n] ?? ''} {title}</h3>
        <span className="flex-1 text-xs text-mute">{on ? sub : t('lookup.offNote')}</span>
        {setOn && (
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={on} onChange={e => setOn(e.target.checked)} />
            {t('lookup.use')}
          </label>
        )}
      </div>
      {on && <div className="mt-5 space-y-6">{children}</div>}
    </Card>
  );
};

const SettingsLookup: React.FC<{ onSaved: () => void; aiReady: boolean; goAI: () => void; children: React.ReactNode }> = ({ onSaved, aiReady, goAI, children }) => {
  const t = useT();
  const ui = useLang();
  const [src, setSrc] = useState<DictSources>(() => getDictSources(ui));
  const set = (patch: Partial<DictSources>) => { saveDictSources(patch); setSrc(getDictSources(ui)); onSaved(); };

  const online = { key: 'online', title: t('lookup.online'), sub: t('lookup.onlineSub'), on: src.online, setOn: (v: boolean) => set({ online: v }), body: <DictionaryPicker onSaved={onSaved} /> };
  const local = { key: 'local', title: t('localDict.label'), sub: t('lookup.localSub'), on: src.local, setOn: (v: boolean) => set({ local: v }), body: <SettingsLocalDict /> };
  const dicts = src.localFirst ? [local, online] : [online, local];
  // Only what is on gets a number, so the line and the cards count 1, 2, 3 without gaps.
  const steps = [...dicts.filter(d => d.on).map(d => d.key), 'ai'];
  const flow = [...dicts.filter(d => d.on).map(d => d.title), 'AI'].map((x, i) => `${NUM[i]} ${x}`);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <p className="flex-1 text-sm text-mute">{[t('lookup.click'), ...flow].join(' → ')}</p>
        {/* Up here, not in a card: flipping it swaps the cards below, and it stays put under the mouse. */}
        <label className="flex items-center gap-2 text-sm cursor-pointer" title={t('lookup.localFirstHint')}>
          <input type="checkbox" checked={src.localFirst} onChange={e => set({ localFirst: e.target.checked })} />
          {t('lookup.localFirst')}
        </label>
      </div>
      {!src.online && !src.local && (
        <p className="flex items-center gap-2 text-sm text-accent">
          {t(aiReady ? 'lookup.allOff' : 'lookup.allOffNoAi')}
          {!aiReady && <Btn type="button" size="sm" flat onClick={goAI}>{t('settings.goAi')}</Btn>}
        </p>
      )}
      {dicts.map(d => <Step key={d.key} n={steps.indexOf(d.key)} title={d.title} sub={d.sub} on={d.on} setOn={d.setOn}>{d.body}</Step>)}
      <Step n={steps.length - 1} title="AI" sub={t('lookup.aiSub')}>
        <label className={`flex items-center gap-2 text-sm ${aiReady ? 'cursor-pointer' : 'text-mute'}`}>
          <input type="checkbox" checked={src.autoPick} disabled={!aiReady} onChange={e => set({ autoPick: e.target.checked })} />
          {t('lookup.autoPick')}
        </label>
        {children}
      </Step>
    </div>
  );
};

export default SettingsLookup;
