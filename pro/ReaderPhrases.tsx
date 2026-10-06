import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus } from 'lucide-react';
import type { Subtitle, VideoRecord } from '../types';
import type { Mark } from './ReaderLine';
import { useT } from '../utils/i18n';
import { canCloze } from '../utils/aiDrills';
import { addWordIfNew, getAllCards, wordCardId } from '../utils/review';
import { keywordLines } from '../utils/keywordPrep';
import { phrasesOn, preparePhrases, readPhrases, type Phrase } from '../utils/phrasePrep';
import { getWatchPrefs, saveWatchPrefs } from '../utils/storage';

// The reader's "this episode's phrases" (docs/phrases.md): usePhrases loads / makes them and
// works out each line's marks; PhraseCard is the side column's card — one tag per base form,
// a click jumps to its next place, "+" keeps it as a word card. All the AI wrote is plain text.

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

type Place = Phrase & { sub: Subtitle };
type Group = { base: string; places: Place[] };
type State = Group[] | 'wait' | 'fail' | null; // null: off, or no AI and nothing saved

export function usePhrases(record: VideoRecord, lines: Subtitle[]) {
  const [items, setItems] = useState<Phrase[] | 'wait' | 'fail' | null>(null);
  const [active, setActive] = useState<Place | null>(null);
  const [marksOn, setMarksOn] = useState(() => getWatchPrefs().phraseMarks);

  useEffect(() => {
    if (!phrasesOn()) return;
    let live = true;
    readPhrases(record.id, record.subtitleText).then(saved => { // saved: shown at once, no "finding…" first
      if (!live) return;
      if (saved) { setItems(saved.items); return; }
      if (!canCloze()) return;
      setItems('wait');
      preparePhrases(record.id, record.subtitleText)
        .then(p => { if (live) setItems(p ? p.items : 'fail'); }, () => { if (live) setItems('fail'); });
    });
    return () => { live = false; };
  }, [record.id, record.subtitleText]);

  // Line numbers count parseSRT's order; the reader's lines are the same ones, sorted by time.
  const state: State = useMemo(() => {
    if (!Array.isArray(items)) return items;
    const byId = new Map(lines.map(l => [l.id, l]));
    const parsed = keywordLines(record.subtitleText);
    const groups = new Map<string, Group>();
    for (const p of items) {
      const sub = byId.get(parsed[p.line]?.id);
      if (!sub) continue;
      const key = p.base.toLowerCase();
      if (!groups.has(key)) groups.set(key, { base: p.base, places: [] });
      groups.get(key)!.places.push({ ...p, sub });
    }
    const all = [...groups.values()];
    all.forEach(g => g.places.sort((a, b) => a.sub.startTime - b.sub.startTime || a.at - b.at));
    return all.sort((a, b) => a.places[0].sub.startTime - b.places[0].sub.startTime);
  }, [items, lines, record.subtitleText]);

  const marks = useMemo(() => {
    const out = new Map<number, Mark[]>();
    const add = (p: Place, hot: boolean) => {
      const list = out.get(p.sub.id) ?? [];
      list.push({ from: p.at, to: p.at + p.text.length, hot });
      out.set(p.sub.id, list);
    };
    if (marksOn && Array.isArray(state)) state.forEach(g => g.places.forEach(p => { if (p !== active) add(p, false); }));
    if (active) add(active, true);
    return out;
  }, [state, marksOn, active]);

  const setMarks = (on: boolean) => { setMarksOn(on); saveWatchPrefs({ phraseMarks: on }); };
  return { state, active, setActive, marks, marksOn, setMarks };
}

