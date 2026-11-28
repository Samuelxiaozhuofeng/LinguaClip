// The phone app's shell (docs/mobile-web.md & docs/android-roadmap.md M1.4 / M2.1):
// 4-tab bottom navigation (Home / Podcasts / Review / Settings), full-screen Study page
// hiding the tab bar, history.pushState + popstate back handling (Study → prior view,
// non-Home tab → Home, Home → system default), startup orphan sweep, and Android ACTION_SEND.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { getAllVideoRecords, patchVideoRecord } from '../utils/videoStorage';
import { deckCounts, getAllCards, subscribeCards } from '../utils/review';
import { subscribeSyncApplied } from '../utils/syncEngine';
import { useT } from '../utils/i18n';
import { appleFeed } from '../pro/podcastFeed';
import { markInterrupted, subscribeImports } from './importAudio';
import { startStore } from './store';
import { Home } from './Home';
import { Podcast, type ShowRef } from './Podcast';
import { Episodes } from './Episodes';
import { Settings } from './Settings';
import { Study } from './Study';
import { Review } from './Review';
import { CardLibrary } from './CardLibrary';
import { TabBar, type TabId } from './TabBar';
import { ImportSheet, type ImportSheetConfirm } from './ImportSheet';
import { callAndroid, isAndroidNative, onAndroidEvent, type ProbeTracksResult, type SharePayload } from './platform/androidBridge';
import { pickAndroidSrt, probeAndroidMediaUri, startAndroidImport, sweepAndroidMediaOrphans } from './platform/homePlatform';
import { closeTopOnBack } from './backClose';
import { clearPendingImport, savePendingAndroidImport } from './pendingImportStore';
import { classifySharePayload, sanitizeShareText, shareDedupeKey } from './shareHelper';
import { SyncHost } from './SyncHost';
import { btnPlain, errText } from './ui';

type Page =
  | { name: 'home' }
  | { name: 'podcast' }
  | { name: 'episodes'; show: ShowRef }
  | { name: 'review' }
  | { name: 'cards' }
  | { name: 'settings'; needKey?: boolean; back?: Page }
  | { name: 'study'; id: string; back: Page };

type PendingShareImport = { reqId: number; uri: string; probe: ProbeTracksResult };

const SHARE_DEDUPE_MS = 3000;

function activeTabOf(p: Page): TabId {
  if (p.name === 'podcast' || p.name === 'episodes') return 'podcast';
  if (p.name === 'review' || p.name === 'cards') return 'review';
  if (p.name === 'settings') return 'settings';
  return 'home';
}

function pageBackTarget(p: Page): Page | null {
  if (p.name === 'study') return p.back;
  if (p.name === 'episodes') return { name: 'podcast' };
  if (p.name === 'cards') return { name: 'review' };
  if (p.name === 'settings') return p.back ?? { name: 'home' };
  if (p.name === 'podcast' || p.name === 'review') return { name: 'home' };
  return null;
}

function pageDepth(p: Page): number {
  if (p.name === 'home') return 0;
  if (p.name === 'podcast' || p.name === 'review') return 1;
  if (p.name === 'episodes' || p.name === 'cards') return 2;
  if (p.name === 'settings') return p.back ? pageDepth(p.back) + 1 : 1;
  return pageDepth(p.back) + 1;
}

