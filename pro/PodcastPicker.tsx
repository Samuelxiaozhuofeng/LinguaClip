import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Headphones, Loader2 } from 'lucide-react';
import type { VideoRecord } from '../types';
import { Btn, Card, Seg, inputCls } from '../components/ui';
import { dialog } from '../components/Dialog';
import * as VideoStorage from '../utils/videoStorage';
import { startPodcastImport, subscribeImportJobs } from '../utils/importJob';
import { getWatchPrefs, saveWatchPrefs } from '../utils/storage';
import { getLang, useLang, useT } from '../utils/i18n';
import { SHOWS, SHOW_LANGS, asrOf, type Pick, type ShowLang } from './podcastShows';
import { appleFeed, classifyPaste, epKey, episodeName, loadFeed, type Episode, type Show } from './podcastFeed';

// Picking a podcast episode to import: the recommended shows by
// language and a box for an Apple Podcasts link or an RSS address; a show opens its
// episodes, newest first, each with "Import" (or where its import stands, or "Open").
// As the podcast page's add dialog (onClose), or inline on the empty page.

const PAGE = 50;
type Opened = { url: string; pick?: Pick; state: 'loading' | 'error' | 'ready'; show?: Show };
type Note = 'closed' | 'bad' | null;

const langLabel = (l: string, ui: string) => {
  try { return new Intl.DisplayNames([ui === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(l) ?? l; } catch { return l; }
};
// What a pasted show's transcript can be told (a feed's own <language> is often wrong).
const ASR_LANGS = ['auto', 'en', 'ja', 'es', 'fr', 'de', 'ko', 'zh'];
const firstLang = (): ShowLang => {
  const saved = getWatchPrefs().podLang as ShowLang;
  return SHOW_LANGS.includes(saved) ? saved : getLang() === 'en' ? 'ja' : 'en';
};

const Tag: React.FC<{ strong?: boolean; children: React.ReactNode }> = ({ strong, children }) => (
  <span className={`px-2 py-0.5 rounded-md text-xs ${strong ? 'bg-accent-soft text-accent' : 'bg-shade text-mute'}`}>{children}</span>
);

// `initialShow`: opened straight on that show's episodes (the listening page's easier / harder hint).
const PodcastPicker: React.FC<{ onClose?: () => void; onOpen: (r: VideoRecord) => void; initialShow?: Pick }> = ({ onClose, onOpen, initialShow }) => {
  const t = useT();
  const ui = useLang();
  const [lang, setLangState] = useState<ShowLang>(() => initialShow?.lang ?? firstLang());
  const setLang = (l: ShowLang) => { setLangState(l); saveWatchPrefs({ podLang: l }); };
  const [opened, setOpened] = useState<Opened | null>(null);
  const [asr, setAsr] = useState<string | null>(null); // a pasted show's transcript language, when changed
  const [paste, setPaste] = useState('');
  const [note, setNote] = useState<{ kind: Note; name?: string }>({ kind: null });
  const [limit, setLimit] = useState(PAGE);
  const [busy, setBusy] = useState<Set<string>>(new Set()); // episodes whose import is being set up
  const [mine, setMine] = useState<Map<string, VideoRecord>>(new Map()); // episode → its record
  const seq = useRef(0); // only the latest show being opened may land

  const loadMine = useCallback(() =>
    VideoStorage.getAllVideoRecords()
      .then(all => setMine(new Map(all.filter(r => r.podcast).map(r => [epKey(r.podcast!.feed, r.podcast!.guid), r]))))
      .catch(console.error), // unreadable: every episode just offers "Import"
  []);
  useEffect(() => { loadMine(); return subscribeImportJobs(() => { loadMine(); }); }, [loadMine]);

  // Esc closes the dialog (not the inline page); with another one on top (an alert), Esc is that one's.
  useEffect(() => {
    if (!onClose) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.querySelectorAll('[role="dialog"]').length < 2) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (url: string | Promise<string>, pick?: Pick) => {
    const mine = ++seq.current;
    setLimit(PAGE);
    setAsr(null);
    setOpened({ url: typeof url === 'string' ? url : '', pick, state: 'loading' });
    Promise.resolve(url)
      .then(u => loadFeed(u).then(show => ({ u, show })))
      .then(({ u, show }) => { if (seq.current === mine) setOpened({ url: u, pick, state: 'ready', show }); })
      .catch(err => { console.error(err); if (seq.current === mine) setOpened(o => o && { ...o, state: 'error' }); });
  };
  useEffect(() => { if (initialShow) open(initialShow.feed, initialShow); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = () => { if (opened) open(opened.url || resolvePaste() || '', opened.pick); };
  const resolvePaste = (): string | Promise<string> | null => {
    const p = classifyPaste(paste);
    if (p.kind === 'apple') return appleFeed(p.id);
    if (p.kind === 'feed') return p.url;
    setNote(p.kind === 'closed' ? { kind: 'closed', name: p.name } : { kind: 'bad' });
    return null;
  };
  const submitPaste = () => {
    setNote({ kind: null });
    const url = resolvePaste();
    if (url) open(url);
  };

  const importEp = async (show: Show, ep: Episode) => {
    const key = epKey(show.feed, ep.guid);
    if (busy.has(key) || mine.has(key)) return;
    setBusy(b => new Set(b).add(key));
    const id = crypto.randomUUID();
    try {
      await startPodcastImport({
        id, title: ep.title, audio: ep.audio, lang: opened?.pick ? asrOf(opened.pick) : asr ?? show.lang,
        podcast: { show: opened?.pick?.name ?? show.title, feed: show.feed, guid: ep.guid, image: show.image, name: episodeName(ep.title, key) },
      });
    } catch (err) {
      console.error(err);
      dialog.alert(t('podcast.saveFail'));
    } finally {
      await loadMine(); // the new card is known before the button shows "Import" again
      setBusy(b => { const n = new Set(b); n.delete(key); return n; });
    }
  };

  const dateOf = (ms?: number) => (ms ? new Date(ms).toLocaleDateString(ui === 'zh' ? 'zh-CN' : 'en', { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  const status = (show: Show, ep: Episode) => {
    const key = epKey(show.feed, ep.guid);
    const r = mine.get(key);
    if (busy.has(key)) return <span className="text-xs text-mute inline-flex items-center gap-1.5"><Loader2 size={14} className="animate-spin" />{t('podcast.preparing')}</span>;
    if (r?.importJob) return <span className="text-xs text-mute">{r.importJob.error ? t('podcast.importFailed') : t('podcast.importing')}</span>;
    if (r) return (
      <span className="flex items-center gap-3">
        <span className="text-xs text-mute inline-flex items-center gap-1"><Check size={14} />{t('podcast.imported')}</span>
        <Btn size="sm" onClick={() => { onOpen(r); onClose?.(); }}>{t('podcast.openEp')}</Btn>
      </span>
    );
    return <Btn size="sm" tone="accent" onClick={() => { if (opened?.show) importEp(opened.show, ep).catch(console.error); }}>{t('podcast.import')}</Btn>;
  };

  const tags = (p: Pick) => <>
    <Tag strong>{t(`podcast.level_${p.level}`)}</Tag>
    <Tag>{t(p.slow ? 'podcast.slow' : 'podcast.natural')}</Tag>
    <Tag>{t(`podcast.style_${p.style}`)}</Tag>
    {p.english && <Tag>{t('podcast.english')}</Tag>}
  </>;

  const cover = (src: string | undefined, size: string) => (
    <span className={`${size} relative shrink-0 rounded-xl bg-shade overflow-hidden flex items-center justify-center text-mute`}>
      <Headphones size={20} />
      {src && <img src={src} alt="" className="absolute inset-0 w-full h-full object-cover" onError={e => { e.currentTarget.style.display = 'none'; }} />}
    </span>
  );

  const shows = (
    <>
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-semibold tracking-wider text-mute uppercase">{t('podcast.recommended')}</span>
        <Seg<ShowLang> size="sm" value={lang} onChange={setLang} options={SHOW_LANGS.map(l => ({ value: l, label: langLabel(l, ui) }))} />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {SHOWS.filter(p => p.lang === lang).map(p => (
          <button key={p.id} type="button" onClick={() => open(p.feed, p)}
            className="press text-left p-3.5 rounded-xl border border-line bg-page hover:border-ink/20 flex flex-col gap-3">
            <span className="text-[15px] font-semibold leading-snug">{p.name}</span>
            <span className="flex flex-wrap gap-1.5">{tags(p)}</span>
          </button>
        ))}
      </div>
      <div className="flex items-center gap-3 pt-2 text-xs text-mute"><span className="flex-1 border-t border-line" />{t('podcast.orPaste')}<span className="flex-1 border-t border-line" /></div>
      <form className="flex gap-2.5" onSubmit={e => { e.preventDefault(); submitPaste(); }}>
        <input value={paste} onChange={e => { setPaste(e.target.value); setNote({ kind: null }); }} placeholder={t('podcast.pastePlaceholder')}
          aria-label={t('podcast.pastePlaceholder')} className={inputCls} />
        <Btn type="submit" disabled={!paste.trim()}>{t('podcast.open')}</Btn>
      </form>
      <p className={`text-xs leading-relaxed ${note.kind ? 'text-ink' : 'text-mute'}`} aria-live="polite">
        {note.kind === 'closed' ? t('podcast.closed', { name: note.name ?? '' }) : note.kind === 'bad' ? t('podcast.bad') : t('podcast.pasteHint')}
      </p>
    </>
  );

  const episodes = opened && (
    <>
      <button type="button" onClick={() => { seq.current++; setOpened(null); }} className="self-start text-sm text-mute hover:text-ink inline-flex items-center gap-1.5">
        <ArrowLeft size={16} />{t('podcast.back')}
      </button>
      {opened.state === 'loading' && <p className="py-10 flex justify-center text-mute"><Loader2 size={20} className="animate-spin" /></p>}
      {opened.state === 'error' && (
        <div className="py-8 flex flex-col items-center gap-4 text-center">
          <p className="text-sm max-w-md leading-relaxed">{t('podcast.loadFail')}</p>
          <Btn onClick={retry}>{t('podcast.retry')}</Btn>
        </div>
      )}
      {opened.state === 'ready' && opened.show && (() => {
        const show = opened.show;
        return <>
          <div className="flex items-center gap-4">
            {cover(show.image, 'w-[72px] h-[72px]')}
            <div className="min-w-0 flex flex-col gap-1.5">
              <span className="text-xl font-semibold leading-snug truncate">{opened.pick?.name ?? show.title}</span>
              {opened.pick ? <span className="flex flex-wrap gap-1.5">{tags(opened.pick)}</span> : (
                <label className="flex items-center gap-2 text-xs text-mute">{t('podcast.asrLang')}
                  <select value={asr ?? show.lang} onChange={e => setAsr(e.target.value)} className={`${inputCls} !w-40`}>
                    {ASR_LANGS.map(l => <option key={l} value={l}>{l === 'auto' ? t('import.langAuto') : langLabel(l, ui)}</option>)}
                  </select>
                </label>
              )}
            </div>
          </div>
          {show.episodes.length === 0 ? <p className="py-6 text-sm text-mute">{t('podcast.noEpisodes')}</p> : (
            <ul className="border-t border-line">
              {show.episodes.slice(0, limit).map(ep => (
                <li key={ep.guid} className="py-3 border-b border-line flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-[15px] font-medium leading-snug break-words">{ep.title}</p>
                    <p className="mt-0.5 text-xs text-mute">{[dateOf(ep.date), ep.duration && t('podcast.minutes', { n: Math.max(1, Math.round(ep.duration / 60)) })].filter(Boolean).join(' · ')}</p>
                  </div>
                  <div className="shrink-0">{status(show, ep)}</div>
                </li>
              ))}
            </ul>
          )}
          {show.episodes.length > limit && <Btn className="self-center" onClick={() => setLimit(n => n + PAGE)}>{t('podcast.more', { n: PAGE })}</Btn>}
        </>;
      })()}
    </>
  );

  const footer = (
    <p className="text-xs text-mute leading-relaxed">
      {t('podcast.footer')}
    </p>
  );

  if (!onClose) {
    return (
      <div className="pt-6 max-w-3xl mx-auto flex flex-col gap-4">
        {!opened && <div className="mb-2">
          <p className="text-[32px] font-semibold tracking-[-0.02em] leading-tight">{t('podcast.emptyTitle')}</p>
          <p className="mt-2 text-sm text-mute leading-relaxed">{t('podcast.emptyHint')}</p>
        </div>}
        {episodes || shows}
        <div className="pt-2">{footer}</div>
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-3xl h-[min(88vh,800px)] flex flex-col" role="dialog" aria-modal="true" aria-label={t('podcast.title')} onClick={e => e.stopPropagation()}>
        <div className="px-7 pt-7 pb-2">
          <h3 className="text-2xl font-semibold tracking-[-0.01em] leading-tight">{t('podcast.title')}</h3>
          <p className="mt-1 text-sm text-mute">{t('podcast.sub')}</p>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-7 py-4 flex flex-col gap-4">{episodes || shows}</div>
        <div className="px-7 pt-3 pb-6 border-t border-line flex items-end justify-between gap-6">
          {footer}
          <Btn flat onClick={onClose}>{t('podcast.close')}</Btn>
        </div>
      </Card>
    </div>
  );
};

export default PodcastPicker;
