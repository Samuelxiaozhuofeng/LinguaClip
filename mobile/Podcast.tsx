// Podcasts on the phone (docs/mobile-web.md 3): recommended shows by language plus a
// box for an Apple Podcasts / RSS link; picking one opens its episodes (Episodes.tsx).
import React, { useState } from 'react';
import { useLang, useT } from '../utils/i18n';
import { SHOWS, SHOW_LANGS, type Pick, type ShowLang } from '../pro/podcastShows';
import { classifyPaste } from '../pro/podcastFeed';
import { Header, LangBar, btnSmall, sheet } from './ui';

export type ShowRef = { url: string; pick?: Pick };

// An Apple show id → its RSS address (iTunes lookup answers browsers directly).
async function appleFeed(id: string): Promise<string> {
  const res = await fetch(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=podcast`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const url = (await res.json())?.results?.find((r: { feedUrl?: unknown }) => typeof r.feedUrl === 'string')?.feedUrl;
  if (!url) throw new Error('no feed');
  return url;
}

export const Podcast: React.FC<{ onBack: () => void; onShow: (s: ShowRef) => void }> = ({ onBack, onShow }) => {
  const t = useT();
  const ui = useLang();
  const [lang, setLang] = useState<ShowLang>(ui === 'en' ? 'ja' : 'en');
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const open = async () => {
    const p = classifyPaste(text);
    setNote('');
    if (p.kind === 'feed') return onShow({ url: p.url });
    if (p.kind === 'closed') return setNote(t('podcast.closed', { name: p.name }));
    if (p.kind === 'bad') return setNote(t('podcast.bad'));
    setBusy(true);
    try { onShow({ url: await appleFeed(p.id) }); } catch (e) { console.error(e); setNote(t('m.feedFail')); } finally { setBusy(false); }
  };
  return (
    <>
      <Header title={t('m.podcast')} onBack={onBack} />
      <div className="px-5 pb-8 flex flex-col gap-3">
        <p className="text-[13px] text-mute">{t('podcast.recommended')}</p>
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
          <button className={btnSmall} disabled={busy || !text.trim()} onClick={() => { void open(); }}>{t('podcast.open')}</button>
          {note && <p role="alert" className="text-[13px] text-accent">{note}</p>}
        </div>
      </div>
    </>
  );
};
