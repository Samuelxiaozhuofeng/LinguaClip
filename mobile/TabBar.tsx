// Fixed bottom 4-tab bar for the phone shell (docs/android-roadmap.md M2.1):
// Home / Podcasts / Review (with due badge) / Settings, respecting bottom safe-area inset.
import React from 'react';
import { Home, Layers, Podcast, Settings } from 'lucide-react';
import { useT, type DictKey } from '../utils/i18n';

export type TabId = 'home' | 'podcast' | 'review' | 'settings';

const TABS: { id: TabId; labelKey: DictKey; Icon: React.FC<{ size?: number; strokeWidth?: number }> }[] = [
  { id: 'home', labelKey: 'm.tabHome', Icon: Home },
  { id: 'podcast', labelKey: 'm.tabPodcast', Icon: Podcast },
  { id: 'review', labelKey: 'm.tabReview', Icon: Layers },
  { id: 'settings', labelKey: 'm.tabSettings', Icon: Settings },
];

export const TabBar: React.FC<{
  active: TabId;
  due: number;
  onSelect: (tab: TabId) => void;
}> = ({ active, due, onSelect }) => {
  const t = useT();
  return (
    <nav
      aria-label="Primary"
      className="fixed bottom-0 inset-x-0 z-20 bg-page/95 backdrop-blur border-t border-line pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
    >
      <div className="grid grid-cols-4">
        {TABS.map(({ id, labelKey, Icon }) => {
          const on = active === id;
          const badge = id === 'review' && due > 0 ? (due > 99 ? '99+' : String(due)) : null;
          return (
            <button
              key={id}
              type="button"
              aria-current={on ? 'page' : undefined}
              onClick={() => onSelect(id)}
              className={`min-h-[54px] py-1.5 flex flex-col items-center justify-center gap-0.5 text-[11px] ${on ? 'text-accent font-semibold' : 'text-mute'}`}
            >
              <span className="relative inline-flex items-center justify-center">
                <Icon size={20} strokeWidth={on ? 2.2 : 1.8} />
                {badge && (
                  <span
                    data-testid="tab-review-badge"
                    className="absolute -top-1.5 -right-3 min-w-[18px] h-[18px] px-1 rounded-full bg-accent text-white text-[10px] font-semibold leading-[18px] text-center tabular-nums"
                  >
                    {badge}
                  </span>
                )}
              </span>
              <span>{t(labelKey)}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};
