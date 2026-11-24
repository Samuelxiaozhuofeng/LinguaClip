// Settings → Dictionaries & pronunciation entry row (docs/android-roadmap.md M2.4).
// Opens the full-screen DictPage subpage. PWA shows only online dictionary entry;
// Android native shows local dictionary count and pronunciation preference summary.
import React, { useEffect, useState } from 'react';
import { getWordVoice } from '../../utils/storage';
import { useT } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { refreshPhoneLocalDicts, usePhoneLocalDicts } from '../platform/wordPlatform';
import { sheet } from '../ui';
import { DictPage } from './DictPage';
import { useBackClose } from '../backClose';

export const DictSection: React.FC = () => {
  const t = useT();
  const android = isAndroidNative();
  const { list } = usePhoneLocalDicts();
  const [open, setOpen] = useState(false);
  const [, setRev] = useState(0);
  useBackClose(open, () => { setOpen(false); setRev(n => n + 1); });

  useEffect(() => {
    if (android) void refreshPhoneLocalDicts();
  }, [android]);

  const localCount = list.filter(d => !d.broken).length;
  const voice = getWordVoice();
  const summary = android
    ? t('m.dictSummaryAndroid', { n: localCount, voice: t(voice === 'clip' ? 'm.voiceShortClip' : 'm.voiceShortTts') })
    : t('m.dictSummaryWeb');

  return (
    <>
      <section className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={`${sheet} px-4 py-3.5 flex items-center justify-between gap-3 text-left w-full`}
        >
          <span className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[15px] font-medium">{t(android ? 'm.dictVoiceTitle' : 'm.dictTitle')}</span>
            <span className="text-xs text-mute truncate">{summary}</span>
          </span>
          <span className="text-mute text-xl leading-none shrink-0" aria-hidden="true">›</span>
        </button>
      </section>
      {open && <DictPage onBack={() => { setOpen(false); setRev(n => n + 1); }} />}
    </>
  );
};
