import React from 'react';
import { Youtube } from 'lucide-react';
import { useT } from '../utils/i18n';
import { openYouTube, useYouTubeEntry } from '../utils/youtube';
import { dialog } from './Dialog';

// Home's top bar: "Find videos on YouTube" opens the in-app YouTube window
// (docs/youtube.md). Settings → Import & transcribe can hide it for good.
const YouTubeEntry: React.FC = () => {
  const t = useT();
  const on = useYouTubeEntry();
  if (!on) return null;
  const open = () => {
    openYouTube().catch(err => {
      console.error('YouTube window:', err);
      dialog.alert(t('youtube.openFailTitle'), String(err));
    });
  };
  // The tabs sit centred over the whole bar: on a narrow window the label shrinks so the
  // button never covers them (icon only below lg, "YouTube" up to xl).
  return (
    <button onClick={open} title={t('youtube.entry')} aria-label={t('youtube.entry')}
      className="press h-[42px] px-3 lg:pl-3.5 lg:pr-4 rounded-full bg-page border border-line flex items-center gap-1.5 text-[13px] whitespace-nowrap hover:border-ink/20">
      <Youtube size={16} strokeWidth={2.25} className="text-accent" />
      <span className="hidden xl:inline">{t('youtube.entry')}</span>
      <span className="hidden lg:inline xl:hidden">YouTube</span>
    </button>
  );
};

export default YouTubeEntry;
