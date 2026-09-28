import React, { useEffect, useMemo, useState } from 'react';
import { BlurPlaybackMode, LearningMode, VideoRecord } from '../types';
import { Btn, Card, Seg } from './ui';
import { useT } from '../utils/i18n';
import { parseSRT } from '../utils/srtParser';
import { canCloze } from '../utils/aiDrills';
import { CustomConfig, CustomPick, LEVELS, Level, LineLabel, MINUTE_CHOICES, PaceMode, pickCustom } from '../utils/customPick';
import { getLevelJob, prepareLevels, readLevels, subscribeLevels } from '../utils/levelPrep';
import { formatTimeCode, getCustomConfig, getCustomPos, getWatchPrefs, ReadBy, saveCustomConfig, saveWatchPrefs } from '../utils/storage';

// Asked before every practice session: section by section as before, or a
// custom set — so many minutes, at a level, from where the last set stopped —
// or just watching (components/WatchPage.tsx), or reading the subtitles first
// (components/ReaderPage.tsx). The last way chosen comes back — never "read": that
// comes before practice, and the panel reopens after it to pick the practice.
// Esc / clicking outside cancels; it never counts as a choice.

export type PanelChoice = { kind: 'all' } | { kind: 'watch' } | { kind: 'read'; by: ReadBy } | { kind: 'custom'; cfg: CustomConfig; pick: CustomPick };

export const paceOf = (lm: LearningMode, bpm?: BlurPlaybackMode): PaceMode =>
  lm === LearningMode.DICTATION ? 'dictation' : bpm === BlurPlaybackMode.CONTINUOUS ? 'flow' : 'step';

const needsLabels = (cfg: CustomConfig) => cfg.level !== null && canCloze();

// The next set for "next set" on the done overlay: same choices, from the saved
// position. Only the saved labels — never waits on the AI.
export async function nextPick(record: VideoRecord, cfg: CustomConfig, pace: PaceMode): Promise<CustomPick | null> {
  const subs = parseSRT(record.subtitleText);
  const labels = needsLabels(cfg) ? await readLevels(record.id, subs) : null;
  return pickCustom(subs, labels, cfg, getCustomPos(record.id), pace);
}