export function App() {
  const t = useT();
  const [records, setRecords] = useState<VideoRecord[] | null | 'error'>(null);
  const [cardStats, setCardStats] = useState({ due: 0, remembered: 0 });
  const [page, setPage] = useState<Page>({ name: 'home' });
  const [shareImport, setShareImport] = useState<PendingShareImport | null>(null);
  const [shareNote, setShareNote] = useState('');
  const sweptRef = useRef(false);
  const lastShareRef = useRef<{ key: string; at: number } | null>(null);
  const shareSeqRef = useRef(0);
  const pageRef = useRef<Page>(page);
  const depthRef = useRef(0);
  const skipPopRef = useRef(0);
  pageRef.current = page;

  const navigate = useCallback((nextOrFn: Page | ((prev: Page) => Page)) => {
    const prev = pageRef.current;
    const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
    const d0 = depthRef.current;
    const d1 = pageDepth(next);
    pageRef.current = next;
    setPage(next);
    try {
      if (d1 > d0) {
        for (let d = d0 + 1; d <= d1; d++) window.history.pushState({ lcDepth: d }, '');
        depthRef.current = d1;
      } else if (d1 === d0) {
        window.history.replaceState({ lcDepth: d1 }, '');
      } else {
        skipPopRef.current += 1;
        depthRef.current = d1;
        window.history.go(d1 - d0);
      }
    } catch {
      depthRef.current = d1;
    }
  }, []);

  useEffect(() => {
    try { window.history.replaceState({ lcDepth: 0 }, ''); } catch { /* ignore */ }
    const onPop = () => {
      if (skipPopRef.current > 0) {
        skipPopRef.current -= 1;
        return;
      }
      if (closeTopOnBack()) {
        // The sheet took it: put back the history entry the browser just left.
        try { window.history.pushState({ lcDepth: depthRef.current }, ''); } catch { /* ignore */ }
        return;
      }
      const target = pageBackTarget(pageRef.current);
      if (target) {
        pageRef.current = target;
        depthRef.current = pageDepth(target);
        setPage(target);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const load = useCallback(() => getAllVideoRecords().then(setRecords, e => { console.error(e); setRecords('error'); }), []);
  const boot = useCallback(() => {
    setRecords(null);
    startStore()
      .then(markInterrupted)
      .then(() => getAllVideoRecords())
      .then(list => {
        setRecords(list);
        if (isAndroidNative() && !sweptRef.current) {
          sweptRef.current = true;
          sweepAndroidMediaOrphans().catch(console.error);
        }
      }, e => {
        console.error(e);
        setRecords('error');
      });
  }, []);

  useEffect(() => {
    boot();
    const refreshCards = () => getAllCards().then(c => {
      const counts = deckCounts(c);
      setCardStats({ due: counts.line.due + counts.word.due, remembered: counts.line.remembered });
    }, console.error);
    refreshCards();
    const onVis = () => { if (document.visibilityState === 'visible') refreshCards(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refreshCards);
    const a = subscribeImports(load);
    const b = subscribeCards(refreshCards);
    const c = subscribeSyncApplied(() => { void load(); void refreshCards(); });
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refreshCards);
      a();
      b();
      c();
    };
  }, [boot, load]);

  const handleShare = useCallback(async (payload: SharePayload | null | undefined) => {
    if (!payload) return;
    const key = shareDedupeKey(payload);
    const now = Date.now();
    if (lastShareRef.current && lastShareRef.current.key === key && now - lastShareRef.current.at < SHARE_DEDUPE_MS) {
      return;
    }
    lastShareRef.current = { key, at: now };
    const seq = ++shareSeqRef.current;
    setShareNote('');

    const intent = classifySharePayload(payload);
    if (intent.kind === 'media') {
      try {
        const probe = await probeAndroidMediaUri(intent.uri);
        if (shareSeqRef.current !== seq || !probe) return;
        const safeName = sanitizeShareText(probe.displayName) || 'Audio';
        clearPendingImport();
        setShareImport({ reqId: seq, uri: intent.uri, probe: { ...probe, displayName: safeName } });
      } catch (e: unknown) {
        if (shareSeqRef.current !== seq) return;
        console.error(e);
        const code = e instanceof Error ? e.message : String(e);
        setShareNote(errText(code));
      }
      return;
    }
    if (intent.kind === 'feed') {
      navigate({ name: 'episodes', show: { url: intent.url } });
      return;
    }
    if (intent.kind === 'apple') {
      try {
        const url = await appleFeed(intent.id);
        if (shareSeqRef.current !== seq) return;
        navigate({ name: 'episodes', show: { url } });
      } catch (e: unknown) {
        if (shareSeqRef.current !== seq) return;
        console.error(e);
        setShareNote(t('m.feedFail'));
      }
      return;
    }
    if (intent.kind === 'closed') {
      setShareNote(t('podcast.closed', { name: sanitizeShareText(intent.name) }));
      return;
    }
    setShareNote(t('m.shareUnsupported'));
  }, [navigate, t]);

  useEffect(() => {
    if (!isAndroidNative()) return;
    const unsub = onAndroidEvent<SharePayload>('shareReceived', payload => {
      // Consume Kotlin's pendingShare slot immediately on hot share so reloads never replay it.
      callAndroid('system.getPendingShare').catch(() => {});
      void handleShare(payload);
    });
    callAndroid<{ share: SharePayload | null }>('system.getPendingShare')
      .then(res => { if (res?.share) void handleShare(res.share); }, console.error);
    return () => { unsub(); };
  }, [handleShare]);

  // Opening = practising now: "continue" on home points at it (records sort by lastPracticed).
  const open = useCallback((id: string) => {
    patchVideoRecord(id, { lastPracticed: Date.now() }).then(load, console.error);
    navigate(p => ({ name: 'study', id, back: p.name === 'study' ? p.back : p }));
  }, [load, navigate]);
  const needKey = useCallback(() => navigate(p => ({ name: 'settings', needKey: true, back: p })), [navigate]);
  const openSettings = useCallback(() => navigate({ name: 'settings' }), [navigate]);
  const home = useCallback(() => navigate({ name: 'home' }), [navigate]);
  const selectTab = useCallback((tab: TabId) => {
    if (tab === 'home') navigate({ name: 'home' });
    else if (tab === 'podcast') navigate({ name: 'podcast' });
    else if (tab === 'review') navigate({ name: 'review' });
    else navigate({ name: 'settings' });
  }, [navigate]);

  const confirmShareImport = useCallback(async (cur: PendingShareImport, opts: ImportSheetConfirm) => {
    setShareNote('');
    try {
      await startAndroidImport({ ...opts, displayName: sanitizeShareText(opts.displayName) || 'Audio' });
      clearPendingImport();
      setShareImport(null);
      navigate({ name: 'home' });
      void load();
    } catch (e: unknown) {
      const code = e instanceof Error ? e.message : String(e);
      if (code === 'cloud:nokey' || code === 'cloud:missing-url') {
        savePendingAndroidImport(cur.uri, cur.probe, opts);
        setShareImport(null);
        if (code === 'cloud:missing-url') setShareNote(errText(code));
        // Always return to Home after filling the key so Home's resume effect starts the saved import.
        navigate({ name: 'settings', needKey: true, back: { name: 'home' } });
      } else {
        setShareImport(null);
        setShareNote(errText(code));
      }
    }
  }, [load, navigate]);

  const studyRecord = page.name === 'study' && Array.isArray(records) ? records.find(x => x.id === page.id) : undefined;
  const showTabBar = Array.isArray(records) && !studyRecord && page.name !== 'cards';

  const wrap = (body: React.ReactNode) => (
    <div className={`min-h-[100vh] supports-[height:1dvh]:min-h-[100dvh] flex flex-col pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] ${showTabBar ? 'pb-[calc(62px+env(safe-area-inset-bottom))]' : ''}`}>
      {shareNote && (
        <div role="alert" className="mx-4 mt-2 px-3.5 py-2.5 rounded-xl bg-accent-soft text-[#8A2E1B] dark:text-accent text-[13px] flex items-center gap-2">
          <span className="flex-1 break-words">{shareNote}</span>
          <button
            type="button"
            aria-label={t('m.close')}
            className="w-8 h-8 shrink-0 flex items-center justify-center text-lg"
            onClick={() => setShareNote('')}
          >
            ×
          </button>
        </div>
      )}
      {body}
      {Array.isArray(records) && <SyncHost busy={page.name === 'study' || page.name === 'review'} />}
      {showTabBar && <TabBar active={activeTabOf(page)} due={cardStats.due} onSelect={selectTab} />}
      {shareImport && (
        <ImportSheet
          key={shareImport.reqId}
          uri={shareImport.uri}
          probe={shareImport.probe}
          onPickSrt={pickAndroidSrt}
          onCancel={() => { clearPendingImport(); setShareImport(null); }}
          onConfirm={opts => { void confirmShareImport(shareImport, opts); }}
        />
      )}
    </div>
  );
  if (records === null) return wrap(null);
  if (records === 'error') return wrap(
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center">
      <p role="alert" className="text-[15px]">{t('m.loadFail')}</p>
      <button className={`${btnPlain} px-8`} onClick={boot}>{t('m.retry')}</button>
    </div>,
  );

  if (studyRecord && page.name === 'study') {
    return wrap(<Study record={studyRecord} onBack={() => navigate(page.back)} onReview={() => navigate({ name: 'review' })} />);
  }
  switch (page.name) {
    case 'podcast':
      return wrap(<Podcast onBack={home} onShow={show => navigate({ name: 'episodes', show })} />);
    case 'episodes':
      return wrap(<Episodes key={page.show.url} show={page.show} records={records} onBack={() => navigate({ name: 'podcast' })} onOpen={open} onNeedKey={needKey} />);
    case 'settings':
      return wrap(<Settings needKey={!!page.needKey} onBack={page.back ? () => navigate(page.back!) : undefined} />);
    case 'review':
      return wrap(<Review onOpenLibrary={() => navigate({ name: 'cards' })} onOpenRecord={open} />);
    case 'cards':
      return wrap(<CardLibrary onBack={() => navigate({ name: 'review' })} />);
  }

  return wrap(<>
    <header className="pt-4 px-5 pb-2 flex items-center justify-between">
      <h1 className="text-[20px] font-semibold tracking-tight">LinguaClip</h1>
    </header>
    <Home
      records={records}
      due={cardStats.due}
      remembered={cardStats.remembered}
      onOpen={open}
      onReview={() => navigate({ name: 'review' })}
      onPodcast={() => navigate({ name: 'podcast' })}
      onNeedKey={needKey}
      onOpenSettings={openSettings}
      onChanged={load}
    />
  </>);
}
