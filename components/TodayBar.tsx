import React, { useState } from 'react';
import { Play } from 'lucide-react';
import { VideoRecord } from '../types';
import { ReviewCard, dueQueue } from '../utils/review';
import { useDueSnapshot } from '../hooks/useDueSnapshot';
import { DeckLang, cardLangs } from '../utils/deckLang';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { getTodayBar } from '../utils/storage';
import { useT } from '../utils/i18n';
import { Btn } from './ui';
import ReviewSession from './ReviewSession';

// The video home's "Today" bar (docs/stats.md): what is due (starts a review round right here),
// the big card's "continue" (same functions as the card; away when it says "finished"), and something new (the podcast page).
// Reads only; switched off in settings it renders nothing and reads nothing.
const TodayBar: React.FC<{
  lead?: VideoRecord;
  where: (v: VideoRecord) => { text: string };
  mode: (v: VideoRecord) => string;
  onResume: (v: VideoRecord) => void;
  onNew?: () => void;
}> = ({ lead, where, mode, onResume, onNew }) => {
  const t = useT();
  const [on] = useState(getTodayBar);
  // The top bar's snapshot (same cards, same `now`); null = not read yet, or unreadable: no review cell.
  const due = useDueSnapshot(on);
  const [session, setSession] = useState<{ cards: ReviewCard[]; langOf?: (c: ReviewCard) => DeckLang } | null>(null);
  if (!on) return null;

  const start = async () => {
    if (!due) return;
    const { cards } = due;
    const queue = dueQueue(cards, due.line ? 'line' : 'word', due.now);
    // Each card's own language for lookups, as on the library page; unreadable records: guessed per round.
    const records = await getAllVideosFromDB().catch(() => null);
    const langs = records ? cardLangs(cards, records) : null;
    setSession({ cards: queue, langOf: langs ? c => langs.get(c.id) ?? cardLangs([c], records!).get(c.id)! : undefined });
  };
  const what = due && [due.line && t(due.line === 1 ? 'home.reviewLineOne' : 'home.reviewLine', { n: due.line }), due.word && t(due.word === 1 ? 'home.reviewWordOne' : 'home.reviewWord', { n: due.word })].filter(Boolean).join(' · ');

  return (
    <section className="mb-5 flex items-center gap-3 min-w-0" aria-label={t('home.todayLabel')}>
      <span className="shrink-0 text-[13px] font-medium text-mute">{t('home.todayLabel')}</span>
      {what && (
        <Btn tone="accent" onClick={start} className="shrink-0">
          <Play size={14} fill="currentColor" /> {t('home.reviewDue', { what })}
        </Btn>
      )}
      {lead && (
        <Btn onClick={() => onResume(lead)} className="min-w-0" title={lead.displayName}>
          <span className="truncate">{[t('home.todayResume', { mode: t('home.continueMode', { mode: mode(lead) }), name: lead.displayName }), where(lead).text].filter(Boolean).join(' · ')}</span>
        </Btn>
      )}
      {onNew && <Btn onClick={onNew} className="shrink-0">{t('home.todayNew')}</Btn>}
      {session && <ReviewSession cards={session.cards} onClose={() => setSession(null)} langOf={session.langOf} />}
    </section>
  );
};

export default TodayBar;
