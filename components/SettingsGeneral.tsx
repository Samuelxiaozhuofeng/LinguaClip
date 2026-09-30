import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { AudioPaddingConfig } from '../types';
import { Btn, Field, Seg } from './ui';
import { clipsInfo, revealInFolder } from '../utils/desktop';
import { getClipProgress, retryClips, subscribeClips } from '../utils/clips';
import { downloadConvertTool, loadConvertTool } from '../utils/convertTool';
import { useT, useLang, Lang } from '../utils/i18n';
import { getPracticeConfig, getWordFront, savePracticeConfig } from '../utils/storage';
import type { WordFront } from '../types';
import { DictLang, dictOptions, getDictChoice, saveDictChoice } from '../utils/dictionary';
import { JaDictRow } from './JaSetup';
import ConvertToolRow from './ConvertToolRow';

interface SettingsGeneralProps {
  lang: Lang;
  setLang: (value: Lang) => void;
  sectionLength: number;
  setSectionLength: (value: number) => void;
  audioPadding: AudioPaddingConfig;
  setAudioPadding: (value: AudioPaddingConfig) => void;
  onSaved: () => void;
}

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

// Cards keep their own clip of the line (utils/clips.ts): on / off, which kind, and how far along.
const ClipsRow: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const [on, setOn] = useState(() => getPracticeConfig().saveClips ?? false);
  const [kind, setKind] = useState(() => getPracticeConfig().clipKind ?? 'video');
  const p = useSyncExternalStore(subscribeClips, getClipProgress);
  const [info, setInfo] = useState<{ dir: string; bytes: number } | null>(null);
  useEffect(() => { clipsInfo().then(setInfo).catch(() => setInfo(null)); }, [p.saved, p.running]);
  const save = (next: { saveClips?: boolean; clipKind?: 'video' | 'audio' }) => {
    savePracticeConfig({ ...getPracticeConfig(), ...next });
    onSaved();
    if (!(next.saveClips ?? on)) return;
    // Get the converter first when it's missing, so its download shows in its own row below.
    loadConvertTool().then(st => st && !st.path ? downloadConvertTool() : true).finally(() => { retryClips(); });
  };
  const mb = (b: number) => b < 1e9 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e9).toFixed(1)} GB`;
  return (
    <Field label={t('settingsGeneral.clips')} hint={t('settingsGeneral.clipsHint')}
      right={on && info && <Btn type="button" size="sm" flat onClick={() => revealInFolder(info.dir).catch(console.error)}><FolderOpen size={14} /> {t('settingsGeneral.clipsShow')}</Btn>}>
      <div className="space-y-2.5 text-sm">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={on} onChange={e => { setOn(e.target.checked); save({ saveClips: e.target.checked }); }} />
          {t('settingsGeneral.clipsLabel')}
        </label>
        {on && <>
          <Seg size="sm" value={kind} onChange={v => { setKind(v); save({ clipKind: v }); }} options={[
            { value: 'video' as const, label: t('settingsGeneral.clipVideo') },
            { value: 'audio' as const, label: t('settingsGeneral.clipAudio') },
          ]} />
          <p className="text-mute flex items-center gap-2">
            {p.running && <Loader2 size={14} className="animate-spin" />}
            {p.running ? `${t('settingsGeneral.clipsSaving')} ` : ''}{t('settingsGeneral.clipsStatus', { saved: p.saved, total: p.total, size: info ? mb(info.bytes) : '…' })}
          </p>
          {p.noVideo > 0 && <p className="text-mute">{t('settingsGeneral.clipsNoVideo', { n: p.noVideo })}</p>}
          {p.error && <p className="text-mute">{t('settingsGeneral.clipsFailed')}<span className="text-xs break-all">{p.error}</span></p>}
        </>}
      </div>
    </Field>
  );
};

// Two cards, each a small picture of the front it gives.
const WordFrontPicker: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const [front, setFront] = useState(getWordFront);
  const pick = (v: WordFront) => { setFront(v); savePracticeConfig({ ...getPracticeConfig(), wordFront: v }); onSaved(); };
  const opts: { value: WordFront; label: string; hint: string; face: React.ReactNode }[] = [
    { value: 'word', label: t('settingsGeneral.wordFrontWord'), hint: t('settingsGeneral.wordFrontWordHint'), face: <span className="font-serif text-[28px] font-semibold">諦める</span> },
    { value: 'sentence', label: t('settingsGeneral.wordFrontSentence'), hint: t('settingsGeneral.wordFrontSentenceHint'), face: <span className="font-serif text-[17px]">もう<span className="text-accent font-semibold underline decoration-2 underline-offset-4">諦める</span>しかない</span> },
  ];
  return (
    <Field label={t('settingsGeneral.wordFront')} hint={t('settingsGeneral.wordFrontHint')}>
      <div className="grid grid-cols-2 gap-3">
        {opts.map(o => (
          <label key={o.value} className={`rounded-2xl p-3 flex flex-col gap-2.5 cursor-pointer ${front === o.value ? 'border-2 border-accent' : 'border border-line m-px'}`}>
            <span className="h-20 rounded-xl bg-shade flex items-center justify-center">{o.face}</span>
            <span className="flex items-start gap-2">
              <input type="radio" name="wordFront" checked={front === o.value} onChange={() => pick(o.value)} className="mt-1 accent-accent" />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-semibold">{o.label}</span>
                <span className="text-xs text-mute leading-relaxed">{o.hint}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </Field>
  );
};

// Always shown as "中文" / "English" in their own language, regardless of the current UI language.
const LANG_OPTS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

const SettingsGeneral: React.FC<SettingsGeneralProps> = ({
  lang,
  setLang,
  sectionLength,
  setSectionLength,
  audioPadding,
  setAudioPadding,
  onSaved,
}) => {
  const t = useT();
  const [autoAdd, setAutoAdd] = useState(() => getPracticeConfig().autoAddReview ?? false);
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
    <div className="space-y-6">
      <Field label="Language / 语言">
        <Seg options={LANG_OPTS} value={lang} onChange={setLang} />
      </Field>

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

      <Field label={t('settingsGeneral.autoAddReview')} hint={t('settingsGeneral.autoAddReviewHint')}>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={autoAdd}
            onChange={e => { setAutoAdd(e.target.checked); savePracticeConfig({ ...getPracticeConfig(), autoAddReview: e.target.checked }); onSaved(); }}
          />
          {t('settingsGeneral.autoAddReviewLabel')}
        </label>
      </Field>

      <WordFrontPicker onSaved={onSaved} />
      <ClipsRow onSaved={onSaved} />
      <DictionaryPicker onSaved={onSaved} />
      <JaDictRow />
      <ConvertToolRow />

      <Field
        label={t('settingsGeneral.startPadding')}
        right={`${audioPadding.startPadding}ms`}
        hint={t('settingsGeneral.startPaddingHint')}
      >
        <input
          type="range"
          min="0"
          max="1000"
          step="50"
          value={audioPadding.startPadding}
          onChange={(e) => setAudioPadding({ ...audioPadding, startPadding: parseInt(e.target.value, 10) })}
        />
        <div className="flex justify-between text-xs text-mute font-mono mt-1">
          <span>0ms</span>
          <span>1000ms</span>
        </div>
      </Field>

      <Field
        label={t('settingsGeneral.endPadding')}
        right={`${audioPadding.endPadding}ms`}
        hint={t('settingsGeneral.endPaddingHint')}
      >
        <input
          type="range"
          min="0"
          max="1000"
          step="50"
          value={audioPadding.endPadding}
          onChange={(e) => setAudioPadding({ ...audioPadding, endPadding: parseInt(e.target.value, 10) })}
        />
        <div className="flex justify-between text-xs text-mute font-mono mt-1">
          <span>0ms</span>
          <span>1000ms</span>
        </div>
      </Field>
    </div>
  );
};

export default SettingsGeneral;
