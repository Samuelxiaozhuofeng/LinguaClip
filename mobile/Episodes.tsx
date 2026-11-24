// One show's episodes on the phone (design Podcast.dc.html & Android M1.3):
// fetched via @tauri-apps/plugin-http (aliased to browser fetch on PWA, native CORS-free on Android),
// sized from <enclosure length> (25MB cap applies only on PWA, lifted on Android native).
import React, { useEffect, useRef, useState } from 'react';
import { fetch as httpFetch } from '@tauri-apps/plugin-http';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { androidCloudArgs } from '../utils/transcribeConfig';
import { asrOf } from '../pro/podcastShows';
import { epKey, episodeName, parseFeed, type Show } from '../pro/podcastFeed';
import { cancelImport, importEpisode, retryImport, subscribeImports } from './importAudio';
import { MAX_BYTES, NO_MEDIA, groqKey } from './transcribe';
import { getVideoRecord } from '../utils/videoStorage';
import {
  addPodcastSub,
  confirmPodcastDownloadNetwork,
  isPodcastSubscribed,
  removePodcastSub,
} from './opml';
import { isAndroidNative } from './platform/androidBridge';
import type { ShowRef } from './Podcast';
import { Header, btnSmall, btnSoft, errText, sheet } from './ui';

type Loaded = Show & { sizes: Map<string, number> };

