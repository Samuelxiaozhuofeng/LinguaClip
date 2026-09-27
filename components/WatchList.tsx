import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { Subtitle } from '../types';
import { Btn } from './ui';
import { formatTimeCode, LIST_PCT } from '../utils/storage';
import { useT } from '../utils/i18n';

// Watch mode's subtitle list, docked on the right (like asbplayer): the line
// playing is marked and kept in view, a click jumps there, the left edge drags
// to resize. Auto-scroll waits while the pointer is on the list, so a line
// being aimed at never slides away. Text only — never parsed as HTML.
const WatchList: React.FC<{
  lines: Subtitle[];
  at: number;
  pct: number;
  onPick: (i: number) => void;
  onResize: (pct: number, done: boolean) => void;
  onClose: () => void;
}> = ({ lines, at, pct, onPick, onResize, onClose }) => {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const hover = useRef(false);

  const follow = (smooth: boolean) => {
    const el = box.current, row = el?.querySelector<HTMLElement>(`[data-i="${at}"]`);
    if (!el || !row || hover.current) return;
    el.scrollTo({ top: row.offsetTop - el.clientHeight / 2 + row.offsetHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
  };
  useEffect(() => follow(true), [at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => follow(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.type === 'pointercancel') return onResize(pct, true); // e.g. app switch mid-drag: keep what's shown
    if (e.type === 'pointerdown') e.currentTarget.setPointerCapture(e.pointerId);
    else if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const p = ((window.innerWidth - e.clientX) / window.innerWidth) * 100;
    onResize(Math.min(LIST_PCT.max, Math.max(LIST_PCT.min, p)), e.type === 'pointerup');
  };

  return (
    <aside data-watch-list className="absolute inset-y-0 right-0 flex flex-col bg-page border-l border-line cursor-auto" style={{ width: `${pct}%` }}>
      <div onPointerDown={drag} onPointerMove={drag} onPointerUp={drag} onPointerCancel={drag} title={t('watch.listResize')}
        className="absolute inset-y-0 -left-1.5 w-3 z-10 cursor-col-resize group">
        <div className="mx-auto h-full w-0.5 group-hover:bg-accent/60" />
      </div>
      <div className="h-12 shrink-0 pl-4 pr-2 flex items-center justify-between border-b border-line" data-tauri-drag-region>
        <span className="text-sm text-ink">{t('watch.list')}</span>
        <Btn square size="sm" flat onClick={onClose} aria-label={t('common.close')} title={t('common.close')}><X size={16} /></Btn>
      </div>
      <div ref={box} className="relative flex-1 overflow-y-auto py-2" onMouseEnter={() => { hover.current = true; }} onMouseLeave={() => { hover.current = false; }}>
        {lines.map((l, i) => (
          <button key={l.id} type="button" data-i={i} onClick={e => { e.currentTarget.blur(); if (!window.getSelection()?.toString()) onPick(i); }} // a drag to select text isn't a jump
            className={`w-full text-left px-4 py-2 flex gap-3 border-l-2 ${i === at ? 'border-accent bg-accent-soft text-ink' : 'border-transparent text-ink/70 hover:bg-shade'}`}>
            <span className="shrink-0 pt-0.5 text-xs tabular-nums text-mute">{formatTimeCode(l.startTime)}</span>
            <span className="text-[15px] leading-snug select-text">{l.text}</span>
          </button>
        ))}
      </div>
    </aside>
  );
};

export default WatchList;
