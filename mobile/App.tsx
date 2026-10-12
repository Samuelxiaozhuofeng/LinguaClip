// The phone app's shell (docs/mobile-web.md): a page state machine — home / podcasts /
// a show's episodes / settings / listening / review — over the records in linguaclip_db.
// Start = startStore() → markInterrupted(); any failure = "could not read" + retry,
// never an empty list.
import React, { useCallback, useEffect, useState } from 'react';
import type { VideoRecord } from '../types';
import { getAllVideoRecords, patchVideoRecord } from '../utils/videoStorage';
import { getAllCards, isDue, subscribeCards } from '../utils/review';
import { useT } from '../utils/i18n';
import { markInterrupted, subscribeImports } from './importAudio';
import { startStore } from './store';
import { Home } from './Home';
import { Podcast, type ShowRef } from './Podcast';
import { Episodes } from './Episodes';
import { Settings } from './Settings';
import { Listen } from './Listen';
import { Review } from './Review';
import { btnPlain } from './ui';

type Page =
  | { name: 'home' } | { name: 'podcast' } | { name: 'episodes'; show: ShowRef }
  | { name: 'settings'; needKey?: boolean; back: Page } | { name: 'listen'; id: string; back: Page } | { name: 'review' };

export function App() {
  const t = useT();
  const [records, setRecords] = useState<VideoRecord[] | null | 'error'>(null);
  const [due, setDue] = useState(0);
  const [page, setPage] = useState<Page>({ name: 'home' });
  const load = useCallback(() => getAllVideoRecords().then(setRecords, e => { console.error(e); setRecords('error'); }), []);
  const boot = useCallback(() => {
    setRecords(null);
    startStore().then(markInterrupted).then(load, e => { console.error(e); setRecords('error'); });
  }, [load]);
  useEffect(() => {
    boot();
    const cards = () => getAllCards().then(c => setDue(c.filter(x => isDue(x)).length), console.error);
    cards();
    const a = subscribeImports(load);
    const b = subscribeCards(cards);
    return () => { a(); b(); };
  }, [boot, load]);

  // Opening = practising now: "continue" on home points at it (records sort by lastPracticed).
  const open = useCallback((id: string) => {
    patchVideoRecord(id, { lastPracticed: Date.now() }).then(load, console.error);
    setPage(p => ({ name: 'listen', id, back: p.name === 'listen' ? p.back : p }));
  }, [load]);
  const needKey = useCallback(() => setPage(p => ({ name: 'settings', needKey: true, back: p })), []);
  const home = () => setPage({ name: 'home' });

  const wrap = (body: React.ReactNode) => (
    <div className="min-h-[100dvh] flex flex-col pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">{body}</div>
  );
  if (records === null) return wrap(null);
  if (records === 'error') return wrap(
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
      <p role="alert" className="text-[15px]">{t('m.loadFail')}</p>
      <button className={`${btnPlain} px-8`} onClick={boot}>{t('m.retry')}</button>
    </div>,
  );

  switch (page.name) {
    case 'podcast': return wrap(<Podcast onBack={home} onShow={show => setPage({ name: 'episodes', show })} />);
    case 'episodes': return wrap(<Episodes show={page.show} records={records} onBack={() => setPage({ name: 'podcast' })} onOpen={open} onNeedKey={needKey} />);
    case 'settings': return wrap(<Settings needKey={!!page.needKey} onBack={() => setPage(page.back)} />);
    case 'review': return wrap(<Review onBack={home} />);
    case 'listen': {
      const r = records.find(x => x.id === page.id);
      if (r) return wrap(<Listen record={r} onBack={() => setPage(page.back)} />);
    }
  }
  const pill = (on: boolean) => `min-h-[36px] px-3 rounded-full text-[13px] ${on ? 'bg-ink text-white font-medium' : 'text-mute'}`;
  return wrap(<>
    <div className="pt-4 px-5 pb-3 flex items-center justify-between">
      <h1 className="text-[22px] font-semibold tracking-tight">LinguaClip</h1>
      <nav className="flex gap-1.5 bg-page rounded-full p-1 shadow-card">
        <button className={pill(true)} aria-current="page">{t('m.practice')}</button>
        <button className={pill(false)} onClick={() => setPage({ name: 'review' })}>{t('m.review', { n: due })}</button>
        <button className={pill(false)} onClick={() => setPage({ name: 'settings', back: { name: 'home' } })}>{t('m.settings')}</button>
      </nav>
    </div>
    <Home records={records} onOpen={open} onPodcast={() => setPage({ name: 'podcast' })} onNeedKey={needKey} onChanged={load} />
  </>);
}
