// One show's episodes on the phone (design Podcast.dc.html): read with the browser's
// own fetch (a feed that does not allow web pages = "open it on the desktop"), sized
// from <enclosure length>; over Groq's 25MB is greyed out. "Transcribe & practice"
// starts importEpisode and opens the episode once done, if this page is still showing.
import React, { useEffect, useRef, useState } from 'react';
import type { VideoRecord } from '../types';
import { useT } from '../utils/i18n';
import { asrOf } from '../pro/podcastShows';
import { epKey, episodeName, parseFeed, type Show } from '../pro/podcastFeed';
import { importEpisode, retryImport, subscribeImports } from './importAudio';
import { MAX_BYTES, NO_MEDIA, groqKey } from './transcribe';
import { getVideoRecord } from '../utils/videoStorage';
import type { ShowRef } from './Podcast';
import { Header, btnSmall, btnSoft, errText, sheet } from './ui';

type Loaded = Show & { sizes: Map<string, number> };

async function load(url: string, signal: AbortSignal): Promise<Loaded> {
  const res = await fetch(url.replace(/^http:\/\//i, 'https://'), { signal });
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

export const Episodes: React.FC<{ show: ShowRef; records: VideoRecord[]; onBack: () => void; onOpen: (id: string) => void; onNeedKey: () => void }> = ({ show, records, onBack, onOpen, onNeedKey }) => {
  const t = useT();
  const [state, setState] = useState<Loaded | 'loading' | 'error'>('loading');
  const waiting = useRef<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    load(show.url, ctrl.signal).then(setState, e => { console.error(e); setState('error'); }).finally(() => clearTimeout(timer));
    return () => ctrl.abort();
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

  const title = typeof state === 'object' ? state.title : show.pick?.name ?? '';
  if (state === 'loading') return <><Header title={title} onBack={onBack} /><p className="px-5 text-sm text-mute">{t('m.loading')}</p></>;
  if (state === 'error') return <><Header title={title} onBack={onBack} /><p role="alert" className={`${sheet} mx-5 p-4 text-[15px]`}>{t('m.feedFail')}</p></>;

  const lang = show.pick ? asrOf(show.pick) : state.lang;
  const mine = new Map(records.filter(r => r.podcast).map(r => [epKey(r.podcast!.feed, r.podcast!.guid), r]));
  const start = (ep: Show['episodes'][number]) => {
    const id = crypto.randomUUID();
    importEpisode({ id, title: ep.title, audio: ep.audio, lang, podcast: { show: state.title, feed: show.url, guid: ep.guid, image: state.image, name: episodeName(ep.title, epKey(show.url, ep.guid)) } })
      .then(() => { waiting.current = id; }, (e: unknown) => {
        if (e instanceof Error && e.message === 'cloud:nokey') onNeedKey();
        else console.error(e);
      });
  };

  return (
    <>
      <Header title={title} onBack={onBack} />
      <div className="px-5 pb-3 flex gap-3.5 items-center">
        {state.image && <img src={state.image} alt="" className="w-16 h-16 rounded-xl object-cover bg-shade" />}
        <span className="text-xs text-mute">{t('m.epHint')}</span>
      </div>
      <div className="px-5 pb-8 flex flex-col gap-2.5">
        {state.episodes.length === 0 && <p className="text-sm text-mute">{t('podcast.noEpisodes')}</p>}
        {state.episodes.map(ep => {
          const size = state.sizes.get(ep.audio);
          const big = !!size && size > MAX_BYTES;
          const r = mine.get(epKey(show.url, ep.guid));
          const meta = [ep.duration && t('podcast.minutes', { n: Math.max(1, Math.round(ep.duration / 60)) }), size && `${Math.round(size / 1e6)}MB`, r && !r.importJob && t('m.practicedTag')].filter(Boolean).join(' · ');
          const job = r?.importJob;
          return (
            <div key={ep.guid} data-guid={ep.guid} className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5 ${job && !job.error ? 'ring-2 ring-accent' : ''}`}>
              <p className={`font-serif text-[17px] leading-snug break-words ${big ? 'text-mute' : ''}`}>{ep.title}</p>
              {big ? <>
                <p className="text-[13px] text-mute">{meta}</p>
                <p className="text-[13px] text-[#8A2E1B] bg-accent-soft rounded-lg px-2.5 py-2">{t('m.tooLong')}</p>
              </> : (
                <div className="flex items-center gap-2.5 text-[13px] text-mute">
                  <span className="flex-1">{meta}</span>
                  {job && !job.error ? <span className="text-accent font-semibold">{t(job.stage === 'segment' ? 'm.segmenting' : 'm.transcribing')}</span>
                    : r && !job ? <button className={btnSoft} onClick={() => onOpen(r.id)}>{t('m.open')}</button>
                    : r ? job?.error !== NO_MEDIA && <button className={btnSmall} onClick={() => { waiting.current = r.id; retryImport(r.id).catch(console.error); }}>{t('m.retry')}</button>
                    : <button className={btnSmall} onClick={() => start(ep)}>{t('m.transcribeGo')}</button>}
                </div>
              )}
              {job?.error && <p role="alert" className="text-[13px] text-[#8A2E1B] bg-accent-soft rounded-lg px-2.5 py-2">{errText(job.error)}</p>}
            </div>
          );
        })}
        {!groqKey() && <p className={`${sheet} mt-2 px-3.5 py-3 text-[13px] text-mute`}>{t('m.noKeyNote')}</p>}
      </div>
    </>
  );
};
