// The phone's home (design Main.dc.html): install tip, "continue" card, the practiced
// list with each import's state (or "audio not on this phone" + pick it again, after a
// restore), the ready-made episodes, and the two ways to add audio.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { deleteRecord, importFile, retryImport } from './importAudio';
import { MAX_BYTES, NO_MEDIA } from './transcribe';
import { Starter } from './Starter';
import { audioIds, putAudio } from './store';
import { blobId } from './backup';
import { btnPlain, btnPrimary, errText, heardPct, sheet, sourceOf } from './ui';

const HINT_KEY = 'linguaclip_install_hint_closed';
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function InstallHint() {
  const t = useT();
  const [shown, setShown] = useState(() => !standalone() && !localStorage.getItem(HINT_KEY));
  if (!shown) return null;
  return (
    <div className="mx-5 mb-3 px-3 py-2.5 bg-page rounded-xl flex items-center gap-2.5 text-[13px] text-mute">
      <span className="flex-1">{t(ios() ? 'm.installIos' : 'm.installAndroid')}</span>
      <button aria-label={t('m.hideHint')} className="w-11 h-11 shrink-0 text-lg" onClick={() => { localStorage.setItem(HINT_KEY, '1'); setShown(false); }}>×</button>
    </div>
  );
}

// A finished or stopped record whose phone audio isn't stored here (restored from a backup):
// its blob id. An import still running has its file (`have` may just not be reloaded yet).
const missingId = (r: VideoRecord, have: Set<string> | null) => {
  const id = blobId(r.videoPath ?? r.importJob?.source);
  return have && id && !have.has(id) && (!r.importJob || r.importJob.error) ? id : null;
};

function Row({ r, missing, onOpen, onFixed }: { r: VideoRecord; missing: string | null; onOpen: (id: string) => void; onFixed: () => void }) {
  const t = useT();
  const job = r.importJob;
  const input = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState('');
  const remove = () => { if (confirm(t('m.confirmDelete', { name: r.displayName }))) deleteRecord(r.id).catch(console.error); };
  // Stored under the id the record already points at; the transcript stays as it is, an
  // unfinished import goes on transcribing.
  const repick = (f: File) => {
    if (!missing) return;
    if (job && f.size > MAX_BYTES) { setErr(errText('file:toolarge')); return; } // it could never be transcribed
    setErr('');
    putAudio(missing, { blob: f, name: f.name, type: f.type }).then(() => {
      onFixed();
      if (job) retryImport(r.id).catch(console.error);
    }, (e: unknown) => setErr(t('m.errSave', { msg: e instanceof Error ? e.message : String(e) })));
  };
  const state = err || (missing ? t('m.audioGone')
    : job ? job.error ? t('m.failed', { why: errText(job.error) }) : t(job.stage === 'segment' ? 'm.segmenting' : 'm.transcribing')
    : t('m.doneRate', { n: heardPct(r) }));
  return (
    <li data-id={r.id} className="flex items-center border-b border-shade last:border-0">
      <button disabled={!!job || !!missing} onClick={() => onOpen(r.id)} className="flex-1 min-w-0 min-h-[56px] pl-4 py-3 text-left flex flex-col gap-0.5">
        <span className="text-[15px] truncate">{r.displayName}</span>
        <span className={`text-xs ${job?.error || missing ? 'text-accent' : 'text-mute'}`}>{sourceOf(r)} · {state}</span>
      </button>
      {job?.error && !missing && job.error !== NO_MEDIA && <button className="min-h-[44px] px-3 text-sm text-accent font-medium" onClick={() => { retryImport(r.id).catch(console.error); }}>{t('m.retry')}</button>}
      {missing && <>
        <button className="min-h-[44px] px-3 text-sm text-accent font-medium" onClick={() => input.current?.click()}>{t('m.repick')}</button>
        <input ref={input} type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) repick(f); }} />
      </>}
      <button aria-label={t('m.more')} className="w-11 h-11 mr-1 text-mute" onClick={remove}>…</button>
    </li>
  );
}

export const Home: React.FC<{
  records: VideoRecord[]; onOpen: (id: string) => void; onPodcast: () => void; onNeedKey: () => void; onChanged: () => void;
}> = ({ records, onOpen, onPodcast, onNeedKey, onChanged }) => {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState('');
  const [have, setHave] = useState<Set<string> | null>(null); // audio stored here; null = unknown, nothing flagged
  const loadAudio = useCallback(() => { audioIds().then(ids => setHave(new Set(ids)), console.error); }, []);
  useEffect(loadAudio, [records, loadAudio]);
  const last = records.find(r => !r.importJob && r.videoPath && !missingId(r, have));
  const pick = (f: File) => {
    setNote('');
    importFile(f, 'auto').then(onChanged, (e: unknown) => {
      const code = e instanceof Error ? e.message : String(e);
      if (code === 'cloud:nokey') onNeedKey();
      else setNote(code === 'file:toolarge' ? errText(code) : t('m.errSave', { msg: code }));
    });
  };
  const starter = <Starter records={records} onOpen={onOpen} onChanged={onChanged} />;

  return (
    <>
      <InstallHint />
      <div className="flex-1 px-5 flex flex-col gap-3 pb-[calc(100px+env(safe-area-inset-bottom))]">
        {records.length === 0 && starter}
        {last && <>
          <p className="text-[13px] text-mute mt-1">{t('m.continue')}</p>
          <button onClick={() => onOpen(last.id)} className={`${sheet} shadow-card p-4 flex flex-col gap-2.5 text-left`}>
            <span className="text-xs text-mute">{last.podcast?.show ? `${last.podcast.show} · ` : ''}{sourceOf(last)}</span>
            <span className="font-serif text-[19px] leading-snug">{last.displayName}</span>
            <span className="h-1 bg-shade rounded"><span className="block h-1 bg-accent rounded" style={{ width: `${heardPct(last)}%` }} /></span>
            <span className="flex justify-between text-[13px] text-mute w-full"><span>{t('m.doneRate', { n: heardPct(last) })}</span><span className="text-accent font-semibold">{t('m.continueGo')}</span></span>
          </button>
        </>}
        {records.length > 0 && <>
          <p className="text-[13px] text-mute mt-2">{t('m.practiced')}</p>
          <ul className={`${sheet} flex flex-col`}>{records.map(r => <Row key={r.id} r={r} missing={missingId(r, have)} onOpen={onOpen} onFixed={loadAudio} />)}</ul>
          <div className="mt-4">{starter}</div>
        </>}
      </div>
      <div className="sticky bottom-0 px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] bg-gradient-to-t from-paper from-70% to-transparent">
        {note && <p role="alert" className="mb-2 text-[13px] text-accent">{note}</p>}
        <div className="grid grid-cols-2 gap-2.5">
          <button className={btnPrimary} onClick={onPodcast}>{t('m.podcast')}</button>
          <button className={btnPlain} onClick={() => input.current?.click()}>{t('m.pickFile')}</button>
        </div>
        <input ref={input} type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) pick(f); }} />
      </div>
    </>
  );
};
