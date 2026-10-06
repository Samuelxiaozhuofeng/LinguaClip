import React, { useMemo } from 'react';
import { Clapperboard, Star, Volume2 } from 'lucide-react';
import type { Subtitle } from '../types';
import { sentenceParts } from '../utils/textTokenizer';
import { lookedKey } from '../utils/readLooked';
import { formatTimeCode } from '../utils/storage';
import { useT } from '../utils/i18n';
import { usePhraseDrag } from '../hooks/usePhraseDrag';

// One subtitle line in the reader: its time, its words (each looks up on a click,
// the ones looked up before underlined), furigana over the kanji when on, and on
// hover the line's own buttons — hear it, see it in the small player, its translation,
// save it (a saved line's star stays lit). The listening page (ListenPage) makes the time
// a "play from here" and drops the picture button (there is no picture).
// Text only — never parsed as HTML; the translation is text too.
// marks (the reader's phrases, docs/phrases.md): stretches of the text underlined, or red when hot.

export type Mark = { from: number; to: number; hot: boolean };

const ReaderLine: React.FC<{
  line: Subtitle;
  ja: boolean;
  jaVersion: number; // re-splits when the dictionary or the AI cut points arrive
  kana: boolean;
  looked: Set<string>;
  playing: boolean;
  saved: boolean;
  hasTrans: boolean; // AI set up: the translation button shows
  transOpen: boolean;
  transText: string | null;
  transPending: boolean;
  onWord: (word: string, line: Subtitle) => void;
  onListen: (line: Subtitle) => void;
  onView: (line: Subtitle) => void;
  onTrans: (line: Subtitle) => void;
  onSave: (line: Subtitle) => void;
  onPick?: (line: Subtitle) => void;
  marks?: Mark[];
}> = ({ line, ja, jaVersion, kana, looked, playing, saved, hasTrans, transOpen, transText, transPending, onWord, onListen, onView, onTrans, onSave, onPick, marks }) => {
  const trans = hasTrans ? { open: transOpen, text: transText, pending: transPending } : null;
  const t = useT();
  const groups = useMemo(() => {
    let at = 0;
    return sentenceParts(line.text).map(g => {
      const from = at;
      at += g.pieces.reduce((n, p) => n + p.s.length, 0);
      return { ...g, key: g.word ? lookedKey(g.word, ja) : null, from, to: at };
    });
  }, [line.text, ja, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  // A mark's own characters only: a run of Chinese is one group, the phrase may be part of it.
  const markOf = (from: number, to: number) => {
    const m = marks?.filter(k => k.from < to && k.to > from);
    return !m?.length ? '' : m.some(k => k.hot) ? 'text-accent font-semibold' : 'underline decoration-2 underline-offset-[6px] decoration-ink';
  };
  const cuts = marks?.flatMap(m => [m.from, m.to]) ?? [];
  const piecesOf = (g: (typeof groups)[number]) => {
    let at = g.from;
    return g.pieces.map((p, k) => {
      const from = at;
      at += p.s.length;
      if (p.rt && kana) return <ruby key={k} className={markOf(from, at)}>{p.s}<rt>{p.rt}</rt></ruby>;
      const edges = [from, ...cuts.filter(c => c > from && c < at).sort((a, b) => a - b), at];
      return edges.slice(1).map((b, j) => {
        const a = edges[j], c = markOf(a, b), text = p.s.slice(a - from, b - from);
        return c ? <span key={`${k}.${j}`} className={c}>{text}</span> : <React.Fragment key={`${k}.${j}`}>{text}</React.Fragment>;
      });
    });
  };
  const { bind, inSel } = usePhraseDrag((a, b) => onWord(groups.slice(a, b + 1).flatMap(g => g.pieces.map(p => p.s)).join(''), line));
  const icon = 'w-9 h-9 rounded-lg inline-flex items-center justify-center text-mute hover:text-ink hover:bg-line';
  return (
    <div data-line={line.id} data-playing={playing || undefined}
      className={`group grid grid-cols-[52px_minmax(0,1fr)_162px] gap-3 items-start px-3 py-1.5 rounded-xl transition-colors
        ${playing || marks?.some(m => m.hot) ? 'bg-accent-soft' : 'hover:bg-shade focus-within:bg-shade'}`}>
      {onPick
        ? <button type="button" onClick={e => { e.currentTarget.blur(); onPick(line); }} title={t('listen.playFrom')}
            className={`pt-5 self-stretch text-left text-xs tabular-nums hover:text-accent ${playing ? 'text-accent font-semibold' : 'text-mute'}`}>{formatTimeCode(line.startTime)}</button>
        : <span className={`pt-5 text-xs tabular-nums ${playing ? 'text-accent font-semibold' : 'text-mute'}`}>{formatTimeCode(line.startTime)}</span>}
      <div className="min-w-0">
        <p className="font-serif text-2xl leading-[2.2] break-words" data-lookup-line>
          {groups.map((g, gi) => {
            const pieces = piecesOf(g);
            if (!g.word) return <span key={gi}>{pieces}</span>;
            const seen = !!g.key && looked.has(g.key);
            return (
              <button key={gi} type="button" {...bind(gi)} onClick={e => { e.currentTarget.blur(); onWord(g.word!, line); }} title={t('common.lookup')}
                className={`inline rounded-md hover:bg-accent-soft ${inSel(gi) ? 'bg-accent-soft' : ''} ${seen ? 'border-b-2 border-dotted border-accent' : ''}`}>{pieces}</button>
            );
          })}
        </p>
        {trans?.open && (
          <p className="-mt-1 mb-2 text-[15px] leading-relaxed text-mute">
            {trans.text ?? (trans.pending ? t('reader.translating') : t('reader.transFailed'))}
          </p>
        )}
      </div>
      <div className="pt-3 flex justify-end gap-0.5">
        <div className={`flex gap-0.5 ${playing || trans?.open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
        <button type="button" className={icon} onClick={e => { e.currentTarget.blur(); onListen(line); }} title={t('reader.listen')} aria-label={t('reader.listen')}><Volume2 size={18} /></button>
        {!onPick && <button type="button" className={icon} onClick={e => { e.currentTarget.blur(); onView(line); }} title={t('reader.view')} aria-label={t('reader.view')}><Clapperboard size={18} /></button>}
        {trans && (
          <button type="button" onClick={e => { e.currentTarget.blur(); onTrans(line); }} title={t(trans.open ? 'reader.transHide' : 'reader.transShow')} aria-label={t(trans.open ? 'reader.transHide' : 'reader.transShow')}
            aria-pressed={trans.open} className={`${icon} text-[13px] font-semibold ${trans.open ? '!bg-line !text-ink' : ''}`}>{t('reader.transShort')}</button>
        )}
        </div>
        <button type="button" onClick={e => { e.currentTarget.blur(); onSave(line); }} title={t(saved ? 'reader.unsave' : 'reader.save')} aria-label={t('reader.save')} aria-pressed={saved}
          className={`${icon} ${saved ? '!text-accent' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}><Star size={18} fill={saved ? 'currentColor' : 'none'} /></button>
      </div>
    </div>
  );
};

export default React.memo(ReaderLine);
