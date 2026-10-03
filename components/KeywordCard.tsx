import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, Volume2 } from 'lucide-react';
import type { VideoRecord } from '../types';
import { Btn, Card } from './ui';
import { useClip } from './ReviewSession';
import { useT } from '../utils/i18n';
import { canCloze } from '../utils/aiDrills';
import { addWordIfNew, getAllCards, wordCardId } from '../utils/review';
import { keywordLines, keywordsOn, prepareKeywords, readKeywords, type Keyword, type Keywords } from '../utils/keywordPrep';
import { loadWords, playSpan, wordSpans, wordsInLine } from '../utils/wordTimes';

// This episode's keywords (docs/keywords.md): the summary and the words, each opening the line
// it is in with its sound, and "+" into the word cards. Everything the AI wrote is plain text.
// A mouse click drops focus (like Btn), so Enter goes on meaning "start", not "this word again".
// KeywordBlock sits in the practice panel; KeywordModal is the listening page's opening card.

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const letters = (s: string) => s.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length;

const KeywordView: React.FC<{ record: VideoRecord; data: Keywords }> = ({ record, data }) => {
  const t = useT();
  const lines = useMemo(() => keywordLines(record.subtitleText), [record.subtitleText]);
  const [open, setOpen] = useState<number | null>(null);
  const [kept, setKept] = useState<Set<string> | 'error' | null>(null); // word card ids already there; unreadable ≠ none
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<string | null>(null);
  const clip = useClip();
  const playing = useRef(0); // the latest play asked for; an older one still loading word times stays quiet

  useEffect(() => {
    let live = true;
    getAllCards()
      .then(cards => { if (live) setKept(new Set(cards.filter(c => c.deck === 'word' && c.videoId === record.id).map(c => c.id))); })
      .catch(() => { if (live) setKept('error'); });
    return () => { live = false; };
  }, [record.id]);

  const idOf = (k: Keyword) => wordCardId(record.id, k.start, k.word);

  // The word's own stretch: whisper's word times when the line matches them, else by letters.
  const playWord = async (k: Keyword) => {
    const l = lines[k.line];
    const me = ++playing.current;
    if (!record.videoPath || !l) return;
    const pieces = [l.text.slice(0, k.at), k.word, l.text.slice(k.at + k.word.length)];
    const parts = pieces.map((p, i) => ({ p, i })).filter(x => letters(x.p) > 0);
    const spans = wordSpans(parts.map(x => x.p), wordsInLine(await loadWords(record.id), l.startTime, l.endTime));
    const own = parts.findIndex(x => x.i === 1);
    let from: number, to: number;
    if (spans && own >= 0) [from, to] = spans[own];
    else {
      const all = letters(l.text) || 1;
      from = letters(pieces[0]) / all;
      to = (letters(pieces[0]) + letters(k.word)) / all;
    }
    const [a, b] = playSpan(l.startTime, l.endTime, from, to);
    if (me !== playing.current) return;
    clip.play({ path: record.videoPath, offset: 0 }, a, b);
  };
  const playLine = (k: Keyword) => {
    const l = lines[k.line];
    playing.current++;
    if (record.videoPath && l) clip.play({ path: record.videoPath, offset: 0 }, l.startTime, l.endTime);
  };
  const toggle = (i: number) => {
    if (open === i) { setOpen(null); playing.current++; clip.stop(); return; }
    setOpen(i);
    playWord(data.words[i]).catch(() => {});
  };

  const keep = (k: Keyword) => {
    const id = idOf(k), l = lines[k.line];
    if (!(kept instanceof Set) || kept.has(id) || busy.has(id) || !l) return;
    setBusy(b => new Set(b).add(id));
    setFailed(null);
    const definition = `<b>${esc(k.word)}</b><br/>${esc(k.meaning)}${k.note ? `<br/>${esc(k.note)}` : ''}`;
    // The list of kept cards may be stale: one made meanwhile elsewhere is left as it is.
    addWordIfNew({ videoId: record.id, videoName: record.videoFileName, text: l.text, start: l.startTime, end: l.endTime }, k.word, definition)
      .then(() => setKept(s => (s instanceof Set ? new Set(s).add(id) : s)), () => setFailed(id))
      .finally(() => setBusy(b => { const n = new Set(b); n.delete(id); return n; }));
  };

  const cur = open !== null ? data.words[open] : null;
  const curLine = cur ? lines[cur.line] : null;
  return (
    <div className="flex flex-col gap-2.5" data-keywords>
      <p className="text-sm leading-relaxed">{data.summary}</p>
      <div className="flex flex-wrap gap-1.5">
        {data.words.map((k, i) => {
          const id = idOf(k);
          const has = kept instanceof Set && kept.has(id);
          return (
            <span key={id} className={`inline-flex items-center rounded-full border text-[13px] ${open === i ? 'border-accent bg-accent-soft' : 'border-line bg-page'}`}>
              <button type="button" className="pl-2.5 pr-1.5 py-1 text-left" onClick={e => { if (e.detail) e.currentTarget.blur(); toggle(i); }} aria-expanded={open === i}>
                <span className="font-semibold">{k.word}</span>
                {k.meaning && <span className="text-mute"> · {k.meaning}</span>}
              </button>
              <button type="button" className={`pr-2 pl-1 py-1 ${has ? 'text-accent' : 'text-mute hover:text-ink'} disabled:opacity-40`}
                disabled={kept === null || kept === 'error' || has || busy.has(id)}
                title={kept === 'error' ? t('keywords.cardsUnreadable') : t(has ? 'keywords.added' : failed === id ? 'keywords.addFail' : 'keywords.add')}
                aria-label={`${t(has ? 'keywords.added' : 'keywords.add')}: ${k.word}`}
                onClick={e => { if (e.detail) e.currentTarget.blur(); keep(k); }}>
                {has ? <Check size={14} /> : <Plus size={14} />}
              </button>
            </span>
          );
        })}
      </div>
      {kept === 'error' && <span className="text-xs text-mute">{t('keywords.cardsUnreadable')}</span>}
      {failed && <span className="text-xs text-mute">{t('keywords.addFail')}</span>}
      {cur && curLine && (
        <div className="px-3.5 py-3 rounded-[10px] bg-shade flex flex-col gap-2" data-keyword-line>
          <p className="font-serif text-[17px] leading-relaxed">
            {curLine.text.slice(0, cur.at)}
            <b className="text-accent">{curLine.text.slice(cur.at, cur.at + cur.word.length)}</b>
            {curLine.text.slice(cur.at + cur.word.length)}
          </p>
          {cur.note && <p className="text-xs text-mute leading-snug">{cur.note}</p>}
          <div className="flex gap-2">
            <Btn size="sm" onClick={() => { playWord(cur).catch(() => {}); }} disabled={!record.videoPath}><Volume2 size={14} />{t('keywords.playWord')}</Btn>
            <Btn size="sm" onClick={() => playLine(cur)} disabled={!record.videoPath}><Volume2 size={14} />{t('keywords.playLine')}</Btn>
          </div>
        </div>
      )}
      {clip.video('hidden')}
    </div>
  );
};

