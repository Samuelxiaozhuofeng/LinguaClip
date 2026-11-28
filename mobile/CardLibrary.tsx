// Full-screen card library subpage on the phone (docs/android-roadmap.md M2.5):
// language deck pill filter (utils/deckLang.ts), sentence/word switch, search by text/word,
// swipe-left or "…" delete with top undo bar (holding clips while undo is offered),
// "unmaster" action for mastered cards, and Android-only bottom AnkiDroid batch export bar.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, Search, Trash2, X } from 'lucide-react';
import {
  getAllCards,
  removeCard,
  restoreCard,
  setMastered,
  subscribeCards,
  type Deck,
  type Removed,
  type ReviewCard,
} from '../utils/review';
import { cardLangs, langName, type DeckLang, type LangSource } from '../utils/deckLang';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { getLang, useT } from '../utils/i18n';
import { Header } from './ui';
import { UndoToast } from './review/UndoToast';
import { AnkiExportBar } from './review/AnkiExportBar';
import { holdCardClips, refillClipsAfterRestore, warmClipsRuntime } from './review/nativeRuntime';
import {
  buildLangPills,
  cardScheduleLabel,
  filterLibraryCards,
  resolveLangFilter,
  stripHtmlPlain,
  type LangFilter,
} from './review/cardFilter';

type Held = Removed & { release: () => void };
type DeleteUndo = { id: string; n: number; gone: Promise<Held | null> };

const SWIPE_REVEAL_PX = 84;
const SWIPE_THRESHOLD_PX = 36;

interface CardRowProps {
  card: ReviewCard;
  swiped: boolean;
  onSwipeChange: (open: boolean) => void;
  onDelete: (card: ReviewCard) => void;
  onMenu: (card: ReviewCard) => void;
  now: number;
}

