import React from 'react';
import { Plus, Youtube } from 'lucide-react';
import { VideoRecord } from '../types';
import { HomeStarter } from '@pro';
import { useT } from '../utils/i18n';
import { openYouTube, useYouTubeEntry } from '../utils/youtube';
import { dialog } from './Dialog';
import { Btn } from './ui';

interface HomeEmptyProps {
  kind: 'all' | 'video' | 'podcast';
  onAddLocal: () => void;
  onAddPodcast?: () => void;
  podcastPicker?: React.ReactNode;
  onOpenStarter: (r: VideoRecord) => void;
}

// The Learn page's three empty states: whole library empty, filtered to videos with none yet,
// or filtered to podcasts with none yet (shows PodcastPicker inline below TodayBar & filter).
const HomeEmpty: React.FC<HomeEmptyProps> = ({ kind, onAddLocal, onAddPodcast, podcastPicker, onOpenStarter }) => {
  const t = useT();
  const ytOn = useYouTubeEntry();
  const openYt = () => {
    openYouTube().catch(err => {
      console.error('YouTube window:', err);
      dialog.alert(t('youtube.openFailTitle'), String(err));
    });
  };

  if (kind === 'podcast') {
    return <>{podcastPicker}</>;
  }

  if (kind === 'video') {
    return (
      <div className="pt-14 pb-8 flex flex-col items-center text-center">
        <p className="text-2xl font-semibold tracking-[-0.01em]">{t('home.noVideosYet')}</p>
        <p className="mt-2.5 text-sm text-mute max-w-sm leading-relaxed">{t('home.noVideosHint')}</p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Btn tone="accent" onClick={onAddLocal}><Plus size={16} /> {t('home.addVideo')}</Btn>
          {ytOn && <Btn onClick={openYt}><Youtube size={16} className="text-accent" /> {t('youtube.entry')}</Btn>}
        </div>
      </div>
    );
  }

  return (
    <div className="pt-16 flex flex-col items-center text-center">
      <p className="text-[40px] font-semibold tracking-[-0.02em] leading-tight">{t('home.nothingHereYet')}</p>
      <p className="mt-3 text-sm text-mute max-w-sm leading-relaxed">{t('home.nothingHereHint')}</p>
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Btn tone="accent" size="lg" onClick={onAddLocal}><Plus size={18} /> {t('home.addVideo')}</Btn>
        {ytOn && <Btn size="lg" onClick={openYt}><Youtube size={18} className="text-accent" /> {t('youtube.entry')}</Btn>}
      </div>
      {HomeStarter && <div className="mt-10 w-full max-w-2xl text-left"><HomeStarter onOpen={onOpenStarter} /></div>}
      {onAddPodcast && (
        <button
          type="button"
          onClick={onAddPodcast}
          className="mt-5 text-[13px] text-mute hover:text-ink transition-colors underline-offset-4 hover:underline"
        >
          {t('home.orPodcast')}
        </button>
      )}
    </div>
  );
};

export default HomeEmpty;
