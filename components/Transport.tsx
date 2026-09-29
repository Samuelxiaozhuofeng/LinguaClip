import React from 'react';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, Repeat, Bookmark, PlusCircle, Volume2, VolumeX, Mic, Check, X, Loader2, MoreHorizontal, Keyboard } from 'lucide-react';
import { usePracticeContext } from '../hooks/usePracticeContext';
import { Btn, Menu, MenuItem, Seg } from './ui';
import { useT } from '../utils/i18n';
import { formatCombo, useShortcuts, ActionId } from '../utils/shortcuts';
import { useLoop, setLoopTimes, LOOP_TIMES } from '../utils/loop';
import { LearningMode, BlurPlaybackMode } from '../types';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];

// The remote along the bottom of the practice sheet: save / Anki / mute on the left,
// the play controls in the middle, a "…" on the right for the rarer settings (speed,
// plus whatever the page adds: cloze level, video size, breakdown, the key legend).
const Transport: React.FC<{ menuItems: MenuItem[]; menuPanel?: React.ReactNode; pinned: boolean; onTogglePinned: () => void }> = ({ menuItems, menuPanel, pinned, onTogglePinned }) => {
  const t = useT();
  const { practice, video, saved, anki, actions } = usePracticeContext();
  const loop = useLoop();
  const noLoop = practice.learningMode === LearningMode.BLUR && practice.blurPlaybackMode === BlurPlaybackMode.CONTINUOUS;
  const { isPlaying, volume, playbackSpeed } = video;
  const { isCurrentSaved } = saved;
  const { ankiConfig, ankiStatus } = anki;

  const ankiReady = !!ankiConfig?.card;
  const recording = ankiStatus === 'recording';

  const ankiFace = () => {
    switch (ankiStatus) {
      case 'recording': return { icon: <Mic size={15} />, label: t('transport.rec') };
      case 'adding': return { icon: <Loader2 size={15} className="animate-spin" />, label: t('transport.adding') };
      case 'success': return { icon: <Check size={15} />, label: t('common.added') };
      case 'error': return { icon: <X size={15} />, label: t('common.failed') };
      default: return { icon: <PlusCircle size={15} />, label: 'Anki' };
    }
  };
  const af = ankiFace();
  const combos = useShortcuts();
  const withKey = (label: string, id: ActionId) => `${label} (${formatCombo(combos[id])})`;
  const items: MenuItem[] = [...menuItems, { label: <><Keyboard size={15} /> {pinned ? t('keys.hide') : t('keys.show')}</>, onClick: onTogglePinned }];

  return (
    <footer className={`relative shrink-0 h-[76px] px-6 lg:px-24 flex items-center text-mute transition-colors ${recording ? 'bg-accent-soft' : ''}`}>
      <div className="flex-1 min-w-0 flex items-center gap-0.5 -ml-2">
        <Btn square size="sm" flat onClick={actions.onToggleSaveCurrent} title={isCurrentSaved ? t('transport.unsaveLine') : t('transport.saveLine')} className={isCurrentSaved ? '!text-accent' : ''}>
          <Bookmark size={17} fill={isCurrentSaved ? 'currentColor' : 'none'} />
        </Btn>
        {ankiReady && (
          <Btn size="sm" flat disabled={ankiStatus !== 'idle'} onClick={actions.onAddToAnki} title={withKey(t('transport.sendToAnki'), 'anki')} className={ankiStatus === 'idle' ? '' : '!opacity-100 !text-ink'}>
            {af.icon} <span className="hidden sm:inline">{af.label}</span>
          </Btn>
        )}
        <Btn square size="sm" flat onClick={() => actions.onSetVolume(volume === 0 ? 1 : 0)} title={volume === 0 ? t('transport.unmute') : t('transport.mute')}>
          {volume === 0 ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </Btn>
        {playbackSpeed !== 1 && <span className="px-1.5 text-[13px] tabular-nums">{playbackSpeed}×</span>}
        {recording && <span className="ml-2 truncate text-xs blink text-accent">{t('transport.recordingBanner')}</span>}
      </div>

      <div className="flex items-center gap-2 shrink-0 text-ink">
        <Btn square flat onClick={() => actions.onSkip('prev')} title={withKey(t('transport.previousLine'), 'prev')} className="!text-ink"><SkipBack size={18} /></Btn>
        <Btn square flat onClick={() => actions.onReplayCurrent()} title={withKey(t('transport.replayLine'), 'replay')} className="!text-ink"><RotateCcw size={18} /></Btn>
        <Btn square flat onClick={actions.onToggleLoop} disabled={noLoop} aria-pressed={loop.on && !noLoop}
          title={noLoop ? t('transport.loopNo') : withKey(t(loop.on ? 'transport.loopOn' : 'transport.loopOff'), 'loop')}
          className={`relative ${loop.on && !noLoop ? '!text-accent' : '!text-ink'}`}>
          <Repeat size={18} />
          {loop.on && !noLoop && loop.times > 0 && <span className="absolute right-0.5 bottom-0.5 text-[10px] font-semibold leading-none">{loop.times}</span>}
        </Btn>
        <button type="button" onClick={e => { e.currentTarget.blur(); actions.onTogglePlay(); }} title={withKey(isPlaying ? t('transport.pauseSpace') : t('transport.playSpace'), 'play')}
          aria-label={isPlaying ? t('transport.pauseSpace') : t('transport.playSpace')}
          className="press w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center">
          {isPlaying ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" className="ml-0.5" />}
        </button>
        <Btn square flat onClick={() => actions.onSkip('next')} title={withKey(t('transport.nextLine'), 'next')} className="!text-ink"><SkipForward size={18} /></Btn>
      </div>

      <div className="flex-1 flex justify-end -mr-2">
        <Menu up items={items} className="w-[300px]" trigger={(open, toggle) => (
          <Btn square size="sm" flat onClick={toggle} title={t('home.more')} aria-label={t('home.more')} className={open ? '!bg-shade !text-ink' : ''}>
            <MoreHorizontal size={18} />
          </Btn>
        )}>
          <div className="px-2.5 py-2 flex flex-col gap-2">
            <span className="text-xs text-mute">{t('transport.speed')}</span>
            <Seg size="sm" className="w-full [&>button]:flex-1" value={playbackSpeed} onChange={actions.onSetPlaybackSpeed} options={SPEEDS.map(s => ({ value: s, label: `${s}×` }))} />
          </div>
          <div className="px-2.5 py-2 flex flex-col gap-2">
            <span className="text-xs text-mute">{t('transport.loopTimes')}</span>
            <Seg size="sm" className="w-full [&>button]:flex-1" value={loop.times} onChange={setLoopTimes} options={LOOP_TIMES.map(n => ({ value: n, label: n ? t('transport.loopN', { n }) : t('transport.loopForever') }))} />
          </div>
          {menuPanel}
          <div className="my-1.5 mx-1 border-t border-line" />
        </Menu>
      </div>
    </footer>
  );
};

export default Transport;