const CardRow: React.FC<CardRowProps> = ({ card, swiped, onSwipeChange, onDelete, onMenu, now }) => {
  const t = useT();
  const ui = getLang();
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [dragX, setDragX] = useState(0);

  const sched = cardScheduleLabel(card, now);
  const schedText = (() => {
    if (sched.kind === 'noAudio') return t('review.noAudio');
    if (sched.kind === 'mastered') return t('cards.mastered');
    if (sched.kind === 'dueNow') return t('review.dueToday');
    if (sched.kind === 'tomorrow') return t('review.dueTomorrow');
    const dateStr = new Date(sched.dueMs).toLocaleDateString(ui === 'zh' ? 'zh-CN' : 'en-US', { month: 'short', day: 'numeric' });
    return `${dateStr} · ${t('review.dueInDays', { n: sched.days })}`;
  })();

  const onTouchStart = (e: React.TouchEvent) => {
    const pt = e.touches[0];
    if (!pt) return;
    touchStart.current = { x: pt.clientX, y: pt.clientY };
    setDragX(0);
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const start = touchStart.current;
    const pt = e.touches[0];
    if (!start || !pt) return;
    const dx = pt.clientX - start.x;
    const dy = pt.clientY - start.y;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 10) {
      touchStart.current = null;
      setDragX(0);
      return;
    }
    const base = swiped ? -SWIPE_REVEAL_PX : 0;
    setDragX(Math.max(-SWIPE_REVEAL_PX, Math.min(0, base + dx)) - base);
  };
  const onTouchEnd = () => {
    if (!touchStart.current) return;
    const total = (swiped ? -SWIPE_REVEAL_PX : 0) + dragX;
    onSwipeChange(total <= -SWIPE_THRESHOLD_PX);
    touchStart.current = null;
    setDragX(0);
  };

  const offset = (swiped ? -SWIPE_REVEAL_PX : 0) + dragX;
  const revealing = offset < 0;
  const defSummary = card.deck === 'word' ? stripHtmlPlain(card.definition) : '';

  return (
    <li className={`relative overflow-hidden rounded-2xl shadow-card ${revealing ? 'bg-accent' : 'bg-page'}`}>
      {revealing && (
        <div className="absolute inset-y-0 right-0 w-[84px] flex items-center justify-center">
          <button
            type="button"
            onClick={() => onDelete(card)}
            className="w-full h-full min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-white text-[13px] font-medium"
          >
            <Trash2 size={16} />
            <span>{t('review.delete')}</span>
          </button>
        </div>
      )}

      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClick={() => { if (swiped) onSwipeChange(false); }}
        style={{ transform: `translateX(${offset}px)` }}
        className="relative bg-page px-4 py-3.5 flex items-start gap-2 transition-transform duration-150"
      >
        <div className="flex-1 min-w-0 flex flex-col gap-1">
          {card.deck === 'word' ? (
            <>
              <p className="font-serif text-[20px] font-semibold leading-snug text-ink break-words">{card.word}</p>
              {defSummary && <p className="text-[13px] text-ink/80 line-clamp-2">{defSummary}</p>}
              <p className="font-serif text-[14px] text-mute line-clamp-2">{card.text}</p>
            </>
          ) : (
            <p className="font-serif text-[17px] leading-snug text-ink line-clamp-3">{card.text}</p>
          )}
          <div className="pt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
            {card.videoName && <span className="truncate max-w-[180px]">{card.videoName}</span>}
            <span className={sched.kind === 'dueNow' ? 'text-ink font-medium' : undefined}>{schedText}</span>
            {!!card.ankiAt && (
              <span className="px-2 py-0.5 rounded-full bg-shade text-ink text-[11px] font-medium">
                {t('cards.ankiSent')}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          aria-label={t('m.cardActions')}
          onClick={e => { e.stopPropagation(); onMenu(card); }}
          className="shrink-0 -mr-1.5 -mt-1 w-11 h-11 rounded-full text-mute active:bg-shade flex items-center justify-center"
        >
          <MoreHorizontal size={18} />
        </button>
      </div>
    </li>
  );
};

export const CardLibrary: React.FC<{ onBack: () => void }> = ({ onBack }) => {
  const t = useT();
  const ui = getLang();
  const [cards, setCards] = useState<ReviewCard[] | null>(null);
  const [records, setRecords] = useState<LangSource[] | null>(null);
  const [deck, setDeck] = useState<Deck>('line');
  const [pickedLang, setPickedLang] = useState<LangFilter>('all');
  const [query, setQuery] = useState('');
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [menuCard, setMenuCard] = useState<ReviewCard | null>(null);
  const [undo, setUndo] = useState<DeleteUndo | null>(null);
  const undone = useRef(new Set<Promise<Held | null>>());

  useEffect(() => { warmClipsRuntime(); }, []);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getAllCards().then(list => { if (alive) setCards(list); }, e => { console.error(e); if (alive) setCards([]); });
    };
    load();
    const unsub = subscribeCards(load);
    return () => { alive = false; unsub(); };
  }, []);

  useEffect(() => {
    let alive = true;
    getAllVideosFromDB().then(r => { if (alive) setRecords(r); }, e => { console.error(e); if (alive) setRecords([]); });
    return () => { alive = false; };
  }, [cards]);

  const all = cards ?? [];
  const langs = useMemo(() => (cards && records ? cardLangs(cards, records) : null), [cards, records]);
  const lineCount = useMemo(() => all.filter(c => c.deck === 'line').length, [all]);
  const wordCount = useMemo(() => all.filter(c => c.deck === 'word').length, [all]);

  const pills = useMemo(() => buildLangPills(all, langs, deck), [all, langs, deck]);
  const lang = resolveLangFilter(pickedLang, pills);
  const shown = useMemo(
    () => filterLibraryCards(all, { deck, lang, langs, query }),
    [all, deck, lang, langs, query],
  );

  const deleteCard = (c: ReviewCard) => {
    setSwipedId(null);
    setMenuCard(null);
    const gone = removeCard(c.id)
      .then(async r => (r ? { ...r, release: await holdCardClips(r.card) } : null))
      .catch(e => { console.error(e); return null; });
    setUndo(u => ({ id: c.id, n: (u?.n ?? 0) + 1, gone }));
  };

  const handleUndo = () => {
    if (!undo) return;
    const cur = undo;
    undone.current.add(cur.gone);
    void cur.gone.then(c => c && restoreCard(c).then(
      () => { refillClipsAfterRestore().catch(console.error).finally(c.release); },
      e => { c.release(); throw e; },
    )).catch(console.error);
    setUndo(null);
  };

  useEffect(() => {
    if (!undo) return;
    const timerId = window.setTimeout(() => setUndo(null), 6000);
    const gone = undo.gone;
    return () => {
      window.clearTimeout(timerId);
      if (!undone.current.has(gone)) void gone.then(c => c?.release());
    };
  }, [undo]);

  const now = Date.now();

  return (
    <div className="fixed inset-0 bg-paper flex flex-col pt-[env(safe-area-inset-top)]">
      {undo && <UndoToast key={undo.n} message={t('m.cardDeleted')} onUndo={handleUndo} />}

      <div className="shrink-0 flex items-center justify-between pr-5">
        <div className="flex-1 min-w-0">
          <Header title={t('m.cardLib')} onBack={onBack} />
        </div>
        <span className="pt-2 text-[13px] text-mute tabular-nums">{t('m.cardTotal', { n: shown.length })}</span>
      </div>

      <div className="shrink-0 px-4 pb-2 flex flex-col gap-2.5">
        <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-shade" role="tablist">
          {([
            { id: 'line' as Deck, label: t('review.deckLine'), n: lineCount },
            { id: 'word' as Deck, label: t('review.deckWord'), n: wordCount },
          ]).map(tab => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={deck === tab.id}
              onClick={() => { setDeck(tab.id); setSwipedId(null); }}
              className={`min-h-[44px] rounded-[10px] text-[14px] font-medium flex items-center justify-center gap-1.5 ${deck === tab.id ? 'bg-page text-ink shadow-card' : 'text-mute'}`}
            >
              <span>{tab.label}</span>
              <span className="text-[12px] text-mute tabular-nums">{tab.n}</span>
            </button>
          ))}
        </div>

        {pills.length > 1 && (
          <div className="flex gap-1.5 overflow-x-auto pb-0.5" role="radiogroup" aria-label={t('deck.videoLang')}>
            {pills.map(p => {
              const active = p.lang === lang;
              const label = p.lang === 'all' ? t('cards.all') : langName(p.lang, ui, t('deck.unsorted'));
              return (
                <button
                  key={p.lang}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => { setPickedLang(p.lang); setSwipedId(null); }}
                  className={`shrink-0 min-h-[44px] px-3.5 rounded-full text-[13px] flex items-center gap-1.5 ${active ? 'bg-ink text-inverse font-medium' : 'bg-page text-ink shadow-card'}`}
                >
                  <span>{label}</span>
                  <span className={`text-[12px] tabular-nums ${active ? 'text-inverse/75' : 'text-mute'}`}>{p.count}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="relative flex items-center">
          <Search size={16} className="absolute left-3.5 text-mute pointer-events-none" />
          <input
            type="text"
            inputMode="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t('review.search')}
            aria-label={t('review.search')}
            className="w-full h-11 pl-10 pr-11 rounded-xl bg-page border border-line text-[15px] text-ink placeholder:text-mute outline-none focus:border-ink"
          />
          {query && (
            <button
              type="button"
              aria-label={t('m.clearSearch')}
              onClick={() => setQuery('')}
              className="absolute right-0 w-11 h-11 flex items-center justify-center text-mute"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 pt-1 pb-4">
        {cards === null ? (
          <p className="py-10 text-center text-sm text-mute">{t('m.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-mute leading-relaxed">
            {(deck === 'line' ? lineCount : wordCount) > 0
              ? t('cards.noMatch')
              : deck === 'line' ? t('review.emptyLine') : t('review.emptyWord')}
          </p>
        ) : (
          <ul className="flex flex-col gap-2.5">
            {shown.map(c => (
              <CardRow
                key={c.id}
                card={c}
                swiped={swipedId === c.id}
                onSwipeChange={open => setSwipedId(open ? c.id : swipedId === c.id ? null : swipedId)}
                onDelete={deleteCard}
                onMenu={setMenuCard}
                now={now}
              />
            ))}
          </ul>
        )}
      </div>

      <AnkiExportBar cards={shown} />

      {menuCard && (
        <div
          className="fixed inset-0 z-[80] bg-black/40 flex items-end"
          onClick={() => setMenuCard(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('m.cardActions')}
            className="w-full bg-page rounded-t-3xl px-4 pt-4 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-2"
            onClick={e => e.stopPropagation()}
          >
            <p className="px-2 pb-1 text-[13px] text-mute truncate">
              {menuCard.deck === 'word' ? menuCard.word : menuCard.text}
            </p>
            {menuCard.mastered && (
              <button
                type="button"
                onClick={() => {
                  const id = menuCard.id;
                  setMenuCard(null);
                  setMastered(id, false).catch(console.error);
                }}
                className="min-h-[48px] w-full rounded-xl bg-shade text-ink text-[15px] font-medium"
              >
                {t('cards.unmaster')}
              </button>
            )}
            <button
              type="button"
              onClick={() => deleteCard(menuCard)}
              className="min-h-[48px] w-full rounded-xl bg-accent-soft text-accent text-[15px] font-semibold"
            >
              {t('review.delete')}
            </button>
            <button
              type="button"
              onClick={() => setMenuCard(null)}
              className="min-h-[48px] w-full rounded-xl bg-page border border-line text-ink text-[15px]"
            >
              {t('m.cancel')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
