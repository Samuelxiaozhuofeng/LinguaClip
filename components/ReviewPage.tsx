import React, { useEffect, useMemo, useState } from 'react';
import type { VideoRecord } from '../types';
import { ReviewCard, Deck, getAllCards, subscribeCards, deckCounts, dueQueue, inReview } from '../utils/review';
import { DeckLang, DECK_LANGS, cardLangs, langName } from '../utils/deckLang';
import { getAllVideoRecords } from '../utils/videoStorage';
import { parseSRT } from '../utils/srtParser';
import { buildSections, sectionAt, sectionLengthOf } from '../utils/sections';
import { getLastWay, getWatchPos } from '../utils/storage';
import { ShelfPos, cardFinished, cardWhere, lastWayName, lastWaySec } from '../utils/lastWayCard';
import { Listen } from '@pro';
import { Play } from 'lucide-react';
import { Btn, Seg } from './ui';
import CardsPage from './CardsPage';
import ReviewSession from './ReviewSession';
import { useT, getLang } from '../utils/i18n';

// A library page (sentences, or words): start reviewing what is due, the week ahead, every card below.

export const DAY = 86_400_000;
export const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);
// Local midnight `i` days after `ms`'s day (calendar days, so a DST day of 23/25h still lands on midnight).
export const dayStart = (ms: number, i: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + i); return d.getTime(); };
export const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString(getLang() === 'zh' ? 'zh-CN' : 'en-US', o);

// Every card, kept fresh; null until the first read.
export const useCards = () => {
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  useEffect(() => {
    const load = () => getAllCards().then(setCards).catch(e => { console.error(e); setCards([]); });
    load();
    return subscribeCards(load);
  }, []);
  return cards;
};

// The video records (newest practised first), re-read whenever the cards change (a card can come from a new video).
// null = not read yet, or unreadable: then there's no language switch, rather than every card "Unsorted".
const useRecords = (cards: ReviewCard[] | null) => {
  const [records, setRecords] = useState<VideoRecord[] | null>(null);
  useEffect(() => {
    let live = true;
    getAllVideoRecords().then(r => { if (live) setRecords(r); }).catch(e => { console.error(e); if (live) setRecords(null); });
    return () => { live = false; };
  }, [cards]);
  return records;
};

// The language picked on the library pages, shared by both, kept across launches.
const LANG_KEY = 'linguaclip_deck_lang';
const loadLang = (): DeckLang | 'all' => {
  try { const v = localStorage.getItem(LANG_KEY) as DeckLang | null; return v && DECK_LANGS.includes(v) ? v : 'all'; } catch { return 'all'; }
};

