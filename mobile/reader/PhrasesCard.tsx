// Collapsible "This episode's phrases" card + hook for the phone's Read page (docs/phrases.md, M2.3).
// Follows the desktop setting phrasesOn() (linguaclip_ai_config.autoPhrases === true).
// Reuses utils/phrasePrep.ts (<id>.phrases.json): tapping a phrase jumps to its line & highlights it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import { canCloze } from '../../utils/aiDrills';
import { useT } from '../../utils/i18n';
import { keywordLines } from '../../utils/keywordPrep';
import { phrasesOn, preparePhrases, readPhrases, type Phrase } from '../../utils/phrasePrep';
import { addWordIfNew, getAllCards, wordCardId } from '../../utils/review';
import { getWatchPrefs, saveWatchPrefs } from '../../utils/storage';
import type { TextMark } from './phrasePick';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

export type PhrasePlace = Phrase & { sub: Subtitle };
export type PhraseGroup = { base: string; places: PhrasePlace[] };
export type PhrasesState = PhraseGroup[] | 'wait' | 'fail' | null;

export function useReaderPhrases(record: VideoRecord, lines: Subtitle[]) {
  const [items, setItems] = useState<Phrase[] | 'wait' | 'fail' | null>(null);
  const [active, setActive] = useState<PhrasePlace | null>(null);
  const [marksOn, setMarksOn] = useState(() => getWatchPrefs().phraseMarks);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setItems(null);
    setActive(null);
    if (!phrasesOn()) return;
    let live = true;
    readPhrases(record.id, record.subtitleText).then(saved => {
      if (!live) return;
      if (saved) { setItems(saved.items); return; }
      if (!canCloze()) return;
      setItems('wait');
      preparePhrases(record.id, record.subtitleText)
        .then(p => { if (live) setItems(p ? p.items : 'fail'); }, () => { if (live) setItems('fail'); });
    }, () => { if (live) setItems('fail'); });
    return () => { live = false; };
  }, [record.id, record.subtitleText, attempt]);

  const state: PhrasesState = useMemo(() => {
    if (!Array.isArray(items)) return items;
    const byId = new Map(lines.map(l => [l.id, l]));
    const parsed = keywordLines(record.subtitleText);
    const groups = new Map<string, PhraseGroup>();
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
    const out = new Map<number, TextMark[]>();
    const add = (p: PhrasePlace, hot: boolean) => {
      const list = out.get(p.sub.id) ?? [];
      list.push({ from: p.at, to: p.at + p.text.length, hot });
      out.set(p.sub.id, list);
    };
    if (marksOn && Array.isArray(state)) {
      state.forEach(g => g.places.forEach(p => { if (p !== active) add(p, false); }));
    }
    if (active) add(active, true);
    return out;
  }, [state, marksOn, active]);

  const setMarks = useCallback((on: boolean) => {
    setMarksOn(on);
    saveWatchPrefs({ phraseMarks: on });
  }, []);

  const retry = useCallback(() => setAttempt(n => n + 1), []);

  return { state, active, setActive, marks, marksOn, setMarks, retry };
}

