import React, { useEffect } from 'react';
import { Download, FolderOpen, Loader2 } from 'lucide-react';
import { Btn, Field } from './ui';
import { useT } from '../utils/i18n';
import { revealInFolder } from '../utils/desktop';
import { downloadConvertTool, loadConvertTool, useConvertTool } from '../utils/convertTool';

// Settings → Import & transcribe: the video converter (utils/convertTool.ts). Download it
// ahead of time, and see where it lives.
const ConvertToolRow: React.FC = () => {
  const t = useT();
  const tool = useConvertTool();
  useEffect(() => { loadConvertTool(); }, []);
  const st = tool.status;
  return (
    <Field
      label={t('convert.settingLabel')}
      hint={t('convert.settingHint', { size: st ? Math.round(st.bytes / 1_000_000) : '…' })}
      right={st?.path && (
        <Btn type="button" size="sm" flat onClick={() => revealInFolder(st.path!).catch(err => console.error(err))}>
          <FolderOpen size={14} /> {t('convert.reveal')}
        </Btn>
      )}
    >
      <div className="space-y-2 text-sm">
        {tool.running ? (
          <span className="inline-flex items-center gap-2 text-mute"><Loader2 size={14} className="animate-spin" />{t('convert.downloading', { pct: tool.pct })}</span>
        ) : st?.path ? (
          <span className="text-mute">{t('convert.installed')}</span>
        ) : (
          <div className="flex items-center gap-3">
            {tool.failed && <span className="text-mute">{t('convert.failed')}</span>}
            <Btn size="sm" onClick={() => { downloadConvertTool(); }} disabled={!st}>
              <Download size={14} />{tool.failed ? t('convert.retry') : t('convert.download')}
            </Btn>
          </div>
        )}
        {st && <p className="text-xs font-mono text-mute break-all">{st.path ?? st.dir}</p>}
      </div>
    </Field>
  );
};

export default ConvertToolRow;
