// Phone settings (design Settings.dc.html): Groq key (into linguaclip_transcribe_config,
// other fields kept), the AI endpoint / key / model (linguaclip_ai_config), UI language,
// export / restore a backup (mobile/restore.ts). Saved as typed.
import React, { useRef, useState } from 'react';
import { getTranscribeConfig, saveTranscribeConfig } from '../utils/transcribeConfig';
import { getAIConfig, saveAIConfig } from '../utils/aiConfig';
import { setLang, useLang, useT, type Lang } from '../utils/i18n';
import type { AIConfig } from '../types';
import { Header, sheet } from './ui';
import { describe, exportBackup, readBackupFile, startRestore } from './restore';

const field = 'h-11 rounded-[10px] border border-line px-3 text-[15px] w-full bg-page';

export const Settings: React.FC<{ needKey: boolean; onBack: () => void }> = ({ needKey, onBack }) => {
  const t = useT();
  const ui = useLang();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const doExport = () => {
    setBusy(true);
    setNote('');
    exportBackup().then(n => { if (n) setNote(t('m.bkExported', n)); }, e => { console.error(e); setNote(t('m.bkExportFail', { why: describe(e) })); })
      .finally(() => setBusy(false));
  };
  const doRestore = async (f: File) => {
    setBusy(true);
    setNote('');
    try {
      const b = await readBackupFile(f);
      if (!confirm(t('m.bkConfirm', { videos: b.videos.length, cards: b.review.cards.length }))) return;
      await startRestore(b); // reloads
    } catch (e) {
      console.error(e);
      setNote(t('m.bkCant', { why: describe(e) }));
    } finally { setBusy(false); }
  };
  const [groq, setGroq] = useState(() => getTranscribeConfig().groqKey);
  const [ai, setAi] = useState(getAIConfig);
  const setGroqKey = (v: string) => { setGroq(v); saveTranscribeConfig({ ...getTranscribeConfig(), groqKey: v.trim() }); };
  const setAiField = (k: keyof Pick<AIConfig, 'baseUrl' | 'apiKey' | 'model'>, v: string) => {
    const next = { ...getAIConfig(), [k]: v.trim() };
    saveAIConfig(next);
    setAi(next);
  };
  const row = (k: 'baseUrl' | 'apiKey' | 'model', label: string, type = 'text') => (
    <label className="px-4 py-3 flex flex-col gap-1.5 border-b border-shade last:border-0">
      <span className="text-[15px]">{label}</span>
      <input type={type} className={field} value={ai[k] ?? ''} autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={e => setAiField(k, e.target.value)} />
    </label>
  );
  return (
    <>
      <Header title={t('m.settings')} onBack={onBack} />
      <div className="px-5 pt-2 pb-10 flex flex-col gap-5">
        <section className="flex flex-col gap-2">
          <p className="text-[13px] text-mute">{t('m.groqTitle')}</p>
          {needKey && <p role="alert" className="text-[13px] text-accent px-1">{t('m.needKey')}</p>}
          <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
            <label htmlFor="groq" className="text-[15px] font-medium">Groq key</label>
            <input id="groq" type="password" className={field} placeholder="gsk_…" value={groq} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={e => setGroqKey(e.target.value)} />
            <p className="text-xs text-mute">{t('m.groqHelp')} <a className="text-accent" href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a></p>
          </div>
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-[13px] text-mute">{t('m.aiTitle')}</p>
          <div className={`${sheet} flex flex-col`}>
            {row('baseUrl', t('m.aiUrl'))}
            {row('apiKey', t('m.aiKey'), 'password')}
            {row('model', t('m.aiModel'))}
          </div>
          <p className="text-xs text-mute px-1">{t('m.aiHelp')}</p>
        </section>
        <section className="flex flex-col gap-2">
          <p className="text-[13px] text-mute">{t('m.dataTitle')}</p>
          <div className={`${sheet} flex flex-col`}>
            <button disabled={busy} onClick={doExport} className="h-[52px] px-4 text-left text-[15px] border-b border-shade disabled:opacity-50">{t('m.bkExport')}</button>
            <button disabled={busy} onClick={() => file.current?.click()} className="h-[52px] px-4 text-left text-[15px] disabled:opacity-50">{t('m.bkRestore')}</button>
          </div>
          {note && <p role="status" className="text-[13px] text-accent px-1 whitespace-pre-line">{note}</p>}
          <p className="text-xs text-mute px-1">{t('m.dataHelp')}</p>
          <input ref={file} type="file" accept=".json,application/json" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void doRestore(f); }} />
        </section>
        <label className={`${sheet} px-4 py-3 flex items-center justify-between gap-3`}>
          <span className="text-[15px]">{t('settings.language')}</span>
          <select value={ui} onChange={e => setLang(e.target.value as Lang)} className="min-h-[44px] bg-transparent text-[15px] text-mute">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </div>
    </>
  );
};