export const PhrasesCard: React.FC<{
  record: VideoRecord;
  phrases: ReturnType<typeof useReaderPhrases>;
  onJump: (line: Subtitle) => void;
}> = ({ record, phrases, onJump }) => {
  const t = useT();
  const { state, active, setActive, marksOn, setMarks, retry } = phrases;
  const [expanded, setExpanded] = useState(false);
  const [kept, setKept] = useState<Set<string> | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    if (!expanded || !Array.isArray(state)) return;
    let live = true;
    getAllCards()
      .then(cards => {
        if (live) setKept(new Set(cards.filter(c => c.deck === 'word' && c.videoId === record.id).map(c => c.id)));
      })
      .catch(() => { if (live) setKept('error'); });
    return () => { live = false; };
  }, [expanded, state, record.id]);

  if (state === null) return null;

  const groups = Array.isArray(state) ? state : [];
  const open = active ? groups.find(g => g.places.includes(active)) ?? null : null;
  const nth = open && active ? open.places.indexOf(active) : -1;

  const pick = (g: PhraseGroup) => {
    const next = open === g ? g.places[(nth + 1) % g.places.length] : g.places[0];
    setActive(next);
    setFailed(false);
    onJump(next.sub);
  };

  const idOf = (p: PhrasePlace) => wordCardId(record.id, p.sub.startTime, p.text);
  const has = !!active && kept instanceof Set && kept.has(idOf(active));

  const keep = () => {
    if (!active || !(kept instanceof Set) || has || busy) return;
    const p = active;
    const id = idOf(p);
    setBusy(true);
    setFailed(false);
    const definition = `<b>${esc(p.base)}</b><br/>${esc(p.meaning)}${p.note ? `<br/>${esc(p.note)}` : ''}`;
    addWordIfNew(
      { videoId: record.id, videoName: record.videoFileName, text: p.sub.text, start: p.sub.startTime, end: p.sub.endTime },
      p.text,
      definition,
    )
      .then(() => { if (aliveRef.current) setKept(s => (s instanceof Set ? new Set(s).add(id) : s)); })
      .catch(e => { console.error(e); if (aliveRef.current) setFailed(true); })
      .finally(() => { if (aliveRef.current) setBusy(false); });
  };

  const title = state === 'wait'
    ? t('m.phrasesCardLoading')
    : Array.isArray(state) && state.length > 0
      ? t('m.phrasesCardTitle', { n: state.length })
      : t('m.phrasesCardEmpty');

  return (
    <section data-testid="reader-phrases-card" className="shrink-0 bg-page rounded-2xl shadow-card overflow-hidden">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="w-full min-h-[48px] px-4 py-2.5 flex items-center justify-between gap-2 text-left"
      >
        <span className="text-[14px] font-semibold text-ink">{title}</span>
        <span aria-hidden className="text-xs text-mute shrink-0">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-3 border-t border-shade flex flex-col gap-3">
          {state === 'wait' ? (
            <p className="text-[13px] text-mute" aria-live="polite">{t('phrases.preparing')}</p>
          ) : state === 'fail' ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-[13px] text-mute">{t('phrases.failed')}</p>
              <button
                type="button"
                onClick={retry}
                className="min-h-[44px] px-3.5 rounded-[10px] bg-shade text-xs font-medium text-ink shrink-0"
              >
                {t('m.phrasesRetry')}
              </button>
            </div>
          ) : groups.length === 0 ? (
            <p className="text-[13px] text-mute">{t('phrases.none')}</p>
          ) : (
            <>
              <label className="min-h-[44px] flex items-center justify-between gap-2 text-xs text-mute">
                <span>{t('phrases.mark')}</span>
                <input
                  type="checkbox"
                  checked={marksOn}
                  onChange={e => setMarks(e.target.checked)}
                  className="w-5 h-5 accent-accent"
                />
              </label>

              <div className="flex flex-wrap gap-2">
                {groups.map(g => {
                  const selected = open === g;
                  return (
                    <button
                      key={g.base.toLowerCase()}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => pick(g)}
                      className={`min-h-[44px] px-3.5 rounded-full text-[13px] font-medium ${
                        selected ? 'bg-accent text-white' : 'bg-shade text-ink'
                      }`}
                    >
                      {g.base}
                    </button>
                  );
                })}
              </div>

              {open && active && (
                <div className="rounded-xl bg-shade px-3.5 py-3 flex items-start gap-2.5">
                  <div className="flex-1 min-w-0 text-[13px] leading-relaxed">
                    <div className="font-semibold text-ink">
                      {open.base}
                      {active.meaning && <span className="font-normal"> · {active.meaning}</span>}
                    </div>
                    {active.note && <div className="text-mute mt-0.5">{active.note}</div>}
                    {open.places.length > 1 && (
                      <div className="text-xs text-mute mt-1">
                        {t('phrases.nth', { n: nth + 1, total: open.places.length })}
                      </div>
                    )}
                    {failed && <div className="text-xs text-accent mt-1">{t('keywords.addFail')}</div>}
                    {kept === 'error' && <div className="text-xs text-mute mt-1">{t('keywords.cardsUnreadable')}</div>}
                  </div>
                  <button
                    type="button"
                    onClick={keep}
                    disabled={kept === null || kept === 'error' || has || busy}
                    aria-label={`${t(has ? 'keywords.added' : 'keywords.add')}: ${active.text}`}
                    className={`w-11 h-11 shrink-0 rounded-[10px] border border-line bg-page inline-flex items-center justify-center text-lg disabled:opacity-50 ${
                      has ? 'text-accent font-semibold' : 'text-ink'
                    }`}
                  >
                    {has ? '✓' : '＋'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
};