const CustomPanel: React.FC<{
  record: VideoRecord;
  pace: PaceMode;
  read?: number; // back from reading: how many words were looked up
  onCancel: () => void;
  onStart: (choice: PanelChoice) => void;
}> = ({ record, pace, read: justRead, onCancel, onStart }) => {
  const t = useT();
  const hasAi = canCloze();
  const [cfg, setCfg] = useState<CustomConfig>(() => {
    const c = getCustomConfig();
    return hasAi ? c : { ...c, level: null };
  });
  const [watch, setWatch] = useState(() => getWatchPrefs().chosen);
  const [read, setRead] = useState(false);
  const [readBy, setReadBy] = useState<ReadBy>(() => getWatchPrefs().readBy);
  const subs = useMemo(() => parseSRT(record.subtitleText), [record.subtitleText]);
  const [labels, setLabels] = useState<LineLabel[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const want = !watch && !read && cfg.on && needsLabels(cfg);

  useEffect(() => {
    setFailed(false);
    if (!want || labels) return;
    let live = true;
    const sync = () => {
      const job = getLevelJob(record.id);
      if (live) setProgress(job && job.total ? { done: job.done, total: job.total } : null);
    };
    const unsubscribe = subscribeLevels(sync);
    prepareLevels(record.id, subs, true)
      .then(l => { if (!live) return; if (l.some(Boolean)) setLabels(l); else setFailed(true); })
      .catch(() => { if (live) setFailed(true); })
      .finally(() => { if (live) setProgress(null); });
    return () => { live = false; unsubscribe(); };
  }, [want, tries]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickWith = (timeOnly: boolean) =>
    pickCustom(subs, timeOnly || !want ? null : labels, timeOnly ? { ...cfg, level: null } : cfg, getCustomPos(record.id), pace);
  const custom = !watch && !read && cfg.on;
  const preview = custom && (!want || labels) ? pickWith(false) : null;
  const empty = custom && (!want || labels) && !preview;

  const start = (timeOnly = false) => {
    if (read) { saveWatchPrefs({ readBy }); onStart({ kind: 'read', by: readBy }); return; }
    saveWatchPrefs({ chosen: watch });
    if (watch) { onStart({ kind: 'watch' }); return; }
    if (!cfg.on) { saveCustomConfig(cfg); onStart({ kind: 'all' }); return; }
    if (want && !labels && !timeOnly) { if (!failed) setWaiting(true); return; }
    const pick = pickWith(timeOnly);
    if (!pick) { setWaiting(false); return; } // "no lines suit this level" shows; the user picks another
    saveCustomConfig(cfg);
    // "Time only" holds for this video's next sets too, not just this one.
    onStart({ kind: 'custom', cfg: timeOnly ? { ...cfg, level: null } : cfg, pick });
  };

  useEffect(() => { if (waiting && labels) start(); }, [waiting, labels]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (failed) setWaiting(false); }, [failed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Escape') onCancel();
      // A focused button (Cancel, an option) answers Enter itself.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); start(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const set = (patch: Partial<CustomConfig>) => setCfg(c => ({ ...c, ...patch }));
  const dim = (label: string) => <span className="opacity-40">{label}</span>;

  let status: React.ReactNode = null;
  if (custom) {
    if (want && failed) {
      status = (
        <div className="flex flex-wrap items-center gap-2">
          <span>{t('custom.gradeFailed')}</span>
          <Btn size="sm" onClick={() => setTries(n => n + 1)}>{t('custom.retry')}</Btn>
          <Btn size="sm" onClick={() => start(true)}>{t('custom.timeOnly')}</Btn>
        </div>
      );
    } else if (want && !labels) {
      status = (
        <div className="flex flex-wrap items-center gap-2">
          <span>{progress ? t('custom.grading', progress) : t('custom.gradingStart')}</span>
          <Btn size="sm" onClick={() => start(true)}>{t('custom.timeOnly')}</Btn>
        </div>
      );
    } else if (empty) {
      status = cfg.level ? t('custom.empty', { level: cfg.level }) : t('custom.emptyAny');
    } else if (preview) {
      const from = subs[preview.lines[0]].startTime;
      const saved = getCustomPos(record.id);
      // A pick that fell back to the top (nothing left after the saved spot) is not a resume.
      status = t(saved > 0 && from >= saved ? 'custom.previewResume' : 'custom.preview', { n: preview.practise.length, time: formatTimeCode(from) });
    }
  }

  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onCancel}>
      <Card className="w-full max-w-lg shadow-lift" role="dialog" aria-modal="true" aria-label={t('custom.title')} onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-1">
          <h3 className="text-xl font-semibold leading-tight">{t('custom.title')}</h3>
          <p className="mt-1 text-sm text-mute truncate" title={record.displayName}>{record.displayName}</p>
        </div>
        <div className="px-6 py-4 flex flex-col gap-4">
          {justRead !== undefined && (
            <div className="px-3.5 py-3 rounded-[10px] bg-shade text-sm leading-relaxed">
              {t('custom.justRead', { n: justRead })}
              {justRead > 0 && <span className="block text-mute">{t('custom.justReadHint')}</span>}
            </div>
          )}
          <Row label={t('custom.way')} hint={read ? t('custom.readHint') : watch ? t('custom.watchHint') : cfg.on ? undefined : t('custom.allHint')}>
            <Seg value={read ? 'read' : watch ? 'watch' : cfg.on ? 'custom' : 'all'} onChange={v => {
              setWaiting(false); setRead(v === 'read'); setWatch(v === 'watch');
              if (v === 'all' || v === 'custom') set({ on: v === 'custom' });
            }} options={[
              { value: 'all', label: t('custom.all') },
              { value: 'custom', label: t('custom.custom') },
              { value: 'watch', label: t('custom.watch') },
              { value: 'read', label: t('custom.read') },
            ]} />
          </Row>
          {read && (
            <Row label={t('custom.readBy')} hint={t(readBy === 'section' ? 'custom.readBySectionHint' : 'custom.readByAllHint')}>
              <Seg<ReadBy> size="sm" value={readBy} onChange={setReadBy} options={[
                { value: 'all', label: t('custom.readByAll') },
                { value: 'section', label: t('custom.readBySection') },
              ]} />
            </Row>
          )}
          {custom && <>
            <Row label={t('custom.minutes')}>
              <Seg size="sm" value={cfg.minutes} onChange={minutes => set({ minutes })} options={
                MINUTE_CHOICES.map(n => ({ value: n, label: t('custom.minutesN', { n }) }))
              } />
            </Row>
            <Row label={t('custom.level')} hint={hasAi ? undefined : t('custom.levelNeedKey')}>
              <Seg<Level | 'any'> size="sm" value={cfg.level ?? 'any'} onChange={v => { if (hasAi) set({ level: v === 'any' ? null : v }); }} options={[
                { value: 'any', label: t('custom.anyLevel') },
                ...LEVELS.map(l => ({ value: l, label: hasAi ? l : dim(l), title: hasAi ? undefined : t('custom.levelNeedKey') })),
              ]} />
            </Row>
            <Row label={t('custom.others')} hint={cfg.others === 'play' ? t('custom.playHint') : t('custom.skipHint')}>
              <Seg size="sm" value={cfg.others} onChange={others => set({ others })} options={[
                { value: 'play', label: t('custom.play') },
                { value: 'skip', label: t('custom.skip') },
              ]} />
            </Row>
          </>}
          {status && <div className="text-sm text-mute" aria-live="polite">{status}</div>}
        </div>
        <div className="px-6 pt-2 pb-6 flex justify-end gap-3">
          <Btn onClick={onCancel}>{t('dialog.cancel')}</Btn>
          <Btn tone="accent" onClick={() => start()} disabled={!!empty || (want && failed) || waiting} autoFocus>
            {waiting ? t('custom.waiting') : read ? t('custom.startRead') : watch ? t('custom.startWatch') : t('custom.start')}
          </Btn>
        </div>
      </Card>
    </div>
  );
};

const Row: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs text-mute">{label}</span>
    <div>{children}</div>
    {hint && <span className="text-xs text-mute leading-snug">{hint}</span>}
  </div>
);

export default CustomPanel;