async function load(url: string, signal: AbortSignal): Promise<Loaded> {
  // Upgrade external http:// RSS links to https:// (required by both browser mixed-content and Tauri's http:default scope);
  // keep local loopback http://127.0.0.1 / localhost untouched for local testing.
  const isLoopback = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(url);
  const targetUrl = isLoopback ? url : url.replace(/^http:\/\//i, 'https://');
  const res = await httpFetch(targetUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const show = parseFeed(xml, url);
  const sizes = new Map<string, number>();
  for (const e of new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('enclosure')) {
    const n = Number(e.getAttribute('length'));
    if (n > 0) sizes.set(e.getAttribute('url')?.trim() ?? '', n);
  }
  return { ...show, sizes };
}

function isOfflineLocal(videoPath?: string): boolean {
  return !!videoPath && !/^https?:\/\//i.test(videoPath) && !videoPath.startsWith('blob:');
}

function jobLabel(job: NonNullable<VideoRecord['importJob']>, t: ReturnType<typeof useT>): string {
  if (job.stage === 'queued') return t('m.stageQueued');
  if (job.stage === 'download') {
    if (typeof job.percent === 'number') return t('m.stageDownload', { pct: job.percent });
    const rawBytes = (job as { downloadBytes?: number; bytes?: number }).downloadBytes
      ?? (job as { bytes?: number }).bytes;
    const mb = typeof rawBytes === 'number' && rawBytes > 0 ? (rawBytes / 1048576).toFixed(1) : '0.0';
    return t('m.stageDownloadBytes', { mb });
  }
  if (job.stage === 'extract') return t('m.stageExtract');
  if (job.stage === 'cloud') {
    if (job.pieceTotal && job.pieceTotal > 0) {
      return t('m.stageChunk', { done: job.pieceDone ?? 0, total: job.pieceTotal });
    }
    return t('m.transcribing');
  }
  if (job.stage === 'segment') return t('m.segmenting');
  return t('m.transcribing');
}

export const Episodes: React.FC<{ show: ShowRef; records: VideoRecord[]; onBack: () => void; onOpen: (id: string) => void; onNeedKey: () => void }> = ({ show, records, onBack, onOpen, onNeedKey }) => {
  const t = useT();
  const android = isAndroidNative();
  const [state, setState] = useState<Loaded | 'loading' | 'error'>('loading');
  const [subscribed, setSubscribed] = useState(() => isPodcastSubscribed(show.url));
  const waiting = useRef<string | null>(null);

  useEffect(() => {
    setSubscribed(isPodcastSubscribed(show.url));
  }, [show.url]);

  useEffect(() => {
    setState('loading');
    waiting.current = null;
    let disposed = false;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    load(show.url, ctrl.signal).then(
      loaded => { if (!disposed) setState(loaded); },
      e => {
        if (disposed) return;
        console.error(e);
        setState('error');
      },
    ).finally(() => clearTimeout(timer));
    return () => {
      disposed = true;
      ctrl.abort();
    };
  }, [show.url]);

  // Opens the episode this page started once it is ready; leaving the page drops that.
  useEffect(() => subscribeImports(() => {
    const id = waiting.current;
    if (!id) return;
    getVideoRecord(id).then(r => {
      if (waiting.current !== id || !r || r.importJob || !r.videoPath) return;
      waiting.current = null;
      onOpen(id);
    }).catch(console.error);
  }), [onOpen]);

  const title = typeof state === 'object' ? state.title : show.pick?.name ?? show.title ?? '';
  if (state === 'loading') return <><Header title={title} onBack={onBack} /><p className="px-5 text-sm text-mute">{t('m.loading')}</p></>;
  if (state === 'error') return <><Header title={title} onBack={onBack} /><p role="alert" className={`${sheet} mx-5 p-4 text-[15px]`}>{t('m.feedFail')}</p></>;

  const lang = show.pick ? asrOf(show.pick) : state.lang;
  const mine = new Map(records.filter(r => r.podcast).map(r => [epKey(r.podcast!.feed, r.podcast!.guid), r]));

  const toggleSub = () => {
    if (subscribed) {
      removePodcastSub(show.url);
      setSubscribed(false);
    } else {
      addPodcastSub({ feed: show.url, title: state.title, image: state.image ?? show.image, lang });
      setSubscribed(true);
    }
  };

  const start = async (ep: Show['episodes'][number]) => {
    if (android && !(await confirmPodcastDownloadNetwork())) return;
    const id = crypto.randomUUID();
    importEpisode({
      id,
      title: ep.title,
      audio: ep.audio,
      lang,
      podcast: { show: state.title, feed: show.url, guid: ep.guid, image: state.image, name: episodeName(ep.title, epKey(show.url, ep.guid)) },
    }).then(() => { waiting.current = id; }, (e: unknown) => {
      if (e instanceof Error && e.message === 'cloud:nokey') onNeedKey();
      else console.error(e);
    });
  };

  const retry = async (r: VideoRecord) => {
    if (android && !r.importJob?.extractedPath && !(await confirmPodcastDownloadNetwork())) return;
    waiting.current = r.id;
    retryImport(r.id).catch(console.error);
  };

  const hasKey = android ? !!androidCloudArgs() : !!groqKey();

  const rawCover = state.image ?? show.image;
  const cover = rawCover?.replace(/^http:\/\//i, 'https://');

  return (
    <>
      <Header title={title} onBack={onBack} />
      <div className="px-5 pb-3 flex gap-3.5 items-center">
        {cover && (
          <img src={cover} alt="" className="w-16 h-16 rounded-xl object-cover bg-shade shrink-0" />
        )}
        <span className="text-xs text-mute flex-1">{t('m.epHint')}</span>
        <button
          className={subscribed ? btnSoft : btnSmall}
          onClick={toggleSub}
          aria-pressed={subscribed}
        >
          {t(subscribed ? 'm.subAdded' : 'm.subAdd')}
        </button>
      </div>
      <div className="px-5 pb-8 flex flex-col gap-2.5">
        {state.episodes.length === 0 && <p className="text-sm text-mute">{t('podcast.noEpisodes')}</p>}
        {state.episodes.map(ep => {
          const size = state.sizes.get(ep.audio);
          const big = !android && !!size && size > MAX_BYTES;
          const r = mine.get(epKey(show.url, ep.guid));
          const job = r?.importJob;
          const offline = !!r && !job && isOfflineLocal(r.videoPath);
          const meta = [
            ep.duration && t('podcast.minutes', { n: Math.max(1, Math.round(ep.duration / 60)) }),
            size && `${Math.round(size / 1e6)}MB`,
            r && !job && t('m.practicedTag'),
          ].filter(Boolean).join(' · ');
          return (
            <div key={ep.guid} data-guid={ep.guid} className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5 ${job && !job.error ? 'ring-2 ring-accent' : ''}`}>
              <p className={`font-serif text-[17px] leading-snug break-words ${big ? 'text-mute' : ''}`}>{ep.title}</p>
              {big ? <>
                <p className="text-[13px] text-mute">{meta}</p>
                <p className="text-[13px] text-[#8A2E1B] bg-accent-soft rounded-lg px-2.5 py-2">{t('m.tooLong')}</p>
              </> : (
                <div className="flex items-center gap-2.5 text-[13px] text-mute">
                  <span className="flex-1 flex items-center flex-wrap gap-1.5">
                    <span>{meta}</span>
                    {offline && (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] bg-shade text-ink font-medium">
                        {t('m.offlineReady')}
                      </span>
                    )}
                  </span>
                  {job && !job.error ? (
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="text-accent font-semibold">{jobLabel(job, t)}</span>
                      <button
                        className="min-h-[36px] px-2.5 rounded-lg bg-shade text-ink text-xs font-medium"
                        onClick={() => {
                          if (waiting.current === r.id) waiting.current = null;
                          cancelImport(r.id);
                        }}
                      >
                        {t('m.cancelDownload')}
                      </button>
                    </span>
                  ) : r && !job ? (
                    <button className={btnSoft} onClick={() => onOpen(r.id)}>{t('m.open')}</button>
                  ) : r ? (
                    job?.error !== NO_MEDIA && (
                      <button className={btnSmall} onClick={() => { void retry(r); }}>{t('m.retry')}</button>
                    )
                  ) : (
                    <button className={btnSmall} onClick={() => { void start(ep); }}>
                      {t(android ? 'm.downloadGo' : 'm.transcribeGo')}
                    </button>
                  )}
                </div>
              )}
              {job?.error && <p role="alert" className="text-[13px] text-[#8A2E1B] bg-accent-soft rounded-lg px-2.5 py-2">{errText(job.error)}</p>}
            </div>
          );
        })}
        {!hasKey && <p className={`${sheet} mt-2 px-3.5 py-3 text-[13px] text-mute`}>{t('m.noKeyNote')}</p>}
      </div>
    </>
  );
};
