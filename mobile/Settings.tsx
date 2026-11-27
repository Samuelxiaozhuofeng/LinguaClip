// Phone settings (design Settings.dc.html): cloud transcription (Groq on PWA; Groq / Bailian /
// custom OpenAI-compatible on Android), AI config, practice switches, podcast Wi-Fi-only &
// dictionary choices, export / undoable restore (BackupSection), battery whitelist guide, and UI language.
import React, { useEffect, useState } from 'react';
import { CLOUD, androidCloudArgs, getTranscribeConfig, saveTranscribeConfig, type TranscribeConfig } from '../utils/transcribeConfig';
import { getAIConfig, saveAIConfig } from '../utils/aiConfig';
import { setLang, useLang, useT, type Lang } from '../utils/i18n';
import type { AIConfig } from '../types';
import { Header, btnPrimary, btnSmall, btnSoft, sheet } from './ui';
import { callAndroid, isAndroidNative } from './platform/androidBridge';
import { getPodcastWifiOnly, setPodcastWifiOnly } from './opml';
import { groqKey } from './transcribe';
import { PracticeSection } from './settings/PracticeSection';
import { DictSection } from './settings/DictSection';
import { ClipsSection } from './settings/ClipsSection';
import { AnkiSection } from './settings/AnkiSection';
import { SyncSection } from './settings/SyncSection';
import { BackupSection } from './settings/BackupSection';
import { SupporterSection } from './settings/SupporterSection';

const field = 'h-11 rounded-[10px] border border-line px-3 text-[15px] w-full bg-page';
const BATTERY_DISMISSED_KEY = 'linguaclip_android_battery_dismissed';
const AI_KEYS_URL = 'https://platform.deepseek.com/api_keys';

type AndroidProvider = 'cloud' | 'bailian' | 'custom';

const resolveAndroidMode = (cfg: TranscribeConfig): AndroidProvider => {
  if (cfg.mode !== 'local') return cfg.mode;
  const resolved = androidCloudArgs(cfg);
  if (resolved?.provider === 'bailian') return 'bailian';
  if (resolved?.provider === 'custom') return 'custom';
  return 'cloud';
};

