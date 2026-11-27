import React, { useState } from 'react';
import { Field, Group } from './ui';
import { useT } from '../utils/i18n';
import { getMasteredBtn, getPracticeConfig, getWordFront, getWordVoice, savePracticeConfig, setPracticeFlag } from '../utils/storage';
import { getAutoAddReview } from '../utils/autoAddReview';
import type { WordFront } from '../types';

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

// Where a word's own sound comes from (docs/word-audio.md).
const WordVoicePicker: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const [voice, setVoice] = useState(getWordVoice);
  const pick = (v: 'clip' | 'tts') => { setVoice(v); savePracticeConfig({ ...getPracticeConfig(), wordVoice: v }); onSaved(); };
  const opts = [
    { value: 'tts' as const, label: t('settingsGeneral.wordVoiceTts'), hint: t('settingsGeneral.wordVoiceTtsHint') },
    { value: 'clip' as const, label: t('settingsGeneral.wordVoiceClip'), hint: t('settingsGeneral.wordVoiceClipHint') },
  ];
  return (
    <Field label={t('settingsGeneral.wordVoice')}>
      <div className="flex flex-col gap-2">
        {opts.map(o => (
          <label key={o.value} className="flex items-start gap-2 cursor-pointer">
            <input type="radio" name="wordVoice" checked={voice === o.value} onChange={() => pick(o.value)} className="mt-1 accent-accent" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">{o.label}</span>
              <span className="text-xs text-mute leading-relaxed">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Field>
  );
};

// Settings → Practice → review habits: auto-add lines, fast-pass mastered switch, word card front & voice.
const SettingsCards: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const [autoAdd, setAutoAdd] = useState(getAutoAddReview);
  const [masteredBtn, setMasteredBtn] = useState(getMasteredBtn);
  return (
    <Group title={t('settings.group.review')}>
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
      <Field label={t('settingsCards.mastered')} hint={t('settingsCards.masteredHint')}>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={masteredBtn}
            onChange={e => { setMasteredBtn(e.target.checked); setPracticeFlag('masteredBtn', e.target.checked); onSaved(); }}
          />
          {t('settingsCards.masteredLabel')}
        </label>
      </Field>
      <WordFrontPicker onSaved={onSaved} />
      <WordVoicePicker onSaved={onSaved} />
    </Group>
  );
};

export default SettingsCards;
