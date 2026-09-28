import React, { useMemo } from 'react';
import { Clapperboard, Volume2 } from 'lucide-react';
import type { Subtitle } from '../types';
import { sentenceParts } from '../utils/textTokenizer';
import { lookedKey } from '../utils/readLooked';
import { formatTimeCode } from '../utils/storage';
import { useT } from '../utils/i18n';

// One subtitle line in the reader: its time, its words (each looks up on a click,
// the ones looked up before underlined), furigana over the kanji when on, and on
// hover the line's own buttons — hear it, see it in the small player, its translation.
// Text only — never parsed as HTML; the translation is text too.

const ReaderLine: React.FC<{
  line: Subtitle;
  ja: boolean;
  jaVersion: number; // re-splits when the dictionary or the AI cut points arrive
  kana: boolean;
  looked: Set<string>;
  playing: boolean;
  hasTrans: boolean; // AI set up: the translation button shows
  transOpen: boolean;
  transText: string | null;
  transPending: boolean;
  onWord: (word: string, line: Subtitle) => void;
  onListen: (line: Subtitle) => void;
  onView: (line: Subtitle) => void;
  onTrans: (line: Subtitle) => void;
}> = ({ line, ja, jaVersion, kana, looked, playing, hasTrans, transOpen, transText, transPending, onWord, onListen, onView, onTrans }) => {
  const trans = hasTrans ? { open: transOpen, text: transText, pending: transPending } : null;
  const t = useT();
  const groups = useMemo(() => sentenceParts(line.text).map(g => ({ ...g, key: g.word ? lookedKey(g.word, ja) : null })),
    [line.text, ja, jaVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const icon = 'w-9 h-9 rounded-lg inline-flex items-center justify-center text-mute hover:text-ink hover:bg-line';
  return (
    <div data-line={line.id}
      className={`group grid grid-cols-[52px_minmax(0,1fr)_124px] gap-3 items-start px-3 py-1.5 rounded-xl transition-colors
        ${playing ? 'bg-accent-soft' : 'hover:bg-shade focus-within:bg-shade'}`}>
      <span className={`pt-5 text-xs tabular-nums ${playing ? 'text-accent font-semibold' : 'text-mute'}`}>{formatTimeCode(line.startTime)}</span>
      <div className="min-w-0">
        <p className="font-serif text-2xl leading-[2.2] break-words" data-lookup-line>
          {groups.map((g, gi) => {
            const pieces = g.pieces.map((p, k) => (p.rt && kana ? <ruby key={k}>{p.s}<rt>{p.rt}</rt></ruby> : <React.Fragment key={k}>{p.s}</React.Fragment>));
            if (!g.word) return <span key={gi}>{pieces}</span>;
            const seen = !!g.key && looked.has(g.key);
            return (
              <button key={gi} type="button" onClick={e => { e.currentTarget.blur(); onWord(g.word!, line); }} title={t('common.lookup')}
                className={`inline rounded-md hover:bg-accent-soft ${seen ? 'border-b-2 border-dotted border-accent' : ''}`}>{pieces}</button>
            );
          })}
        </p>
        {trans?.open && (
          <p className="-mt-1 mb-2 text-[15px] leading-relaxed text-mute">
            {trans.text ?? (trans.pending ? t('reader.translating') : t('reader.transFailed'))}
          </p>
        )}
      </div>
      <div className={`pt-3 flex justify-end gap-0.5 ${playing || trans?.open ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
        <button type="button" className={icon} onClick={e => { e.currentTarget.blur(); onListen(line); }} title={t('reader.listen')} aria-label={t('reader.listen')}><Volume2 size={18} /></button>
        <button type="button" className={icon} onClick={e => { e.currentTarget.blur(); onView(line); }} title={t('reader.view')} aria-label={t('reader.view')}><Clapperboard size={18} /></button>
        {trans && (
          <button type="button" onClick={e => { e.currentTarget.blur(); onTrans(line); }} title={t(trans.open ? 'reader.transHide' : 'reader.transShow')} aria-label={t(trans.open ? 'reader.transHide' : 'reader.transShow')}
            aria-pressed={trans.open} className={`${icon} text-[13px] font-semibold ${trans.open ? '!bg-line !text-ink' : ''}`}>{t('reader.transShort')}</button>
        )}
      </div>
    </div>
  );
};

export default React.memo(ReaderLine);