export const Settings: React.FC<{ needKey: boolean; onBack?: () => void }> = ({ needKey, onBack }) => {
  const t = useT();
  const ui = useLang();
  const android = isAndroidNative();

  const [trCfg, setTrCfg] = useState<TranscribeConfig>(getTranscribeConfig);
  const [provider, setProvider] = useState<AndroidProvider>(() => resolveAndroidMode(getTranscribeConfig()));
  const [ai, setAi] = useState(getAIConfig);
  const [wifiOnly, setWifiOnly] = useState<boolean>(getPodcastWifiOnly);
  const [batteryIgnoring, setBatteryIgnoring] = useState<boolean | null>(null);
  const [batteryDismissed, setBatteryDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(BATTERY_DISMISSED_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (!android) return;
    let alive = true;
    const refresh = () => {
      callAndroid<{ ignoring: boolean }>('system.isIgnoringBatteryOptimizations')
        .then(res => { if (alive) setBatteryIgnoring(!!res?.ignoring); }, () => { if (alive) setBatteryIgnoring(false); });
    };
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, [android]);

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

  const setAiField = (k: keyof Pick<AIConfig, 'baseUrl' | 'apiKey' | 'model'>, v: string) => {
    const next = { ...getAIConfig(), [k]: v.trim() };
    saveAIConfig(next);
    setAi(prev => ({ ...prev, [k]: v }));
  };

  const row = (k: 'baseUrl' | 'apiKey' | 'model', label: string, type = 'text') => (
    <label className="px-4 py-3 flex flex-col gap-1.5 border-b border-shade last:border-0">
      <span className="text-[15px]">{label}</span>
      <input type={type} className={field} value={ai[k] ?? ''} autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onChange={e => setAiField(k, e.target.value)} />
    </label>
  );

  const providers: { mode: AndroidProvider; label: string }[] = [
    { mode: 'cloud', label: t('m.providerGroq') },
    { mode: 'bailian', label: t('m.providerBailian') },
    { mode: 'custom', label: t('m.providerCustom') },
  ];

  const needKeyText = !android || provider === 'cloud'
    ? t('m.w3NeedKeyProvider', { provider: 'Groq' })
    : provider === 'bailian'
      ? t('m.w3NeedKeyProvider', { provider: t('transcribe.bailian') })
      : t('m.w3NeedKeyCustom');
  const hasKeyNow = android ? !!androidCloudArgs(trCfg) : !!groqKey();

  return (
    <>
      {onBack ? <Header title={t('m.settings')} onBack={onBack} /> : <h1 className="pt-4 px-5 pb-2 text-[17px] font-semibold">{t('m.settings')}</h1>}
      <div className="px-5 pt-2 pb-10 flex flex-col gap-5">
        <p data-testid="settings-no-key-tip" className={`${sheet} px-4 py-3 text-[13px] text-mute leading-relaxed shadow-card`}>
          {t('m.w3SettingsNoKeyBanner')}
        </p>

        <section className="flex flex-col gap-2">
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
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('m.transcribeTitle')}>
              {providers.map(p => (
                <button key={p.mode} type="button" role="radio" aria-checked={provider === p.mode}
                  onClick={() => selectProvider(p.mode)}
                  className={`min-h-[40px] px-3.5 rounded-full text-[13px] ${provider === p.mode ? 'bg-ink text-white font-medium' : 'bg-page text-mute shadow-card'}`}>
                  {p.label}
                </button>
              ))}
            </div>
          )}
          {(!android || provider === 'cloud') && (
            <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
              <label htmlFor="groq" className="text-[15px] font-medium">Groq key</label>
              <input id="groq" type="password" className={field} placeholder={CLOUD.cloud.placeholder} value={trCfg.groqKey}
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
              <input id="bailian" type="password" className={field} placeholder={CLOUD.bailian.placeholder} value={trCfg.bailianKey}
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
                <input type="password" className={field} value={trCfg.customKey}
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

        <section className="flex flex-col gap-2">
          <p className="text-[13px] text-mute">{t('m.aiTitle')}</p>
          <div className={`${sheet} flex flex-col`}>
            {row('baseUrl', t('m.aiUrl'))}
            {row('apiKey', t('m.aiKey'), 'password')}
            {row('model', t('m.aiModel'))}
          </div>
          <p className="text-[13px] text-mute px-1">{t('m.aiHelp')}</p>
          <p className="text-[13px] text-mute px-1">
            {t('m.w3AiRecommend')}{' '}
            <a className="text-accent break-all" href={AI_KEYS_URL} target="_blank" rel="noreferrer">platform.deepseek.com/api_keys</a>
          </p>
        </section>

        <PracticeSection />

        {android && (
          <section className="flex flex-col gap-2">
            <label className={`${sheet} px-4 py-3.5 flex items-center justify-between gap-3`}>
              <span className="flex flex-col gap-0.5">
                <span className="text-[15px]">{t('m.wifiOnlyTitle')}</span>
                <span className="text-[13px] text-mute">{t('m.wifiOnlyHelp')}</span>
              </span>
              <input type="checkbox" checked={wifiOnly} className="w-5 h-5 shrink-0 accent-accent"
                onChange={e => { setWifiOnly(e.target.checked); setPodcastWifiOnly(e.target.checked); }} />
            </label>
          </section>
        )}

        <DictSection />
        <ClipsSection />
        <AnkiSection />
        <SyncSection />
        <BackupSection />

        {android && (
          <section className="flex flex-col gap-2">
            <p className="text-[13px] text-mute">{t('m.batteryTitle')}</p>
            <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
              {batteryIgnoring === true ? (
                <p className="text-[14px] text-ink">{t('m.batteryOk')}</p>
              ) : (
                <>
                  {batteryIgnoring === false && (
                    <>
                      <p className="text-[14px] text-accent">{t('m.batteryWarn')}</p>
                      <p className="text-[13px] text-mute leading-relaxed">{t('m.batterySteps')}</p>
                    </>
                  )}
                  <div className="flex flex-wrap gap-2 pt-0.5">
                    <button type="button" className={btnSmall}
                      onClick={() => { callAndroid('system.openBatterySettings').catch(console.error); }}>
                      {t('m.batteryOpen')}
                    </button>
                    {batteryIgnoring === false && (
                      <button type="button" className={btnSoft} disabled={batteryDismissed}
                        onClick={() => {
                          try { localStorage.setItem(BATTERY_DISMISSED_KEY, '1'); } catch { /* ignore */ }
                          setBatteryDismissed(true);
                        }}>
                        {batteryDismissed ? `✓ ${t('m.batteryDismiss')}` : t('m.batteryDismiss')}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        <SupporterSection />

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
