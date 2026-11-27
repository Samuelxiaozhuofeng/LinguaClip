import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { FolderOpen, Loader2 } from 'lucide-react';
import { Btn, Card, Field, Group, Seg } from './ui';
import { clipsInfo, openExternal, revealInFolder } from '../utils/desktop';
import { getClipProgress, retryClips, subscribeClips } from '../utils/clips';
import { downloadConvertTool, loadConvertTool, useConvertTool } from '../utils/convertTool';
import ConvertToolRow from './ConvertToolRow';
import SettingsFold from './SettingsFold';
import SettingsSync from './SettingsSync';
import BackupRow from './BackupRow';
import SettingsShortcuts from './SettingsShortcuts';
import { UpdateRow } from './UpdateUI';
import { ProFooter } from '@pro';
import { useT } from '../utils/i18n';
import { getAudioPaddingConfig, getPracticeConfig, saveAudioPaddingConfig, savePracticeConfig } from '../utils/storage';

const SPONSOR_URL = 'https://afdian.com/a/SamuelXiao';

// Cards keep their own clip of the line (utils/clips.ts): on / off, which kind, and how far along.
const ClipsRow: React.FC<{ onSaved: () => void; clipsVer: number }> = ({ onSaved, clipsVer }) => {
  const t = useT();
  const [on, setOn] = useState(() => getPracticeConfig().saveClips ?? false);
  const [kind, setKind] = useState(() => getPracticeConfig().clipKind ?? 'video');
  const p = useSyncExternalStore(subscribeClips, getClipProgress);
  const tool = useConvertTool();
  useEffect(() => { loadConvertTool(); }, []);
  useEffect(() => {
    const cfg = getPracticeConfig();
    setOn(cfg.saveClips ?? false);
    setKind(cfg.clipKind ?? 'video');
  }, [clipsVer]);
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

interface SettingsDataProps {
  onSaved: () => void;
  clipsVer: number;
  onClipsChanged: () => void;
  anki: React.ReactNode;
}

// Settings → Data & general: card clips & audio padding, Anki, sync, backup, shortcuts, and about/support.
const SettingsData: React.FC<SettingsDataProps> = ({ onSaved, clipsVer, onClipsChanged, anki }) => {
  const t = useT();
  const [audioPadding, setPadding] = useState(getAudioPaddingConfig);
  const setAudioPadding = (v: typeof audioPadding) => { setPadding(v); saveAudioPaddingConfig(v); onSaved(); };

  return (
    <div className="space-y-10">
      <Group title={t('settings.group.cardAudio')}>
        <ClipsRow onSaved={onSaved} clipsVer={clipsVer} />
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

      <Group title={t('settings.group.anki')}>
        {anki}
      </Group>

      <SettingsSync onClipsChanged={onClipsChanged} />

      <Group title={t('settings.group.backup')}>
        <Card flat className="p-5 [&>div]:!mt-0">
          <BackupRow />
        </Card>
      </Group>

      <SettingsFold title={t('settings.group.shortcuts')}>
        <SettingsShortcuts onSaved={onSaved} />
      </SettingsFold>

      <Group title={t('settings.group.about')}>
        <Card flat className="p-5 space-y-2 text-center text-xs text-mute">
          <p>
            {ProFooter ? <ProFooter /> : (
              <button
                type="button"
                className="underline-offset-4 hover:text-ink hover:underline"
                onClick={() => openExternal(SPONSOR_URL).catch(err => console.error(err))}
              >
                {t('settings.sponsor')}
              </button>
            )}
          </p>
          <UpdateRow />
        </Card>
      </Group>
    </div>
  );
};

export default SettingsData;
