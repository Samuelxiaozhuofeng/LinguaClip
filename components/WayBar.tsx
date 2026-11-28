import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { VideoRecord } from '../types';
import { isAudioRecord } from '../utils/desktop';
import { useT } from '../utils/i18n';
import { formatCombo, useShortcuts } from '../utils/shortcuts';
import { StudyWay, WAY_SHORTCUT, wayForKey, waysForRecord } from '../utils/studyWays';

export interface WayBarProps {
  current: StudyWay;
  record: Pick<VideoRecord, 'podcast' | 'videoPath' | 'videoFileName'>;
  hasReader: boolean;
  hasListen: boolean;
  // cinema = floating pill over Watch/Studio video, light = Reader top bar, compact = ListenPage dropdown capsule
  variant: 'cinema' | 'light' | 'compact';
  disabled?: boolean; // e.g. recording Anki clip
  blocked?: boolean;  // true while a modal/summary/drill owns keyboard input (disables ⌘1–⌘4)
  onSelect: (way: StudyWay) => void;
}

// Shared in-place study-way switcher mounted in the top bar of all four practice views
// (docs/watch.md「页内切换练法」). Also listens for ⌘1–⌘4 when not disabled/blocked.
const WayBar: React.FC<WayBarProps> = ({
  current, record, hasReader, hasListen, variant, disabled = false, blocked = false, onSelect,
}) => {
  const t = useT();
  const combos = useShortcuts();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const ways = waysForRecord(record, hasReader);
  const audioListen = hasListen && isAudioRecord(record);

  const labelOf = (w: StudyWay) =>
    w === 'read' ? t('way.read')
    : w === 'watch' ? t(audioListen ? 'way.listen' : 'way.watch')
    : w === 'blur' ? t('way.blur')
    : t('way.dict');

  const keyOf = (w: StudyWay) => formatCombo(combos[WAY_SHORTCUT[w]]);
  const titleOf = (w: StudyWay) => {
    const k = keyOf(w);
    return k ? `${labelOf(w)} (${k})` : labelOf(w);
  };

  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    if (disabled || blocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.repeat) return;
      const hit = wayForKey(e, record, hasReader);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      if (hit !== current) selectRef.current(hit);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [disabled, blocked, current, record, hasReader]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onEsc, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onEsc, true); };
  }, [open]);

  if (variant === 'compact') {
    return (
      <div ref={wrapRef} className="relative shrink-0">
        <button
          type="button"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={t('way.label')}
          title={titleOf(current)}
          onClick={e => { e.currentTarget.blur(); setOpen(o => !o); }}
          className="press h-10 pl-3.5 pr-3 flex items-center gap-1.5 rounded-full bg-page border border-line text-ink text-[13px] font-medium hover:bg-shade disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
        >
          <span>{labelOf(current)}</span>
          <ChevronDown size={14} className={`text-mute transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
        {open && (
          <div role="menu" aria-label={t('way.label')}
            className="absolute left-0 top-[calc(100%+6px)] z-50 min-w-[168px] p-1.5 rounded-xl bg-page border border-line shadow-lift flex flex-col gap-0.5">
            {ways.map(w => {
              const active = w === current;
              const k = keyOf(w);
              return (
                <button
                  key={w}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  disabled={disabled}
                  onClick={e => { e.currentTarget.blur(); setOpen(false); if (!active) onSelect(w); }}
                  className={`h-9 px-2.5 rounded-lg text-[13px] flex items-center justify-between gap-3 text-left transition-colors ${
                    active ? 'bg-shade text-ink font-medium' : 'text-ink hover:bg-shade/70'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="w-3.5 flex items-center justify-center">{active && <Check size={14} className="text-accent" />}</span>
                    <span>{labelOf(w)}</span>
                  </span>
                  {k && <span className="text-[11px] text-mute tabular-nums">{k}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  const shell = variant === 'cinema'
    ? 'inline-flex items-center p-1 gap-0.5 rounded-full bg-page border border-line shadow-sm shrink-0'
    : 'inline-flex items-center p-[3px] gap-0.5 rounded-full bg-shade shrink-0';

  return (
    <div className={shell} role="tablist" aria-label={t('way.label')}>
      {ways.map(w => {
        const active = w === current;
        return (
          <button
            key={w}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={disabled}
            title={titleOf(w)}
            onClick={e => { e.currentTarget.blur(); if (!active) onSelect(w); }}
            className={`press h-8 px-3 rounded-full text-[13px] font-medium whitespace-nowrap transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              active
                ? 'bg-ink text-inverse'
                : 'text-mute hover:text-ink hover:bg-shade/70'
            }`}
          >
            {labelOf(w)}
          </button>
        );
      })}
    </div>
  );
};

export default WayBar;
