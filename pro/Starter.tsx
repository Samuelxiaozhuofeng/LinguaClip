import React, { useEffect, useState } from 'react';
import { fetch } from '@tauri-apps/plugin-http';
import { Check, Loader2 } from 'lucide-react';
import type { VideoRecord } from '../types';
import { Btn } from '../components/ui';
import { dialog } from '../components/Dialog';
import * as VideoStorage from '../utils/videoStorage';
import { startPodcastImport, subscribeImportJobs } from '../utils/importJob';
import { STARTER_FEED } from '../utils/sections';
import { parseSRT } from '../utils/srtParser';
import { getLang, useT } from '../utils/i18n';
import { epKey, episodeName, parseStarter, type StarterItem } from './podcastFeed';
import { writeTransCache } from './transPrep';

// Ready-made starter episodes (docs/starter.md): a list on our site, one episode per level,
// each with a checked transcript and translations, so a first try needs no transcription
// and no AI. Downloading one is a podcast import that brings its own subtitles; it opens
// by itself once ready if the user is still on the podcast page (StarterHost).

const INDEX = 'https://linguaclipapp.com/starter/index.json';

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};
let listed: Promise<StarterItem[]> | null = null; // asked once per run; a failure asks again
const loadList = () => (listed ??= get(INDEX).then(t => parseStarter(JSON.parse(t))).catch(err => { listed = null; throw err; }));

export const starterKey = (it: StarterItem) => epKey(STARTER_FEED, `${it.id}@${it.version}`);
let waiting: string | null = null; // the record to open once downloaded

async function download(it: StarterItem): Promise<void> {
  const to = getLang() === 'en' ? 'en' : 'zh';
  const [srt, trans] = await Promise.all([get(it.srtFor[to] ?? it.srt), it.trans[to] ? get(it.trans[to]!).then(t => JSON.parse(t) as unknown) : null]);
  const lines = parseSRT(srt);
  if (!lines.length) throw new Error('empty srt');
  const id = crypto.randomUUID();
  const guid = `${it.id}@${it.version}`;
  await startPodcastImport({
    id, title: it.title, audio: it.audio, lang: it.lang,
    podcast: { show: it.show, feed: STARTER_FEED, guid, name: episodeName(it.title, starterKey(it)) },
  }, { text: srt, fileName: `${it.id}.srt`, count: lines.length });
  // One translation per subtitle line, in the order the pages sort them (by start time); written
  // before the episode may open, so its first visit already has them.
  if (Array.isArray(trans) && trans.length === lines.length) {
    const pairs = lines.map((l, i) => ({ l, tr: typeof trans[i] === 'string' && trans[i] ? trans[i] as string : null })).sort((a, b) => a.l.startTime - b.l.startTime);
    await writeTransCache(id, pairs.map(p => p.l.text), to, pairs.map(p => p.tr)).catch(console.error);
  }
  waiting = id;
}

// On the podcast page's picker (empty page / add dialog), above the recommended shows.
export const Starter: React.FC<{ lang: string; mine: Map<string, VideoRecord>; onOpen: (r: VideoRecord) => void; onLoaded: () => Promise<void> }> = ({ lang, mine, onOpen, onLoaded }) => {
  const t = useT();
  const [items, setItems] = useState<StarterItem[] | null | 'error'>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => { setItems(null); loadList().then(setItems, err => { console.error(err); setItems('error'); }); };
  useEffect(load, []);

  if (items === null) return null;
  if (items === 'error') return (
    <div className="p-4 rounded-xl border border-line flex items-center gap-4 text-sm">
      <span className="flex-1 text-mute">{t('starter.loadFail')}</span>
      <Btn size="sm" onClick={load}>{t('podcast.retry')}</Btn>
    </div>
  );
  const here = items.filter(it => it.lang === lang).sort((a, b) => a.level - b.level);
  if (!here.length) return null;

  const start = async (it: StarterItem) => {
    if (busy || mine.has(starterKey(it))) return;
    setBusy(it.id);
    try { await download(it); } catch (err) { console.error(err); dialog.alert(t('starter.fetchFail')); }
    finally { await onLoaded(); setBusy(null); }
  };
  const status = (it: StarterItem) => {
    const r = mine.get(starterKey(it));
    if (busy === it.id) return <span className="text-xs text-mute inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" />{t('podcast.preparing')}</span>;
    if (r?.importJob) return <span className="text-xs text-mute">{r.importJob.error ? t('podcast.importFailed') : t('podcast.importing')}</span>;
    if (r) return <Btn size="sm" onClick={() => onOpen(r)}><Check size={14} />{t('starter.open')}</Btn>;
    return <Btn size="sm" tone="accent" disabled={!!busy} onClick={() => { start(it).catch(console.error); }}>{t('starter.start')}</Btn>;
  };

  return (
    <section className="p-4 rounded-xl bg-accent-soft/40 border border-line flex flex-col gap-3">
      <div>
        <p className="text-[15px] font-semibold">{t('starter.title')}</p>
        <p className="mt-0.5 text-xs text-mute leading-relaxed">{t('starter.hint')}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {here.map(it => (
          <li key={it.id} className="p-3 rounded-lg bg-page border border-line flex items-center gap-4">
            <span className="w-24 shrink-0 whitespace-nowrap flex flex-col">
              <span className="text-sm font-semibold text-accent">{t(`starter.level_${it.level}`)}</span>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-medium leading-snug break-words">{it.title}</p>
              <p className="mt-0.5 text-xs text-mute">{[t(`starter.levelHint_${it.level}`), it.seconds && t('podcast.minutes', { n: Math.max(1, Math.round(it.seconds / 60)) }), it.bytes && `${(it.bytes / 1e6).toFixed(1)} MB`].filter(Boolean).join(' · ')}</p>
              <p className="mt-0.5 text-[11px] text-mute/80 break-words">{it.credit}</p>
            </div>
            <div className="shrink-0">{status(it)}</div>
          </li>
        ))}
      </ul>
    </section>
  );
};

// Mounted at the root. Lands a user with no videos yet on the podcast page (where the
// starter is) once at launch, and opens a starter episode once it has downloaded — only
// while the podcast page is still showing; leaving it drops that.
export const StarterHost: React.FC<{ here: boolean; onLand: () => void; onOpen: (r: VideoRecord) => void }> = ({ here, onLand, onOpen }) => {
  useEffect(() => {
    // An unreadable library is not an empty one: stay on the videos.
    VideoStorage.getAllVideoRecords().then(all => { if (!all.some(r => !r.podcast)) onLand(); }).catch(console.error);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!here) { waiting = null; return; }
    return subscribeImportJobs(() => {
      const id = waiting;
      if (!id) return;
      VideoStorage.getVideoRecord(id).then(r => {
        if (waiting !== id || !r || r.importJob || !r.videoPath) return;
        waiting = null;
        onOpen(r);
      }).catch(console.error);
    });
  }, [here, onOpen]);
  return null;
};