// Combined review hub: start due lines + words in one queue, switch deck tabs with 7-day forecast below.
const ReviewPage: React.FC<{ initialDeck?: Deck; onResume?: (record: VideoRecord) => void }> = ({ initialDeck = 'line', onResume }) => {
  const t = useT();
  const cards = useCards();
  const records = useRecords(cards);
  const [deck, setDeck] = useState<Deck>(initialDeck);
  useEffect(() => { setDeck(initialDeck); }, [initialDeck]);
  const [session, setSession] = useState<{ cards: ReviewCard[]; deck: Deck | 'all' } | null>(null);
  const [picked, setPicked] = useState(loadLang);
  const pickLang = (v: DeckLang | 'all') => {
    setPicked(v);
    try { localStorage.setItem(LANG_KEY, v); } catch { /* storage off: forgotten next launch */ }
  };

  const lead = useMemo(() => {
    if (!records) return undefined;
    const isFinished = (v: VideoRecord) => {
      try {
        const subs = parseSRT(v.subtitleText);
        const way = getLastWay(v.id);
        const customSec = lastWaySec(v.id, way);
        const end = subs[subs.length - 1]?.endTime ?? 0;
        const sections = buildSections(subs, sectionLengthOf(v));
        if (sections.length === 0) return v.completionRate >= 100;
        let pos: ShelfPos;
        if (v.podcast && Listen) {
          pos = { part: sectionAt(sections, getWatchPos(v.id)), parts: sections.length, line: 0, lines: 0, listen: true };
        } else {
          const part = Math.min(Math.max(v.currentSectionIndex, 0), sections.length - 1);
          const lines = sections[part].subtitles.length;
          pos = {
            part, parts: sections.length, line: Math.min(Math.max(v.currentSubtitleIndex, 0), lines), lines,
            ...(customSec !== undefined ? { customSec, customPct: end ? Math.min(100, customSec / end * 100) : 0, watch: way === 'watch', read: way === 'read' } : {}),
          };
        }
        return cardFinished(cardWhere(v, pos, t).pct, pos);
      } catch {
        return v.completionRate >= 100;
      }
    };
    return records.find(r => !r.importJob && !!r.subtitleText && !isFinished(r));
  }, [records, t]);

  const langs = useMemo(() => cards && records ? cardLangs(cards, records) : null, [cards, records]);
  const langOf = (c: ReviewCard) => langs?.get(c.id) ?? cardLangs([c], records ?? []).get(c.id)!;
  const allCards = cards ?? [];
  // Languages across the whole library (lines + words), in a fixed order; shown once there are two.
  const present = DECK_LANGS.filter(l => langs && allCards.some(c => langs.get(c.id) === l));
  // A picked language the library has no cards in (or can't be told apart) shows everything.
  const lang = present.length > 1 && picked !== 'all' && present.includes(picked) ? picked : 'all';
  const all = lang === 'all' ? allCards : allCards.filter(c => langOf(c) === lang);
  const counts = deckCounts(all);
  const totalDue = counts.line.due + counts.word.due;
  const totalAll = counts.line.total + counts.word.total;
  const now = Date.now();

  const startSession = (d: Deck | 'all') => {
    const q = dueQueue(all, d);
    if (q.length) setSession({ cards: q, deck: d });
  };

  // Current tab's cards (with audio) coming up on each of the next 7 days; today includes overdue.
  const week = Array.from({ length: 7 }, (_, i) => {
    const day = dayStart(now, i), end = dayStart(now, i + 1);
    const count = all.filter(c => c.deck === deck && inReview(c) && (i === 0 ? c.fsrs.due < end : c.fsrs.due >= day && c.fsrs.due < end)).length;
    return { label: i === 0 ? t('review.today') : fmt(day, { weekday: 'short' }), n: count };
  });
  const peak = Math.max(1, ...week.map(d => d.n));

  return (
    <div>
      <section className="pt-4 pb-7 border-b border-line">
        <h1 className="text-[34px] font-semibold tracking-[-0.02em] leading-tight">{t('review.title')}</h1>
        <p className="mt-2 text-sm text-mute">{t('review.hubHint')}</p>
        {present.length > 1 && (
          <Seg<DeckLang | 'all'> size="sm" className="mt-5" value={lang} onChange={pickLang} options={[
            { value: 'all', label: t('cards.all') },
            ...present.map(l => ({ value: l, label: <>{langName(l, getLang(), t('deck.unsorted'))} <span className="text-mute tabular-nums">{allCards.filter(c => langs!.get(c.id) === l).length}</span></> })),
          ]} />
        )}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Btn tone="accent" size="lg" disabled={totalDue === 0} onClick={() => startSession('all')}>
            {totalDue === 0 ? t('review.nothingDue') : <><Play size={15} fill="currentColor" /> {t('review.start')} · {totalDue}</>}
          </Btn>
          {counts.line.due > 0 && counts.word.due > 0 && (
            <>
              <Btn size="sm" flat onClick={() => startSession('line')}>{t('review.onlyLines', { n: counts.line.due })}</Btn>
              <Btn size="sm" flat onClick={() => startSession('word')}>{t('review.onlyWords', { n: counts.word.due })}</Btn>
            </>
          )}
          <span className="text-sm text-mute">{t('review.total', { n: totalAll })}</span>
        </div>
      </section>

      <div className="pt-6 pb-2 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <Seg<Deck> value={deck} onChange={setDeck} options={[
          { value: 'line', label: <>{t('review.deckLine')} <span className="text-mute tabular-nums">{counts.line.total}</span></> },
          { value: 'word', label: <>{t('review.deckWord')} <span className="text-mute tabular-nums">{counts.word.total}</span></> },
        ]} />
        {counts[deck].total > 0 && <div className="w-full md:w-[300px]">
          <h3 className="text-xs text-mute mb-2.5">{t('review.week')}</h3>
          <div className="flex items-end gap-2.5 h-[84px]">
            {week.map((d, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1.5" title={String(d.n)}>
                <span className="text-[11px] text-mute tabular-nums">{d.n || ''}</span>
                <span className={`w-full rounded ${i === 0 && d.n ? 'bg-accent' : 'bg-faint'}`} style={{ height: Math.max(3, (d.n / peak) * 44) }} />
                <span className="text-[11px] text-mute whitespace-nowrap">{d.label}</span>
              </div>
            ))}
          </div>
        </div>}
      </div>

      <CardsPage key={deck} deck={deck} cards={cards && all} />

      {session && (
        <ReviewSession
          cards={session.cards}
          deck={session.deck}
          onClose={() => setSession(null)}
          langOf={langs ? langOf : undefined}
          lang={lang}
          resume={onResume && lead ? {
            name: lead.displayName,
            label: t('home.continueMode', { mode: t(lead.podcast && Listen ? 'custom.listen' : lastWayName(lead, getLastWay(lead.id), !!Listen)) }),
            onClick: () => { setSession(null); onResume(lead); },
          } : undefined}
        />
      )}
    </div>
  );
};

export default ReviewPage;
