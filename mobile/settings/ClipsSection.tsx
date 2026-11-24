// Settings → Clips section (docs/android-roadmap.md M2.5): Android-native only.
// Runtime clip hooks are registered by androidInit.android.ts so PWA builds never bundle utils/clips.ts.
import React, { useEffect, useState, useSyncExternalStore } from 'react';
import type { ClipProgress } from '../../utils/clips';
import { getPracticeConfig, savePracticeConfig } from '../../utils/storage';
import { useT } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { sheet } from '../ui';

export interface ClipsRuntime {
  getClipProgress: () => ClipProgress;
  subscribeClips: (fn: () => void) => () => void;
  retryClips: () => Promise<void>;
  clipsInfo: () => Promise<{ dir: string; bytes: number }>;
}

const EMPTY: ClipProgress = { running: false, saved: 0, total: 0, noVideo: 0, error: null };
let runtime: ClipsRuntime | null = null;
const runtimeListeners = new Set<() => void>();

export function registerClipsRuntime(api: ClipsRuntime): void {
  runtime = api;
  runtimeListeners.forEach(fn => fn());
}

const subscribe = (fn: () => void) => {
  let offClips = runtime ? runtime.subscribeClips(fn) : null;
  const onReg = () => {
    offClips?.();
    offClips = runtime ? runtime.subscribeClips(fn) : null;
    fn();
  };
  runtimeListeners.add(onReg);
  return () => {
    runtimeListeners.delete(onReg);
    offClips?.();
  };
};

const getSnapshot = (): ClipProgress => runtime?.getClipProgress() ?? EMPTY;

const formatBytes = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(bytes < 10e6 ? 1 : 0)} MB`;
  return `${(bytes / 1e9).toFixed(1)} GB`;
};

export const ClipsSection: React.FC = () => {
  const android = isAndroidNative();
  const t = useT();
  const [on, setOn] = useState(() => getPracticeConfig().saveClips ?? false);
  const p = useSyncExternalStore(subscribe, getSnapshot);
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!android || !runtime) return;
    let alive = true;
    runtime.clipsInfo()
      .then(info => { if (alive) setBytes(info.bytes); })
      .catch(() => { if (alive) setBytes(null); });
    return () => { alive = false; };
  }, [android, on, p.saved, p.running]);

  if (!android) return null;

  const toggle = (checked: boolean) => {
    setOn(checked);
    // Only touch saveClips; keep practice_config.clipKind untouched for cross-platform backup fidelity.
    savePracticeConfig({ ...getPracticeConfig(), saveClips: checked });
    if (checked) void runtime?.retryClips().catch(console.error);
  };

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[13px] text-mute">{t('m.clipsTitle')}</p>
      <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
        <label className="flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-[15px]">{t('m.clipsLabel')}</span>
            <span className="text-xs text-mute leading-relaxed">{t('m.clipsHint')}</span>
          </span>
          <input
            type="checkbox"
            checked={on}
            className="w-5 h-5 mt-0.5 shrink-0 accent-accent"
            onChange={e => toggle(e.target.checked)}
          />
        </label>
        {(on || p.running) && (
          <div className="pt-1 border-t border-shade flex flex-col gap-1 text-xs text-mute">
            <p>
              {p.running ? `${t('m.clipsSaving')} ` : ''}
              {bytes !== null && bytes > 0
                ? t('m.clipsStatusSize', { saved: p.saved, total: p.total, size: formatBytes(bytes) })
                : t('m.clipsStatus', { saved: p.saved, total: p.total })}
            </p>
            {p.noVideo > 0 && <p>{t('m.clipsNoVideo', { n: p.noVideo })}</p>}
            {p.error && <p className="text-accent break-all">{t('m.clipsError', { err: p.error })}</p>}
          </div>
        )}
      </div>
    </section>
  );
};
