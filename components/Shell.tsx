import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { AppState } from '../types';
import { useT } from '../utils/i18n';
import { IS_WINDOWS } from '../utils/platform';
import { deckCounts, getAllCards, subscribeCards } from '../utils/review';
import { UpdatePill } from './UpdateUI';
import { listenTrial } from '@pro';

// Page frame for the non-practice screens: wordmark, a centred pill of tabs (the two
// libraries carry how many cards are due), the quiet "add video" button, scrolling body.
// `podcasts`: the official build's podcast tab (a small grey "Pro" until activated).
const Shell: React.FC<{ active: AppState; onNav: (s: AppState) => void; onAdd: () => void; hideAdd?: boolean; podcasts?: boolean; children: React.ReactNode }> = ({ active, onNav, onAdd, hideAdd, podcasts, children }) => {
  const t = useT();
  const [due, setDue] = useState({ line: 0, word: 0 });
  useEffect(() => {
    const load = () => getAllCards().then(c => { const n = deckCounts(c); setDue({ line: n.line.due, word: n.word.due }); }).catch(() => {});
    load();
    return subscribeCards(load);
  }, []);
  const NAV: { state: AppState; label: string; badge?: number; pro?: boolean }[] = [
    { state: AppState.UPLOAD, label: t('nav.videos') },
    ...(podcasts ? [{ state: AppState.PODCASTS, label: t('nav.podcasts'), pro: !listenTrial('').pro }] : []),
    { state: AppState.LIBRARY, label: t('nav.saved'), badge: due.line },
    { state: AppState.CARDS, label: t('nav.cards'), badge: due.word },
    { state: AppState.SETTINGS, label: t('nav.settings') },
  ];
  return (
  <div className="h-full flex flex-col">
    {/* The Mac's traffic lights sit top-left, so the wordmark starts after them. */}
    <header className={`shrink-0 relative h-16 ${IS_WINDOWS ? 'pl-6' : 'pl-24'} pr-6 lg:pr-10 flex items-center justify-between`} data-tauri-drag-region="deep">
      <span className="flex items-center"><span className="text-[15px] font-semibold select-none">LinguaClip</span><UpdatePill /></span>
      <nav className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-0.5 p-1 bg-page border border-line rounded-full">
        {NAV.map(({ state, label, badge, pro }) => {
          const on = active === state;
          return (
            <button
              key={state}
              onClick={() => onNav(state)}
              aria-current={on ? 'page' : undefined}
              className={`h-8 px-4 rounded-full flex items-center gap-1.5 text-[13px] transition-colors
                ${on ? 'bg-ink text-white' : 'text-mute hover:text-ink'}`}
            >
              {label}
              {pro && <span className={`px-1 rounded text-[10px] font-semibold ${on ? 'bg-white/20 text-white' : 'bg-shade text-mute'}`}>Pro</span>}
              {!!badge && <span className={`text-xs tabular-nums ${on ? 'text-white' : 'text-accent'}`}>{badge}</span>}
            </button>
          );
        })}
      </nav>
      {/* Home's empty state carries its own big add button; one is enough. */}
      {!hideAdd && (
        <button onClick={onAdd}
          className="press h-[42px] pl-3.5 pr-4 rounded-full bg-page border border-line flex items-center gap-1.5 text-[13px] hover:border-ink/20">
          <Plus size={16} strokeWidth={2.25} className="text-accent" />{t(active === AppState.PODCASTS ? 'home.addPodcast' : 'home.addVideo')}
        </button>
      )}
    </header>
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-[1280px] mx-auto px-6 md:px-12 lg:px-24 pt-4 pb-12">{children}</div>
    </main>
  </div>
  );
};

export default Shell;
