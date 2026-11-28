// Phone settings (design Settings.dc.html), split into tabs so each screen stays short:
// General (practice, appearance, language, Wi-Fi-only, battery, supporter) · AI (provider,
// key, fetched models, model per feature) · Transcribe (cloud key) · Words & cards
// (dictionaries, clips, Anki) · Sync & backup. Opened for a missing key → Transcribe.
import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../utils/i18n';
import { Header } from './ui';
import { GeneralSection } from './settings/GeneralSection';
import { AiSection } from './settings/AiSection';
import { TranscribeSection } from './settings/TranscribeSection';
import { DictSection } from './settings/DictSection';
import { ClipsSection } from './settings/ClipsSection';
import { AnkiSection } from './settings/AnkiSection';
import { SyncSection } from './settings/SyncSection';
import { BackupSection } from './settings/BackupSection';

type Tab = 'general' | 'ai' | 'transcribe' | 'words' | 'sync';
const TABS = [
  { id: 'general', key: 'm.tabGeneral' },
  { id: 'ai', key: 'm.tabAi' },
  { id: 'transcribe', key: 'm.tabTranscribe' },
  { id: 'words', key: 'm.tabWords' },
  { id: 'sync', key: 'm.tabSync' },
] as const satisfies readonly { id: Tab; key: string }[];

// The last tab is remembered while the app is open (not across launches).
let lastTab: Tab = 'general';

export const Settings: React.FC<{ needKey: boolean; onBack?: () => void }> = ({ needKey, onBack }) => {
  const t = useT();
  const [tab, setTabState] = useState<Tab>(needKey ? 'transcribe' : lastTab);
  const top = useRef<HTMLDivElement>(null);
  // Already open when an import hits a missing key: still jump to Transcribe.
  useEffect(() => { if (needKey) setTabState('transcribe'); }, [needKey]);

  const setTab = (next: Tab) => {
    lastTab = next;
    setTabState(next);
    top.current?.scrollIntoView({ block: 'start' });
  };

  return (
    <>
      <div ref={top}>
        {onBack ? <Header title={t('m.settings')} onBack={onBack} /> : <h1 className="pt-4 px-5 pb-2 text-[17px] font-semibold">{t('m.settings')}</h1>}
      </div>
      <div className="sticky top-0 z-10 bg-paper px-5 py-2">
        <div role="tablist" aria-label={t('m.settings')} className="flex gap-1 overflow-x-auto bg-shade rounded-full p-1" style={{ scrollbarWidth: 'none' }}>
          {TABS.map(x => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} data-testid={`settings-tab-${x.id}`}
              onClick={() => setTab(x.id)}
              className={`shrink-0 grow min-h-[36px] px-3 rounded-full text-[13px] whitespace-nowrap ${tab === x.id ? 'bg-page text-ink font-medium shadow-card' : 'text-mute'}`}>
              {t(x.key)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" className="px-5 pt-3 pb-10 flex flex-col gap-5">
        {tab === 'general' && <GeneralSection />}
        {tab === 'ai' && <AiSection />}
        {tab === 'transcribe' && <TranscribeSection needKey={needKey} onBack={onBack} />}
        {tab === 'words' && (
          <>
            <DictSection />
            <ClipsSection />
            <AnkiSection />
          </>
        )}
        {tab === 'sync' && (
          <>
            <SyncSection />
            <BackupSection />
          </>
        )}
      </div>
    </>
  );
};
