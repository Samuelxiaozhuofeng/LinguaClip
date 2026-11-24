// Full-screen Settings → Dictionaries & pronunciation subpage (docs/android-roadmap.md M2.4).
// PWA shows only online dictionary choices per language; Android native adds lookup priority
// (linguaclip_dict_sources), word pronunciation mode (practice_config.wordVoice), local Yomitan
// dictionary management, and kuromoji Japanese splitting dictionary status.
import React, { useState } from 'react';
import {
  dictOptions, getDictChoice, getDictSources, saveDictChoice, saveDictSources,
  type DictLang, type DictSource, type DictSources,
} from '../../utils/dictionary';
import { getPracticeConfig, getWordVoice, savePracticeConfig } from '../../utils/storage';
import { useLang, useT } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { Header, sheet } from '../ui';
import { LocalDictPanel } from './LocalDictPanel';

type PriorityMode = 'localFirst' | 'onlineFirst' | 'onlineOnly';

const resolvePriority = (s: DictSources): PriorityMode => {
  if (!s.local) return 'onlineOnly';
  return s.localFirst ? 'localFirst' : 'onlineFirst';
};

export const DictPage: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const t = useT();
  const ui = useLang();
  const android = isAndroidNative();

  const [, redrawOnline] = useState(0);
  const [src, setSrc] = useState<DictSources>(() => getDictSources(ui));
  const [wordVoice, setWordVoiceState] = useState<'tts' | 'clip'>(getWordVoice);

  const dOpts = dictOptions(ui);
  const dictLangs = (Object.keys(dOpts) as DictLang[]).filter(lang => dOpts[lang].length > 1);
  const dChoice = getDictChoice(ui);

  const priority = resolvePriority(src);
  const setPriority = (mode: PriorityMode) => {
    const patch: Partial<DictSources> = mode === 'localFirst'
      ? { online: true, local: true, localFirst: true }
      : mode === 'onlineFirst'
        ? { online: true, local: true, localFirst: false }
        : { online: true, local: false, localFirst: false };
    saveDictSources(patch);
    setSrc(getDictSources(ui));
  };

  const setWordVoice = (voice: 'tts' | 'clip') => {
    savePracticeConfig({ ...getPracticeConfig(), wordVoice: voice });
    setWordVoiceState(voice);
  };

  const priorityOptions: { mode: PriorityMode; label: string }[] = [
    { mode: 'localFirst', label: t('m.dictPriorityLocal') },
    { mode: 'onlineFirst', label: t('m.dictPriorityOnline') },
    { mode: 'onlineOnly', label: t('m.dictPriorityOnlineOnly') },
  ];

  const priorityHint = priority === 'localFirst'
    ? t('m.dictPriorityLocalHint')
    : priority === 'onlineFirst'
      ? t('m.dictPriorityOnlineHint')
      : t('m.dictPriorityOnlineOnlyHint');

  return (
    <div className="fixed inset-0 z-30 bg-paper overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      <Header title={t(android ? 'm.dictVoiceTitle' : 'm.dictTitle')} onBack={onBack} />
      <div className="px-5 pt-2 pb-12 flex flex-col gap-5">
        {android && (
          <>
            <section className="flex flex-col gap-2" aria-label={t('m.dictPriorityTitle')}>
              <p className="text-[13px] text-mute">{t('m.dictPriorityTitle')}</p>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('m.dictPriorityTitle')}>
                {priorityOptions.map(opt => (
                  <button
                    key={opt.mode}
                    type="button"
                    role="radio"
                    aria-checked={priority === opt.mode}
                    onClick={() => setPriority(opt.mode)}
                    className={`min-h-[40px] px-3.5 rounded-full text-[13px] ${priority === opt.mode ? 'bg-ink text-white font-medium' : 'bg-page text-mute shadow-card'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-mute px-1 leading-relaxed">{priorityHint}</p>
            </section>

            <section className="flex flex-col gap-2" aria-label={t('m.wordVoiceTitle')}>
              <p className="text-[13px] text-mute">{t('m.wordVoiceTitle')}</p>
              <div className={`${sheet} flex flex-col`} role="radiogroup" aria-label={t('m.wordVoiceTitle')}>
                {(['tts', 'clip'] as const).map(mode => (
                  <label key={mode} className="px-4 py-3.5 flex items-start justify-between gap-3 border-b border-shade last:border-0 cursor-pointer">
                    <span className="flex flex-col gap-0.5">
                      <span className="text-[15px] font-medium">
                        {t(mode === 'tts' ? 'm.wordVoiceTts' : 'm.wordVoiceClip')}
                      </span>
                      <span className="text-xs text-mute leading-relaxed">
                        {t(mode === 'tts' ? 'm.wordVoiceTtsHint' : 'm.wordVoiceClipHint')}
                      </span>
                    </span>
                    <input
                      type="radio"
                      name="wordVoice"
                      checked={wordVoice === mode}
                      onChange={() => setWordVoice(mode)}
                      className="w-5 h-5 mt-0.5 shrink-0 accent-accent"
                    />
                  </label>
                ))}
              </div>
            </section>

            <LocalDictPanel />
          </>
        )}

        <section className="flex flex-col gap-2" aria-label={t('m.dictTitle')}>
          <p className="text-[13px] text-mute">{t('m.dictTitle')}</p>
          <div className={`${sheet} flex flex-col`}>
            {dictLangs.map(lang => (
              <label key={lang} className="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-shade last:border-0">
                <span className="text-[15px]">{t(`dict.${lang}`)}</span>
                <select
                  value={dChoice[lang]}
                  className="min-h-[44px] bg-transparent text-[15px] text-mute text-right"
                  onChange={e => { saveDictChoice(lang, e.target.value as DictSource, ui); redrawOnline(n => n + 1); }}
                >
                  {dOpts[lang].map(opt => (
                    <option key={opt} value={opt}>{t(`dict.${opt}`)}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
