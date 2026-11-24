// Podcasts on the phone (docs/mobile-web.md 3 & docs/android-roadmap.md M1.3):
// 23 recommended shows across 6 languages, subscribed shows, OPML import, and an
// Apple Podcasts / RSS box; picking one opens its episodes (Episodes.tsx).
import React, { useRef, useState } from 'react';
import { useLang, useT } from '../utils/i18n';
import { getWatchPrefs, saveWatchPrefs } from '../utils/storage';
import { SHOWS, SHOW_LANGS, type Pick, type ShowLang } from '../pro/podcastShows';
import { appleFeed, classifyPaste } from '../pro/podcastFeed';
import {
  getPodcastSubs,
  mergePodcastSubs,
  parseOpml,
  removePodcastSub,
  type PodcastSub,
} from './opml';
import { Header, LangBar, btnSmall, btnSoft, sheet } from './ui';

export type ShowRef = { url: string; pick?: Pick; title?: string; image?: string };

const initialLang = (ui: string): ShowLang => {
  const saved = getWatchPrefs().podLang as ShowLang;
  return SHOW_LANGS.includes(saved) ? saved : ui === 'en' ? 'ja' : 'en';
};

export const Podcast: React.FC<{ onBack: () => void; onShow: (s: ShowRef) => void }> = ({ onBack, onShow }) => {
  const t = useT();
  const ui = useLang();
  const [lang, setLangState] = useState<ShowLang>(() => initialLang(ui));
  const [subs, setSubs] = useState<PodcastSub[]>(() => getPodcastSubs());
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [opmlNote, setOpmlNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const opmlInput = useRef<HTMLInputElement>(null);

  const setLang = (next: ShowLang) => {
    setLangState(next);
    saveWatchPrefs({ podLang: next });
  };

  const open = async () => {
    const p = classifyPaste(text);
    setNote('');
    if (p.kind === 'feed') return onShow({ url: p.url });
    if (p.kind === 'closed') return setNote(t('podcast.closed', { name: p.name }));
    if (p.kind === 'bad') return setNote(t('podcast.bad'));
    setBusy(true);
    try { onShow({ url: await appleFeed(p.id) }); } catch (e) { console.error(e); setNote(t('m.feedFail')); } finally { setBusy(false); }
  };

  const importOpmlFile = async (file: File) => {
    setOpmlNote(null);
    try {
      const xml = await file.text();
      const parsed = parseOpml(xml);
      if (parsed.length === 0) {
        setOpmlNote({ kind: 'err', text: t('m.opmlEmpty') });
        return;
      }
      const res = mergePodcastSubs(parsed);
      setSubs(res.list);
      setOpmlNote({ kind: 'ok', text: t('m.opmlImported', { n: res.added }) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setOpmlNote({ kind: 'err', text: t('m.opmlFail', { msg }) });
    }
  };

  return (
    <>
      <Header title={t('m.podcast')} onBack={onBack} />
      <div className="px-5 pb-8 flex flex-col gap-3">
        {subs.length > 0 && (
          <>
            <p className="text-[13px] text-mute">{t('m.subscribed')}</p>
            <ul className={`${sheet} flex flex-col`}>
              {subs.map(sub => (
                <li key={sub.feed} className="border-b border-shade last:border-0 flex items-center gap-2 pr-2">
                  <button
                    onClick={() => onShow({ url: sub.feed, title: sub.title, image: sub.image })}
                    className="flex-1 min-w-0 min-h-[56px] pl-4 py-3 text-left flex items-center gap-3"
                  >
                    {sub.image && <img src={sub.image.replace(/^http:\/\//i, 'https://')} alt="" className="w-10 h-10 rounded-lg object-cover bg-shade shrink-0" />}
                    <span className="text-[15px] truncate">{sub.title}</span>
                  </button>
                  <button
                    className="min-h-[44px] px-3 text-xs text-mute shrink-0"
                    onClick={() => setSubs(removePodcastSub(sub.feed))}
                  >
                    {t('m.unsub')}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <p className={`text-[13px] text-mute ${subs.length > 0 ? 'mt-2' : ''}`}>{t('podcast.recommended')}</p>
        <LangBar<ShowLang> langs={SHOW_LANGS} value={lang} onChange={setLang} ui={ui} />
        <ul className={`${sheet} flex flex-col`}>
          {SHOWS.filter(s => s.lang === lang).map(s => (
            <li key={s.id} className="border-b border-shade last:border-0">
              <button onClick={() => onShow({ url: s.feed, pick: s })} className="w-full min-h-[56px] px-4 py-3 text-left flex flex-col gap-0.5">
                <span className="text-[15px]">{s.name}</span>
                <span className="text-xs text-mute">{[t(`podcast.level_${s.level}`), t(s.slow ? 'podcast.slow' : 'podcast.natural'), t(`podcast.style_${s.style}`), s.english && t('podcast.english')].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>

        <p className="text-[13px] text-mute mt-3">{t('podcast.orPaste')}</p>
        <div className={`${sheet} p-4 flex flex-col gap-2.5`}>
          <input aria-label={t('podcast.pastePlaceholder')} value={text} onChange={e => setText(e.target.value)} placeholder={t('podcast.pastePlaceholder')}
            className="h-11 rounded-[10px] border border-line px-3 text-[15px]" />
          <div className="flex gap-2">
            <button className={`${btnSmall} flex-1`} disabled={busy || !text.trim()} onClick={() => { void open(); }}>{t('podcast.open')}</button>
            <button className={btnSoft} onClick={() => opmlInput.current?.click()}>{t('m.opmlImport')}</button>
          </div>
          <input
            ref={opmlInput}
            type="file"
            accept=".opml,.xml,text/xml,application/xml"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void importOpmlFile(f);
            }}
          />
          {note && <p role="alert" className="text-[13px] text-accent">{note}</p>}
          {opmlNote && (
            <p role={opmlNote.kind === 'err' ? 'alert' : 'status'} className={`text-[13px] ${opmlNote.kind === 'err' ? 'text-accent' : 'text-mute'}`}>
              {opmlNote.text}
            </p>
          )}
        </div>
      </div>
    </>
  );
};
