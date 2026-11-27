import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { VideoRecord } from '../types';
import { ReviewCard, dueQueue, inReview } from '../utils/review';
import { useDueSnapshot } from '../hooks/useDueSnapshot';
import { DeckLang, cardLangs } from '../utils/deckLang';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { getTodayBar } from '../utils/storage';
import { useT } from '../utils/i18n';
import { Btn } from './ui';
import ReviewSession from './ReviewSession';

// The Learn home's "Today" bar (docs/stats.md): combined due review (lines first, then words),
// or a quiet "all done" note once every review card is caught up. Hidden when there are no reviewable cards.
// Reads only; switched off in settings it reads nothing (still renders `right`, e.g. the shelf filter).
const TodayBar: React.FC<{
  lead?: VideoRecord;
  mode: (v: VideoRecord) => string;
  onResume: (v: VideoRecord) => void;
  right?: React.ReactNode;
}> = ({ lead, mode, onResume, right }) => {
  const t = useT();
  const [on] = useState(getTodayBar);
  // The top bar's snapshot (same cards, same `now`); null = not read yet, or unreadable: no review cell.
  const due = useDueSnapshot(on);
  const [session, setSession] = useState<{ cards: ReviewCard[]; langOf?: (c: ReviewCard) => DeckLang } | null>(null);

  const start = async () => {
    if (!due) return;
    const { cards } = due;
    const queue = dueQueue(cards, 'all', due.now);
    // Each card's own language for lookups, as on the library page; unreadable records: guessed per round.
    const records = await getAllVideosFromDB().catch(() => null);
    const langs = records ? cardLangs(cards, records) : null;
    setSession({ cards: queue, langOf: langs ? c => langs.get(c.id) ?? cardLangs([c], records!).get(c.id)! : undefined });
  };
  const what = on && due ? [due.line && t(due.line === 1 ? 'home.reviewLineOne' : 'home.reviewLine', { n: due.line }), due.word && t(due.word === 1 ? 'home.reviewWordOne' : 'home.reviewWord', { n: due.word })].filter(Boolean).join(' · ') : '';
  const showBar = on && !!due && (!!what || due.cards.some(inReview));
  if (!showBar && !right && !session) return null;

  const resume = lead ? {
    name: lead.displayName,
    label: t('home.continueMode', { mode: mode(lead) }),
    onClick: () => { setSession(null); onResume(lead); },
  } : undefined;

  return (
    <>
      {(showBar || right) && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 min-w-0">
          {showBar && (
            <section className="flex items-center gap-3 min-w-0" aria-label={t('home.todayLabel')}>
              <span className="shrink-0 text-[13px] font-medium text-mute">{t('home.todayLabel')}</span>
              {what ? (
                <Btn tone="accent" onClick={start} className="shrink-0">
                  <Play size={14} fill="currentColor" /> {t('home.reviewDue', { what })}
                </Btn>
              ) : (
                <span className="text-[13px] text-mute">· {t('home.todayAllDone')}</span>
              )}
            </section>
          )}
          {right}
        </div>
      )}
      {session && <ReviewSession cards={session.cards} deck="all" resume={resume} onClose={() => setSession(null)} langOf={session.langOf} />}
    </>
  );
};

export default TodayBar;
