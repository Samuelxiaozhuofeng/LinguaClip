import React, { useEffect, useState } from 'react';
import { Download, FolderOpen, Loader2 } from 'lucide-react';
import { Btn, Field, Group, Seg } from './ui';
import { useT } from '../utils/i18n';
import { revealInFolder, youtubeToolStatus, type YouTubeToolStatus } from '../utils/desktop';
import {
  YOUTUBE_QUALITIES, downloadYouTubeTool, setYouTubeEntry, setYouTubeQuality, useYouTubeEntry, useYouTubeQuality,
  useYouTubeToolDownload,
} from '../utils/youtube';

// Settings → Import & transcribe → YouTube (docs/youtube.md): the home entry on / off,
// the quality a pick downloads at, and the parts (yt-dlp, deno, ffmpeg) it needs.
const SettingsYouTube: React.FC = () => {
  const t = useT();
  const entry = useYouTubeEntry();
  const quality = useYouTubeQuality();
  const [st, setSt] = useState<YouTubeToolStatus | null>(null);
  const { pct, failed } = useYouTubeToolDownload();
  const load = () => youtubeToolStatus().then(setSt).catch(err => console.error(err));
  const idle = pct === null;
  useEffect(() => { load(); }, [idle]); // on open, and again when a download ends

  const install = () => { downloadYouTubeTool(); };

  return (
    <Group title={t('settings.group.youtube')}>
      <div>
        <label className="flex items-center gap-2.5 text-sm cursor-pointer">
          <input type="checkbox" checked={entry} onChange={e => setYouTubeEntry(e.target.checked)} className="w-4 h-4 accent-accent" />
          {t('youtube.settingEntry')}
        </label>
        <span className="block mt-1.5 text-xs text-mute leading-relaxed">{t('youtube.settingEntryHint')}</span>
      </div>

      <Field label={t('youtube.settingQuality')} hint={t('youtube.settingQualityHint')}>
        <Seg size="sm" value={quality} onChange={setYouTubeQuality}
          options={YOUTUBE_QUALITIES.map(q => ({ value: q, label: `${q}p` }))} />
      </Field>

      <Field
        label={t('youtube.settingTool')}
        hint={t('youtube.settingToolHint')}
        right={st?.path && (
          <Btn type="button" size="sm" flat onClick={() => revealInFolder(st.path!).catch(err => console.error(err))}>
            <FolderOpen size={14} /> {t('convert.reveal')}
          </Btn>
        )}
      >
        <div className="space-y-2 text-sm">
          {pct !== null ? (
            <span className="inline-flex items-center gap-2 text-mute"><Loader2 size={14} className="animate-spin" />{t('youtube.toolDownloading', { pct })}</span>
          ) : st?.ready ? (
            <span className="text-mute">{t('youtube.toolReady')}</span>
          ) : (
            <div className="flex items-center gap-3">
              {failed && <span className="text-mute">{t('youtube.toolFailed')}</span>}
              <Btn size="sm" onClick={install} disabled={!st}>
                <Download size={14} />{t('youtube.toolDownload', { size: st ? Math.ceil(st.bytes / 1_000_000) : '…' })}
              </Btn>
            </div>
          )}
          {st && <p className="text-xs font-mono text-mute break-all">{st.path ?? st.dir}</p>}
        </div>
      </Field>
    </Group>
  );
};

export default SettingsYouTube;
