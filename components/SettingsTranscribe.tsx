import React, { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen } from 'lucide-react';
import { isBadKey } from '../utils/aiConfig';
import { listGpus, openExternal, revealInFolder, transcribeLocation } from '../utils/desktop';
import {
  CLOUD,
  LocalModel,
  TranscribeConfig,
  TranscribeMode,
  getTranscribeConfig,
  saveTranscribeConfig,
} from '../utils/transcribeConfig';
import { useT } from '../utils/i18n';
import { IS_WINDOWS } from '../utils/platform';
import { Btn, Field, Group, Seg, inputCls } from './ui';
import ConvertToolRow from './ConvertToolRow';

// Settings → Import & transcribe: this machine (standard / light model, graphics card
// on Windows, where its parts live) or a cloud service (link to get a key, the key itself),
// the video converter; `children` is what the AI does with the transcript.
const SettingsTranscribe: React.FC<{ onSaved: () => void; children: React.ReactNode }> = ({ onSaved, children }) => {
  const t = useT();
  const [config, setConfig] = useState<TranscribeConfig>(getTranscribeConfig);
  const [location, setLocation] = useState<{ dir: string; model: string | null } | null>(null);
  const [gpus, setGpus] = useState<{ name: string; discrete: boolean }[]>([]);
  const cloud = config.mode === 'local' ? null : CLOUD[config.mode];
  const key = cloud ? config[cloud.keyField] : '';
  const badKey = !!key && isBadKey(key.trim());

  const update = (patch: Partial<TranscribeConfig>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveTranscribeConfig(next);
    onSaved();
  };

  useEffect(() => {
    if (config.mode !== 'local') return;
    let cancelled = false;
    transcribeLocation(config.localModel)
      .then(loc => { if (!cancelled) setLocation(loc); })
      .catch(err => console.error(err));
    return () => { cancelled = true; };
  }, [config.mode, config.localModel]);

  const showGpus = IS_WINDOWS && config.mode === 'local' && config.gpu;
  useEffect(() => {
    if (!showGpus) return;
    let cancelled = false;
    listGpus()
      .then(list => { if (!cancelled) setGpus(list); })
      .catch(err => console.error(err));
    return () => { cancelled = true; };
  }, [showGpus]);

  return (
    <div className="space-y-10">
      <Group title={t('settings.group.transcribe')}>
        <Field label={t('transcribe.mode')} hint={t(config.mode === 'cloud' ? 'transcribe.cloudHint' : config.mode === 'bailian' ? 'transcribe.bailianHint' : 'transcribe.localHint')}>
          <Seg<TranscribeMode>
            value={config.mode}
            onChange={mode => update({ mode })}
            options={[
              { value: 'local', label: t('transcribe.local') },
              { value: 'cloud', label: t('transcribe.cloud') },
              { value: 'bailian', label: t('transcribe.bailian') },
            ]}
          />
        </Field>

        {config.mode === 'local' && (
          <>
            <Field label={t('transcribe.model')} hint={t('transcribe.modelHint')}>
              <Seg<LocalModel>
                value={config.localModel}
                onChange={localModel => update({ localModel })}
                options={[
                  { value: 'standard', label: t('transcribe.standard') },
                  { value: 'light', label: t('transcribe.light') },
                ]}
              />
            </Field>

            {IS_WINDOWS && (
              <Field label={t('transcribe.gpu')} hint={t('transcribe.gpuHint')}>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="checkbox" checked={config.gpu} onChange={e => update({ gpu: e.target.checked })} className="w-4 h-4 accent-accent" />
                  {t('transcribe.gpuLabel')}
                </label>
              </Field>
            )}

            {showGpus && (
              <Field label={t('transcribe.gpuWhich')}>
                {/* A saved card that is not there now runs as automatic (gpus.rs), so it shows as that. */}
                <select
                  value={gpus.some(g => g.name === config.gpuName) ? config.gpuName : ''}
                  onChange={e => update({ gpuName: e.target.value })}
                  className={inputCls}
                >
                  <option value="">{t('transcribe.gpuAuto')}</option>
                  {gpus.map((g, i) => (
                    <option key={i} value={g.name}>
                      {g.name}{t(g.discrete ? 'transcribe.gpuDiscrete' : 'transcribe.gpuIntegrated')}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {location && (
              <Field
                label={t('transcribe.location')}
                right={location.model && (
                  <Btn type="button" size="sm" flat onClick={() => revealInFolder(location.model!).catch(err => console.error(err))}>
                    <FolderOpen size={14} /> {t('transcribe.reveal')}
                  </Btn>
                )}
                hint={location.model ? undefined : t('transcribe.notDownloaded')}
              >
                <p className="text-xs font-mono text-mute break-all">{location.model ?? location.dir}</p>
              </Field>
            )}
          </>
        )}

        {cloud && (
          <Field
            key={config.mode}
            label={t('transcribe.cloudKey', { name: t(cloud.name) })}
            right={
              <Btn type="button" size="sm" flat onClick={() => openExternal(cloud.keysUrl).catch(err => console.error(err))}>
                <ExternalLink size={14} /> {t(config.mode === 'cloud' ? 'transcribe.getKey' : 'transcribe.getBailianKey')}
              </Btn>
            }
            hint={badKey ? <span className="text-ink">{t('settingsAI.apiKeyBad')}</span> : t(config.mode === 'cloud' ? 'transcribe.groqKeyHint' : 'transcribe.bailianKeyHint')}
          >
            <input
              type="password"
              value={key}
              onChange={e => update({ [cloud.keyField]: e.target.value })}
              className={`${inputCls} font-mono`}
              placeholder={cloud.placeholder}
            />
          </Field>
        )}
      </Group>

      <Group title={t('settings.group.videoFormat')}>
        <ConvertToolRow />
      </Group>

      {children}
    </div>
  );
};

export default SettingsTranscribe;
