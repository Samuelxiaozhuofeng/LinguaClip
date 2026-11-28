// Phone Settings → Transcribe tab: cloud transcription key (Groq on PWA; Groq / Bailian /
// custom OpenAI-compatible on Android). `needKey` = opened from an import that had no key.
import React, { useState } from 'react';
import { CLOUD, androidCloudArgs, getTranscribeConfig, saveTranscribeConfig, type TranscribeConfig } from '../../utils/transcribeConfig';
import { useT } from '../../utils/i18n';
import { btnPrimary, sheet } from '../ui';
import { isAndroidNative } from '../platform/androidBridge';
import { groqKey } from '../transcribe';
import { Chips } from './Chips';

export const field = 'h-11 rounded-[10px] border border-line px-3 text-[15px] w-full bg-page';
// Keys: a plain text field (type=password brings up Android's secure keyboard, which
// blocks paste), dotted out while not being edited.
export const keyField = `${field} [-webkit-text-security:disc] focus:[-webkit-text-security:none]`;

type AndroidProvider = 'cloud' | 'bailian' | 'custom';

const resolveAndroidMode = (cfg: TranscribeConfig): AndroidProvider => {
  if (cfg.mode !== 'local') return cfg.mode;
  const resolved = androidCloudArgs(cfg);
  if (resolved?.provider === 'bailian') return 'bailian';
  if (resolved?.provider === 'custom') return 'custom';
  return 'cloud';
};

export const TranscribeSection: React.FC<{ needKey: boolean; onBack?: () => void }> = ({ needKey, onBack }) => {
  const t = useT();
  const android = isAndroidNative();
  const [trCfg, setTrCfg] = useState<TranscribeConfig>(getTranscribeConfig);
  const [provider, setProvider] = useState<AndroidProvider>(() => resolveAndroidMode(getTranscribeConfig()));

  const selectProvider = (mode: AndroidProvider) => {
    setProvider(mode);
    const next = { ...getTranscribeConfig(), mode };
    saveTranscribeConfig(next);
    setTrCfg(next);
  };

  const patchTr = (patch: Partial<TranscribeConfig>) => {
    const saved: TranscribeConfig = {
      ...getTranscribeConfig(),
      ...(android ? { mode: provider } : {}),
      ...Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])),
    };
    saveTranscribeConfig(saved);
    setTrCfg(prev => ({ ...prev, ...(android ? { mode: provider } : {}), ...patch }));
  };

  const needKeyText = !android || provider === 'cloud'
    ? t('m.w3NeedKeyProvider', { provider: 'Groq' })
    : provider === 'bailian'
      ? t('m.w3NeedKeyProvider', { provider: t('transcribe.bailian') })
      : t('m.w3NeedKeyCustom');
  const hasKeyNow = android ? !!androidCloudArgs(trCfg) : !!groqKey();

  return (
    <section className="flex flex-col gap-2">
      <p data-testid="settings-no-key-tip" className={`${sheet} px-4 py-3 mb-1 text-[13px] text-mute leading-relaxed shadow-card`}>
        {t('m.w3SettingsNoKeyBanner')}
      </p>
      <p className="text-[13px] text-mute">{t(android ? 'm.transcribeTitle' : 'm.groqTitle')}</p>
      {needKey && (
        <div className="flex flex-col gap-2">
          <p role="alert" className="text-[13px] text-accent px-1">{needKeyText}</p>
          {hasKeyNow && onBack && (
            <button type="button" className={`${btnPrimary} w-full`} onClick={onBack}>
              {t('m.w3BackContinue')}
            </button>
          )}
        </div>
      )}
      {android && (
        <Chips label={t('m.transcribeTitle')} value={provider} onChange={selectProvider} options={[
          { value: 'cloud', label: t('m.providerGroq') },
          { value: 'bailian', label: t('m.providerBailian') },
          { value: 'custom', label: t('m.providerCustom') },
        ]} />
      )}
      {(!android || provider === 'cloud') && (
        <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
          <label htmlFor="groq" className="text-[15px] font-medium">Groq key</label>
          <input id="groq" type="text" autoComplete="off" className={keyField} placeholder={CLOUD.cloud.placeholder} value={trCfg.groqKey}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={e => patchTr({ groqKey: e.target.value })} />
          <p className="text-[13px] text-mute">
            {t('m.groqHelp')}{' '}
            <a className="text-accent" href={CLOUD.cloud.keysUrl} target="_blank" rel="noreferrer">console.groq.com/keys</a>
          </p>
        </div>
      )}
      {android && provider === 'bailian' && (
        <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
          <label htmlFor="bailian" className="text-[15px] font-medium">API Key</label>
          <input id="bailian" type="text" autoComplete="off" className={keyField} placeholder={CLOUD.bailian.placeholder} value={trCfg.bailianKey}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={e => patchTr({ bailianKey: e.target.value })} />
          <p className="text-[13px] text-mute">
            {t('m.bailianHelp')}{' '}
            <a className="text-accent break-all" href={CLOUD.bailian.keysUrl} target="_blank" rel="noreferrer">bailian.console.aliyun.com</a>
          </p>
        </div>
      )}
      {android && provider === 'custom' && (
        <div className={`${sheet} flex flex-col`}>
          <label className="px-4 py-3 flex flex-col gap-1.5 border-b border-shade">
            <span className="text-[15px]">{t('m.customUrl')}</span>
            <input type="url" className={field} placeholder={t('m.customUrlPlaceholder')} value={trCfg.customUrl}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={e => patchTr({ customUrl: e.target.value })} />
          </label>
          <label className="px-4 py-3 flex flex-col gap-1.5 border-b border-shade">
            <span className="text-[15px]">{t('m.customKey')}</span>
            <input type="text" autoComplete="off" className={keyField} value={trCfg.customKey}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={e => patchTr({ customKey: e.target.value })} />
          </label>
          <label className="px-4 py-3 flex flex-col gap-1.5">
            <span className="text-[15px]">{t('m.customModel')}</span>
            <input type="text" className={field} placeholder="whisper-1" value={trCfg.customModel}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onChange={e => patchTr({ customModel: e.target.value })} />
          </label>
          <p className="px-4 pb-3.5 text-[13px] text-mute">{t('m.customHelp')}</p>
        </div>
      )}
    </section>
  );
};
