// Ready-made episodes on the phone (docs/starter.md, docs/mobile-web.md 2): the same
// list as the desktop, read from our own site (/starter/, same origin as /app/).
// Starting one downloads nothing: the record plays the mp3 from its address and
// brings its own subtitles and translations (written into the record's `trans` cache
// before it opens, as pro/Starter.tsx does, so "中" works without an AI).
import React, { useEffect, useState } from 'react';
import type { VideoRecord } from '../types';
import * as VideoStorage from '../utils/videoStorage';
import { STARTER_FEED } from '../utils/sections';
import { parseSRT } from '../utils/srtParser';
import { getLang, useLang, useT } from '../utils/i18n';
import { epKey, episodeName, parseStarter, type StarterItem } from '../pro/podcastFeed';
import { writeTransCache } from '../pro/transPrep';
import { LangBar, btnSmall, btnSoft, sheet } from './ui';

// Our site's files by path, so dev / preview (proxied) and the real site all read them same-origin.
const local = (u: string) => { const x = new URL(u, location.href); return x.hostname === 'linguaclipapp.com' ? x.pathname + x.search : u; };
const get = async (url: string) => {
  const res = await fetch(local(url), { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};

let listed: Promise<StarterItem[]> | null = null; // asked once per load; a failure asks again
const loadList = () => (listed ??= get('/starter/index.json').then(x => parseStarter(JSON.parse(x))).catch(err => { listed = null; throw err; }));

export const starterKey = (it: StarterItem) => epKey(STARTER_FEED, `${it.id}@${it.version}`);

async function create(it: StarterItem): Promise<string> {
  const to = getLang() === 'en' ? 'en' : 'zh';
  const [srt, trans] = await Promise.all([get(it.srtFor[to] ?? it.srt), it.trans[to] ? get(it.trans[to]!).then(x => JSON.parse(x) as unknown) : null]);
  const lines = parseSRT(srt);
  if (!lines.length) throw new Error('empty srt');
  const id = crypto.randomUUID();
  const now = Date.now();
  await VideoStorage.updateVideoRecord({
    id, displayName: it.title, videoFileName: it.title, videoPath: local(it.audio),
    subtitleFileName: `${it.id}.srt`, subtitleText: srt, totalSubtitles: lines.length,
    currentSubtitleIndex: 0, currentSectionIndex: 0, completionRate: 0,
    dateAdded: now, lastPracticed: now, totalPracticeTime: 0,
    podcast: { show: it.show, feed: STARTER_FEED, guid: `${it.id}@${it.version}`, name: episodeName(it.title, starterKey(it)) },
  });
  // One translation per subtitle line, in the order the pages sort them (by start time).
  if (Array.isArray(trans) && trans.length === lines.length) {
    const pairs = lines.map((l, i) => ({ l, tr: typeof trans[i] === 'string' && trans[i] ? trans[i] as string : null })).sort((a, b) => a.l.startTime - b.l.startTime);
    await writeTransCache(id, pairs.map(p => p.l.text), to, pairs.map(p => p.tr)).catch(console.error);
  }
  return id;
}

export const Starter: React.FC<{ records: VideoRecord[]; onOpen: (id: string) => void; onChanged: () => void }> = ({ records, onOpen, onChanged }) => {
  const t = useT();
  const ui = useLang();
  const [items, setItems] = useState<StarterItem[] | null | 'error'>(null);
  const [lang, setLang] = useState<string>(ui === 'en' ? 'ja' : 'en');
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    setItems(null);
    loadList().then(setItems, err => { console.error(err); setItems('error'); });
  };
  useEffect(load, []);

  if (items === null) return null;
  if (items === 'error') return (
    <div className={`${sheet} p-4 flex items-center gap-3 text-sm`}>
      <span className="flex-1 text-mute">{t('m.starterLoadFail')}</span>
      <button className={btnSoft} onClick={load}>{t('podcast.retry')}</button>
    </div>
  );
  const langs = [...new Set(items.map(it => it.lang))];
  const shown = langs.includes(lang) ? lang : langs[0];
  const here = items.filter(it => it.lang === shown).sort((a, b) => a.level - b.level);
  if (!here.length) return null;
  const mine = new Map(records.filter(r => r.podcast).map(r => [epKey(r.podcast!.feed, r.podcast!.guid), r]));

  const start = async (it: StarterItem) => {
    if (busy) return;
    setBusy(it.id);
    try { const id = await create(it); onChanged(); onOpen(id); }
    catch (err) { console.error(err); alert(t('starter.fetchFail')); }
    finally { setBusy(null); }
  };

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-[17px] font-semibold">{t('starter.title')}</h2>
      </div>
      <LangBar langs={langs} value={shown} onChange={setLang} ui={ui} />
      <ul className={`${sheet} flex flex-col`}>
        {here.map(it => {
          const r = mine.get(starterKey(it));
          return (
            <li key={it.id} className="px-4 py-3.5 flex items-center gap-3 border-b border-shade last:border-0">
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold text-accent">{t(`starter.level_${it.level}` as 'starter.level_1')} · <span className="font-normal text-mute">{t(`starter.levelHint_${it.level}` as 'starter.levelHint_1')}</span></p>
                <p className="mt-0.5 font-serif text-[16px] leading-snug break-words">{it.title}</p>
                <p className="mt-0.5 text-[11px] text-mute break-words">{[it.seconds && t('podcast.minutes', { n: Math.max(1, Math.round(it.seconds / 60)) }), it.credit].filter(Boolean).join(' · ')}</p>
              </div>
              {r
                ? <button className={btnSoft} onClick={() => onOpen(r.id)}>{t('m.open')}</button>
                : <button className={btnSmall} disabled={!!busy} onClick={() => { void start(it); }}>{t('m.start')}</button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
};