// In the practice panel: the saved keywords, or made on the spot (and shown when ready).
// Nothing at all when the setting is off, or there are none and no AI to ask.
export const KeywordBlock: React.FC<{ record: VideoRecord }> = ({ record }) => {
  const t = useT();
  const [data, setData] = useState<Keywords | 'wait' | null>(null);
  useEffect(() => {
    if (!keywordsOn()) return;
    let live = true;
    readKeywords(record.id, record.subtitleText).then(saved => {
      if (!live) return;
      if (saved) { setData(saved); return; }
      if (!canCloze()) return;
      setData('wait');
      prepareKeywords(record.id, record.subtitleText, true)
        .then(k => { if (live) setData(k); }, () => { if (live) setData(null); });
    });
    return () => { live = false; };
  }, [record.id, record.subtitleText]);
  if (!data) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-mute">{t('keywords.title')}</span>
      {data === 'wait'
        ? <span className="text-sm text-mute" aria-live="polite">{t('keywords.preparing')}</span>
        : <div className="max-h-[38vh] overflow-y-auto"><KeywordView record={record} data={data} /></div>}
    </div>
  );
};

// The listening page's opening card. Enter / Esc / the button / outside all close it.
export const KeywordModal: React.FC<{ record: VideoRecord; data: Keywords; onClose: () => void }> = ({ record, data, onClose }) => {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' || e.isComposing) return;
      e.stopPropagation();
      if (e.key === 'Escape') onClose();
      // A focused word or "+" answers Enter itself.
      if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && !e.target.disabled && !e.target.dataset.start)) { e.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-lg p-6 flex flex-col gap-4 shadow-lift max-h-[85vh]" role="dialog" aria-modal="true" aria-label={t('keywords.title')} onClick={e => e.stopPropagation()}>
        <div>
          <h3 className="text-xl font-semibold leading-tight">{t('keywords.title')}</h3>
          <p className="mt-1 text-sm text-mute truncate" title={record.displayName}>{record.displayName}</p>
        </div>
        <div className="overflow-y-auto min-h-0"><KeywordView record={record} data={data} /></div>
        <div className="flex items-center justify-end gap-3">
          <span className="text-xs text-mute">{t('keywords.startHint')}</span>
          <Btn tone="accent" onClick={onClose} autoFocus data-start="1">{t('keywords.start')}</Btn>
        </div>
      </Card>
    </div>
  );
};
