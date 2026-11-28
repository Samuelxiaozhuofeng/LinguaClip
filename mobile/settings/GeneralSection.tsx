// Phone Settings → General tab: practice switches, appearance (light / dark), UI language,
// podcast Wi-Fi-only, battery whitelist guide (Android), and supporter activation.
import React, { useEffect, useState } from 'react';
import { setLang, useLang, useT, type Lang } from '../../utils/i18n';
import { useThemePref, type ThemePref } from '../../utils/theme';
import { btnSmall, btnSoft, sheet } from '../ui';
import { callAndroid, isAndroidNative } from '../platform/androidBridge';
import { getPodcastWifiOnly, setPodcastWifiOnly } from '../opml';
import { PracticeSection } from './PracticeSection';
import { SupporterSection } from './SupporterSection';
import { Chips } from './Chips';

const BATTERY_DISMISSED_KEY = 'linguaclip_android_battery_dismissed';

const Battery: React.FC = () => {
  const t = useT();
  const [ignoring, setIgnoring] = useState<boolean | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(BATTERY_DISMISSED_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      callAndroid<{ ignoring: boolean }>('system.isIgnoringBatteryOptimizations')
        .then(res => { if (alive) setIgnoring(!!res?.ignoring); }, () => { if (alive) setIgnoring(false); });
    };
    refresh();
    const onVis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis); };
  }, []);

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-mute">{t('m.batteryTitle')}</p>
      <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
        {ignoring === true ? (
          <p className="text-[14px] text-ink">{t('m.batteryOk')}</p>
        ) : (
          <>
            {ignoring === false && (
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
              {ignoring === false && (
                <button type="button" className={btnSoft} disabled={dismissed}
                  onClick={() => {
                    try { localStorage.setItem(BATTERY_DISMISSED_KEY, '1'); } catch { /* ignore */ }
                    setDismissed(true);
                  }}>
                  {dismissed ? `✓ ${t('m.batteryDismiss')}` : t('m.batteryDismiss')}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
};

export const GeneralSection: React.FC = () => {
  const t = useT();
  const ui = useLang();
  const android = isAndroidNative();
  const [theme, setTheme] = useThemePref();
  const [wifiOnly, setWifiOnly] = useState<boolean>(getPodcastWifiOnly);

  return (
    <>
      <section className="flex flex-col gap-2" data-testid="settings-theme">
        <p className="text-[13px] text-mute">{t('theme.title')}</p>
        <Chips<ThemePref> label={t('theme.title')} value={theme} onChange={setTheme} options={[
          { value: 'system', label: t('theme.system') },
          { value: 'light', label: t('theme.light') },
          { value: 'dark', label: t('theme.dark') },
        ]} />
        <p className="text-[13px] text-mute px-1">{t('theme.hint')}</p>
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

      <label className={`${sheet} px-4 py-3 flex items-center justify-between gap-3`}>
        <span className="text-[15px]">{t('settings.language')}</span>
        <select value={ui} onChange={e => setLang(e.target.value as Lang)} className="min-h-[44px] bg-transparent text-[15px] text-mute">
          <option value="zh">中文</option>
          <option value="en">English</option>
        </select>
      </label>

      {android && <Battery />}
      <SupporterSection />
    </>
  );
};