export const PhraseCard: React.FC<{
  record: VideoRecord;
  phrases: ReturnType<typeof usePhrases>;
  onJump: (line: Subtitle) => void;
}> = ({ record, phrases, onJump }) => {
  const t = useT();
  const { state, active, setActive, marksOn, setMarks } = phrases;
  const [kept, setKept] = useState<Set<string> | 'error' | null>(null); // word card ids already there; unreadable ≠ none
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    getAllCards()
      .then(cards => { if (live) setKept(new Set(cards.filter(c => c.deck === 'word' && c.videoId === record.id).map(c => c.id))); })
      .catch(() => { if (live) setKept('error'); });
    return () => { live = false; };
  }, [record.id]);

  const groups = Array.isArray(state) ? state : [];
  const open = active ? groups.find(g => g.places.includes(active)) ?? null : null;
  const nth = open && active ? open.places.indexOf(active) : -1;

  // The meaning opens under the row of the tag picked: after the last tag on that row, so no tag moves.
  // ponytail: worked out when a tag is picked; resizing the window meanwhile may leave it a row off.
  const tagRefs = useRef<(HTMLLIElement | null)[]>([]);
  const detailRef = useRef<HTMLLIElement>(null);
  const openAt = open ? groups.indexOf(open) : -1;
  // Measured with no meaning box on the page (it would push tags to the next row), before it paints.
  const [row, setRow] = useState<{ at: number; end: number }>({ at: -1, end: -1 });
  const rowEnd = row.at === openAt ? row.end : -1;
  useLayoutEffect(() => {
    if (openAt < 0) return;
    const top = tagRefs.current[openAt]?.offsetTop;
    let end = openAt;
    while (end + 1 < groups.length && tagRefs.current[end + 1]?.offsetTop === top) end++;
    setRow({ at: openAt, end });
  }, [openAt, groups.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { detailRef.current?.scrollIntoView({ block: 'nearest' }); }, [rowEnd, active]);

  if (state === null) return null;

  // First click: its first place; again on the same tag: the next, round to the first.
  const pick = (g: Group) => {
    const p = open === g ? g.places[(nth + 1) % g.places.length] : g.places[0];
    setActive(p);
    setFailed(false);
    onJump(p.sub);
  };
  const idOf = (p: Place) => wordCardId(record.id, p.sub.startTime, p.text);
  const has = !!active && kept instanceof Set && kept.has(idOf(active));
  const keep = () => {
    if (!active || !(kept instanceof Set) || has || busy) return;
    const p = active, id = idOf(p);
    setBusy(true);
    setFailed(false);
    const definition = `<b>${esc(p.base)}</b><br/>${esc(p.meaning)}${p.note ? `<br/>${esc(p.note)}` : ''}`;
    addWordIfNew({ videoId: record.id, videoName: record.videoFileName, text: p.sub.text, start: p.sub.startTime, end: p.sub.endTime }, p.text, definition)
      .then(() => setKept(s => (s instanceof Set ? new Set(s).add(id) : s)), () => setFailed(true))
      .finally(() => setBusy(false));
  };

  return (
    <div className="card !shadow-none p-4 min-h-0 flex flex-col" data-phrases>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold">{t('phrases.title')} {groups.length > 0 && <span className="ml-1 text-xs font-normal text-mute">{groups.length}</span>}</span>
        {groups.length > 0 && (
          <label className="flex items-center gap-1.5 text-xs text-mute cursor-pointer">
            <input type="checkbox" checked={marksOn} onChange={e => setMarks(e.target.checked)} className="w-3.5 h-3.5 accent-accent" />{t('phrases.mark')}
          </label>
        )}
      </div>
      {state === 'wait' ? <p className="mt-2 text-[13px] text-mute" aria-live="polite">{t('phrases.preparing')}</p>
        : state === 'fail' ? <p className="mt-2 text-[13px] text-mute">{t('phrases.failed')}</p>
        : groups.length === 0 ? <p className="mt-2 text-[13px] text-mute">{t('phrases.none')}</p>
        : (
          <div className="mt-2.5 min-h-0 overflow-y-auto flex flex-col gap-3">
            <ul className="flex flex-wrap gap-2">
              {groups.map((g, i) => (
                <React.Fragment key={g.base.toLowerCase()}>
                  <li ref={el => { tagRefs.current[i] = el; }}>
                    <button type="button" onClick={e => { if (e.detail) e.currentTarget.blur(); pick(g); }} aria-expanded={open === g}
                      className={`px-3 py-1.5 rounded-full text-[14px] font-medium ${open === g ? 'bg-accent text-white' : 'bg-shade hover:text-accent'}`}>{g.base}</button>
                  </li>
                  {open && active && i === rowEnd && (
                    <li ref={detailRef} className="basis-full p-3 rounded-xl bg-shade flex gap-2.5 items-start">
                      <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
                        <div className="font-semibold">{open.base}{active.meaning && <span> · {active.meaning}</span>}</div>
                        {active.note && <div className="text-mute">{active.note}</div>}
                        {open.places.length > 1 && <div className="mt-1 text-xs text-mute">{t('phrases.nth', { n: nth + 1, total: open.places.length })}</div>}
                        {failed && <div className="mt-1 text-xs text-mute">{t('keywords.addFail')}</div>}
                        {kept === 'error' && <div className="mt-1 text-xs text-mute">{t('keywords.cardsUnreadable')}</div>}
                      </div>
                      <button type="button" onClick={e => { if (e.detail) e.currentTarget.blur(); keep(); }} disabled={kept === null || kept === 'error' || has || busy}
                        title={t(has ? 'keywords.added' : 'keywords.add')} aria-label={`${t(has ? 'keywords.added' : 'keywords.add')}: ${active.text}`}
                        className={`w-8 h-8 shrink-0 rounded-lg border border-line bg-page inline-flex items-center justify-center ${has ? 'text-accent' : 'text-mute hover:text-ink'} disabled:opacity-60`}>
                        {has ? <Check size={16} /> : <Plus size={16} />}
                      </button>
                    </li>
                  )}
                </React.Fragment>
              ))}
            </ul>
          </div>
        )}
    </div>
  );
};
