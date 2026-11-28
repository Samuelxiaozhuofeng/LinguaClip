import React from 'react';
import { AppState } from '../types';
import { useT } from '../utils/i18n';
import { IS_WINDOWS } from '../utils/platform';
import { useDueSnapshot } from '../hooks/useDueSnapshot';
import { UpdatePill } from './UpdateUI';
import AddMenu from './AddMenu';

// Page frame for the non-practice screens: wordmark, a centred pill of three tabs
// (Learn, Review with combined due count, Settings), the Learn page's "+ Add" menu, scrolling body.
const Shell: React.FC<{
  active: AppState;
  onNav: (s: AppState) => void;
  onAddLocal: () => void;
  onAddPodcast?: () => void;
  hideAdd?: boolean;
  children: React.ReactNode;
}> = ({ active, onNav, onAddLocal, onAddPodcast, hideAdd, children }) => {
  const t = useT();
  const due = useDueSnapshot(); // shared with home's "Today" bar, so the numbers agree
  const isLearn = active === AppState.UPLOAD || active === AppState.PODCASTS;
  const isReview = active === AppState.LIBRARY || active === AppState.CARDS;
  const dueTotal = (due?.line ?? 0) + (due?.word ?? 0);
  const NAV: { state: AppState; label: string; on: boolean; badge?: number }[] = [
    { state: AppState.UPLOAD, label: t('nav.learn'), on: isLearn },
    { state: AppState.LIBRARY, label: t('nav.review'), on: isReview, badge: dueTotal },
    { state: AppState.SETTINGS, label: t('nav.settings'), on: active === AppState.SETTINGS },
  ];
  return (
  <div className="h-full flex flex-col">
    {/* The Mac's traffic lights sit top-left, so the wordmark starts after them. */}
    <header className={`shrink-0 relative h-16 ${IS_WINDOWS ? 'pl-6' : 'pl-24'} pr-6 lg:pr-10 flex items-center justify-between`} data-tauri-drag-region="deep">
      <span className="flex items-center"><span className="text-[15px] font-semibold select-none">LinguaClip</span><UpdatePill /></span>
      <nav className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex gap-0.5 p-1 bg-page border border-line rounded-full">
        {NAV.map(({ state, label, on, badge }) => (
          <button
            key={state}
            onClick={() => onNav(state)}
            aria-current={on ? 'page' : undefined}
            className={`h-8 px-4 rounded-full flex items-center gap-1.5 text-[13px] transition-colors
              ${on ? 'bg-ink text-inverse' : 'text-mute hover:text-ink'}`}
          >
            {label}
            {!!badge && <span className={`text-xs tabular-nums ${on ? 'text-inverse' : 'text-accent'}`}>{badge}</span>}
          </button>
        ))}
      </nav>
      <span className="flex items-center gap-2">
        {/* Home's empty state carries its own big add button; one is enough. */}
        {isLearn && !hideAdd && <AddMenu onAddLocal={onAddLocal} onAddPodcast={onAddPodcast} />}
      </span>
    </header>
    <main className="flex-1 overflow-y-auto">
      <div className="max-w-[1280px] mx-auto px-6 md:px-12 lg:px-24 pt-4 pb-12">{children}</div>
    </main>
  </div>
  );
};

export default Shell;
