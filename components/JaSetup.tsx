import React, { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { Btn, Field } from './ui';
import { useT } from '../utils/i18n';
import { deleteJa, downloadJa, loadJa, useJaState } from '../utils/japanese';

// The Japanese word-splitting dictionary is a download of its own (utils/japanese.ts):
// a banner on the practice page of a Japanese video, and a row in Settings → Practice.

const Progress: React.FC<{ pct: number }> = ({ pct }) => {
  const t = useT();
  return <span className="inline-flex items-center gap-2 text-mute"><Loader2 size={14} className="animate-spin" />{t('ja.downloading', { pct })}</span>;
};

export const JaBanner: React.FC = () => {
  const t = useT();
  const ja = useJaState();
  const [hidden, setHidden] = useState(false); // this visit only; it asks again next time
  if (hidden || ja.ready || (ja.installed !== false && !ja.failed)) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-line px-4 py-3 text-sm fade-in">
      <p className="flex-1 min-w-0 leading-relaxed">
        {ja.running ? <Progress pct={ja.pct} /> : ja.failed ? t('ja.failed') : t('ja.bannerBody')}
      </p>
      {!ja.running && (
        <Btn size="sm" tone="accent" onClick={() => { downloadJa(); }}>
          <Download size={14} />{ja.failed ? t('ja.retry') : t('ja.download')}
        </Btn>
      )}
      <Btn square size="sm" flat onClick={() => setHidden(true)} title={t('ja.later')} aria-label={t('ja.later')}><X size={15} /></Btn>
    </div>
  );
};

export const JaDictRow: React.FC = () => {
  const t = useT();
  const ja = useJaState();
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (ja.installed === null) loadJa(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const remove = async () => {
    setBusy(true);
    await deleteJa().catch(console.error);
    setBusy(false);
  };
  return (
    <Field label={t('ja.settingLabel')} hint={t('ja.settingHint')}>
      <div className="flex items-center gap-3 text-sm">
        {ja.running ? <Progress pct={ja.pct} /> : ja.installed ? (
          <>
            <span className="text-mute">{t('ja.installed')}</span>
            <Btn size="sm" onClick={remove} disabled={busy}>{t('ja.remove')}</Btn>
          </>
        ) : (
          <>
            {ja.failed && <span className="text-mute">{t('ja.failedShort')}</span>}
            <Btn size="sm" onClick={() => { downloadJa(); }} disabled={ja.installed === null}>
              <Download size={14} />{ja.failed ? t('ja.retry') : t('ja.download')}
            </Btn>
          </>
        )}
      </div>
    </Field>
  );
};
