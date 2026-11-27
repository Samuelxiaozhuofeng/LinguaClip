import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Film, Headphones, Plus, Youtube } from 'lucide-react';
import { useT } from '../utils/i18n';
import { openYouTube, useYouTubeEntry } from '../utils/youtube';
import { dialog } from './Dialog';

// Top-bar single "+ Add ▾" entry on the Learn page: local files, optional YouTube window,
// and optional Podcast picker (Pro). Closes on item click, outside click, or Esc.
const AddMenu: React.FC<{
  onAddLocal: () => void;
  onAddPodcast?: () => void;
}> = ({ onAddLocal, onAddPodcast }) => {
  const t = useT();
  const ytOn = useYouTubeEntry();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const openYt = () => {
    openYouTube().catch(err => {
      console.error('YouTube window:', err);
      dialog.alert(t('youtube.openFailTitle'), String(err));
    });
  };

  const run = (fn: () => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
    setOpen(false);
    fn();
  };

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={e => { e.currentTarget.blur(); setOpen(o => !o); }}
        className={`press h-[42px] pl-3.5 pr-3.5 rounded-full bg-page border flex items-center gap-1.5 text-[13px] whitespace-nowrap transition-colors ${open ? 'border-ink/20' : 'border-line hover:border-ink/20'}`}
      >
        <Plus size={16} strokeWidth={2.25} className="text-accent" />
        <span>{t('home.add')}</span>
        <ChevronDown size={14} className={`text-mute transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute z-30 top-full mt-2 right-0 card min-w-[232px] p-1.5 fade-in" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={run(onAddLocal)}
            className="w-full px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-left hover:bg-shade transition-colors"
          >
            <Film size={16} className="shrink-0 text-mute" />
            <span className="min-w-0 flex flex-col">
              <span className="text-sm text-ink leading-snug">{t('home.addLocal')}</span>
              <span className="text-xs text-mute leading-snug">{t('home.addLocalSub')}</span>
            </span>
          </button>
          {ytOn && (
            <button
              type="button"
              role="menuitem"
              onClick={run(openYt)}
              className="w-full px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-left hover:bg-shade transition-colors"
            >
              <Youtube size={16} className="shrink-0 text-accent" />
              <span className="text-sm text-ink leading-snug">{t('youtube.entry')}</span>
            </button>
          )}
          {onAddPodcast && (
            <button
              type="button"
              role="menuitem"
              onClick={run(onAddPodcast)}
              className="w-full px-2.5 py-2 rounded-lg flex items-center gap-2.5 text-left hover:bg-shade transition-colors"
            >
              <Headphones size={16} className="shrink-0 text-mute" />
              <span className="min-w-0 flex flex-col">
                <span className="text-sm text-ink leading-snug">{t('home.addPodcastMenu')}</span>
                <span className="text-xs text-mute leading-snug">{t('home.addPodcastSub')}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};

export default AddMenu;
