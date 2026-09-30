import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Btn, Field, Group, Seg } from './ui';
import { clipsInfo, revealInFolder } from '../utils/desktop';
import { getClipProgress, retryClips, subscribeClips } from '../utils/clips';
import { downloadConvertTool, loadConvertTool, useConvertTool } from '../utils/convertTool';
import ConvertToolRow from './ConvertToolRow';
import { useT } from '../utils/i18n';
import { getAudioPaddingConfig, getPracticeConfig, getWordFront, saveAudioPaddingConfig, savePracticeConfig } from '../utils/storage';
import type { WordFront } from '../types';

// Cards keep their own clip of the line (utils/clips.ts): on / off, which kind, and how far along.
const ClipsRow: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const [on, setOn] = useState(() => getPracticeConfig().saveClips ?? false);
  const [kind, setKind] = useState(() => getPracticeConfig().clipKind ?? 'video');
  const p = useSyncExternalStore(subscribeClips, getClipProgress);
  const tool = useConvertTool();
  useEffect(() => { loadConvertTool(); }, []);
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
    <>
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
      {/* The converter lives on the Import tab; while it is missing, show its download here too
          (outside the Field: a label inside a label would flip the clips checkbox). */}
      {on && tool.status && !tool.status.path && <ConvertToolRow />}
    </>
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

// Settings → Cards & review: what goes into review and how cards look; `children` is the Anki group.
const SettingsCards: React.FC<{ onSaved: () => void; children: React.ReactNode }> = ({ onSaved, children }) => {
  const t = useT();
  const [autoAdd, setAutoAdd] = useState(() => getPracticeConfig().autoAddReview ?? false);
  const [audioPadding, setPadding] = useState(getAudioPaddingConfig);
  const setAudioPadding = (v: typeof audioPadding) => { setPadding(v); saveAudioPaddingConfig(v); onSaved(); };
  return (
    <div className="space-y-10">
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
        <WordFrontPicker onSaved={onSaved} />
        <ClipsRow onSaved={onSaved} />
      </Group>
      <Group title={t('settings.group.cardAudio')}>
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
      </Group>
      <Group title="Anki">{children}</Group>
    </div>
  );
};

export default SettingsCards;
