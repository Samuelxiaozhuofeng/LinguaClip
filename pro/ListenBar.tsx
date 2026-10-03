import React from 'react';
import { Pause, Play, Repeat, RotateCcw, RotateCw, SkipBack, SkipForward } from 'lucide-react';
import { Btn, Seg, Stamp } from '../components/ui';
import { formatTimeCode } from '../utils/storage';
import { useT } from '../utils/i18n';

// The listening page's bottom bar: the timeline (section ticks, this section's band), speed,
// line loop, pause at line ends, the page's own switches (`extra`), and the transport.

const SPEEDS = [0.75, 0.9, 1, 1.25, 1.5, 2];

const ListenBar: React.FC<{
  time: number; duration: number; playing: boolean;
  band: [number, number] | null; ticks: number[]; // this section's start / end; where the others start
  speed: number; onSpeed: (s: number) => void;
  loop: boolean; onLoop: () => void;
  autoPause: boolean; onAutoPause: () => void;
  extra: React.ReactNode;
  onSeek: (s: number) => void; onPrev: () => void; onNext: () => void; onBack: () => void; onFwd: () => void; onToggle: () => void;
}> = ({ time, duration, playing, band, ticks, speed, onSpeed, loop, onLoop, autoPause, onAutoPause, extra, onSeek, onPrev, onNext, onBack, onFwd, onToggle }) => {
  const t = useT();
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointermove' && !e.buttons) return;
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    const r = e.currentTarget.getBoundingClientRect();
    if (duration) onSeek(((e.clientX - r.left) / r.width) * duration);
  };
  const pct = (s: number) => `${duration ? Math.min(100, (s / duration) * 100) : 0}%`;
  return (
    <footer className="shrink-0 px-8 pt-3 pb-4 bg-page border-t border-line">
      <div className="flex items-center gap-3">
        <span className="w-12 text-right text-xs tabular-nums text-mute">{formatTimeCode(time)}</span>
        <div className="flex-1 h-4 relative flex items-center cursor-pointer" onPointerDown={scrub} onPointerMove={scrub} role="slider" aria-label={t('transport.seek')}
          aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(time)}>
          <div className="absolute inset-x-0 h-1 rounded-full bg-line" />
          {band && <div className="absolute h-2.5 rounded bg-accent-soft" style={{ left: pct(band[0]), width: `calc(${pct(band[1])} - ${pct(band[0])})` }} />}
          <div className="absolute left-0 h-1 rounded-full bg-ink" style={{ width: pct(time) }} />
          {ticks.map(s => <div key={s} className="absolute w-0.5 h-3 bg-faint" style={{ left: pct(s) }} />)}
          <div className="absolute w-3.5 h-3.5 -ml-[7px] rounded-full bg-accent ring-[3px] ring-page" style={{ left: pct(time) }} />
        </div>
        <span className="w-12 text-xs tabular-nums text-mute">{formatTimeCode(duration)}</span>
      </div>
      <div className="mt-2 flex items-center gap-3">
        {/* Never narrower than its buttons: in a narrow window the key hints on the right give way. */}
        <div className="flex-1 min-w-fit flex items-center gap-2">
          <Seg<number> size="sm" className="shrink-0 [&>button]:px-1.5" value={speed} onChange={onSpeed} options={SPEEDS.map(s => ({ value: s, label: `${s}×` }))} />
          <Btn size="sm" tone={loop ? 'accent-soft' : 'white'} aria-pressed={loop} onClick={onLoop} title={t('listen.loopTitle')}><Repeat size={14} />{t('listen.loop')}</Btn>
          <Btn size="sm" tone={autoPause ? 'accent-soft' : 'white'} aria-pressed={autoPause} onClick={onAutoPause} title={t('watch.autoPauseTitle')}>{t('watch.autoPause')}</Btn>
          {extra}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Btn square flat onClick={onPrev} title={t('transport.previousLine')} aria-label={t('transport.previousLine')} className="!text-ink"><SkipBack size={18} /></Btn>
          <Btn square flat onClick={onBack} title={t('listen.back5')} aria-label={t('listen.back5')} className="!text-ink"><RotateCcw size={18} /></Btn>
          <button type="button" onClick={e => { e.currentTarget.blur(); onToggle(); }} aria-label={playing ? t('transport.pauseSpace') : t('transport.playSpace')}
            className="press w-12 h-12 rounded-full bg-accent text-white flex items-center justify-center">
            {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" className="ml-0.5" />}
          </button>
          <Btn square flat onClick={onFwd} title={t('listen.fwd5')} aria-label={t('listen.fwd5')} className="!text-ink"><RotateCw size={18} /></Btn>
          <Btn square flat onClick={onNext} title={t('transport.nextLine')} aria-label={t('transport.nextLine')} className="!text-ink"><SkipForward size={18} /></Btn>
        </div>
        <div className="flex-1 min-w-0 flex justify-end">
          <Stamp className="truncate">{t('listen.keys')}</Stamp>
        </div>
      </div>
    </footer>
  );
};

export default ListenBar;
