import React, { useMemo, useState } from 'react';
import { Search, Trash2, Play, Bookmark } from 'lucide-react';
import { ReviewCard, Deck, deleteCards, hasAudio, isDue, wordIndexIn } from '../utils/review';
import { hasKana } from '../utils/japanese';
import { Btn, Seg, inputCls } from './ui';
import { dialog } from './Dialog';
import { clipOf, useClip } from './ReviewSession';
import { findSource } from '../utils/clips';
import { DAY, startOfDay, fmt } from './ReviewPage';
import { useT } from '../utils/i18n';

// One deck's cards under its library header: searchable and filterable by
// schedule, with listen and delete (one, or a picked batch).

type Status = 'all' | 'due' | 'later' | 'saved' | 'silent';

const plain = (html?: string) => html ? new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '' : '';

const CardsPage: React.FC<{ deck: Deck; cards: ReviewCard[] | null }> = ({ deck, cards }) => {
  const t = useT();
  const [status, setStatus] = useState<Status>('all');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Set<string> | null>(null); // null = not picking
  const clip = useClip();

  const all = cards ?? [];
  const now = Date.now();
  const q = search.trim().toLowerCase();
  const inDeck = all.filter(c => c.deck === deck);
  const list = useMemo(() => inDeck
    .filter(c => status === 'all' || (status === 'saved' ? !!c.saved : status === 'silent' ? !hasAudio(c) : hasAudio(c) && isDue(c, now) === (status === 'due')))
    .filter(c => !q || [c.text, c.word, c.videoName].some(s => s?.toLowerCase().includes(q)))
    .sort((a, b) => Number(hasAudio(b)) - Number(hasAudio(a)) || a.fsrs.due - b.fsrs.due), [all, deck, status, q]); // eslint-disable-line react-hooks/exhaustive-deps

  const when = (c: ReviewCard) => {
    if (!hasAudio(c)) return t('review.noAudio');
    if (c.fsrs.due <= now) return t('review.dueToday');
    const days = Math.round((startOfDay(c.fsrs.due) - startOfDay(now)) / DAY);
    return `${fmt(c.fsrs.due, { month: 'short', day: 'numeric' })} · ${days <= 1 ? t('review.dueTomorrow') : t('review.dueInDays', { n: days })}`;
  };

  const listen = async (c: ReviewCard) => {
    const src = await findSource(c);
    if (!src) return dialog.alert(t('session.missingTitle'));
    clip.play(src, ...clipOf(c));
  };

  const remove = async (c: ReviewCard) => {
    const ok = await dialog.confirm(t('review.removeTitle'), t('review.removeBody'), { ok: t('review.removeOk'), danger: true });
    if (ok) await deleteCards([c.id]).catch(console.error);
  };

  // Only what is still on screen goes, so a filter change never deletes unseen cards.
  const shown = picked ? list.filter(c => picked.has(c.id)) : [];
  const removePicked = async () => {
    const ok = await dialog.confirm(t('cards.removeManyTitle', { n: shown.length }), t(shown.length === 1 ? 'review.removeBody' : 'cards.removeManyBody'), { ok: t('review.removeOk'), danger: true });
    if (!ok) return;
    await deleteCards(shown.map(c => c.id)).catch(console.error);
    setPicked(null);
  };
  const toggle = (id: string) => setPicked(p => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const allPicked = list.length > 0 && shown.length === list.length;

  const text = (c: ReviewCard) => {
    if (c.deck !== 'word' || !c.word) return c.text;
    // Japanese has no spaces: mark the word where it sits in the line.
    const at = hasKana(c.text) ? c.text.indexOf(c.word) : -1;
    if (at >= 0) return <>{c.text.slice(0, at)}<b className="text-ink font-semibold">{c.word}</b>{c.text.slice(at + c.word.length)}</>;
    const parts = c.text.split(/\s+/);
    const wi = wordIndexIn(parts, c.word);
    return parts.map((p, i) => (
      <React.Fragment key={i}>{i > 0 && ' '}{i === wi && p.toLowerCase().includes(c.word!.toLowerCase()) ? <b className="text-ink font-semibold">{p}</b> : p}</React.Fragment>
    ));
  };

  const sub = (c: ReviewCard) => c.fsrs.reps > 0 ? `${t('review.reps', { n: c.fsrs.reps })}${c.fsrs.lapses > 0 ? ` · ${t('review.lapses', { n: c.fsrs.lapses })}` : ''}` : undefined;
  const due = (c: ReviewCard) => hasAudio(c) && c.fsrs.due <= now;

  return (
    <div>
      {inDeck.length > 0 && <div className="pt-6 pb-2 flex items-center gap-2 min-h-[52px]">
        <Seg<Status> size="sm" value={status} onChange={setStatus} options={[
          { value: 'all', label: t('cards.all') },
          { value: 'due', label: t('cards.due') },
          { value: 'later', label: t('cards.later') },
          ...(deck === 'line' ? [{ value: 'saved' as Status, label: t('review.saved') }] : []),
          { value: 'silent', label: t('cards.silent') },
        ]} />
        <span className="ml-auto flex items-center gap-2 text-sm text-mute">
          {picked ? (
            <>
              <span>{t('cards.picked', { n: shown.length })}</span>
              <Btn size="sm" flat onClick={() => setPicked(allPicked ? new Set() : new Set(list.map(c => c.id)))}>{allPicked ? t('cards.pickNone') : t('cards.pickAll')}</Btn>
              <Btn size="sm" tone="accent" disabled={shown.length === 0} onClick={() => { removePicked().catch(console.error); }}>{t('review.removeOk')}</Btn>
              <Btn size="sm" flat onClick={() => setPicked(null)}>{t('dialog.cancel')}</Btn>
            </>
          ) : (
            <>
              <span className="relative w-56">
                <span className="absolute inset-y-0 left-3 flex items-center text-mute pointer-events-none"><Search size={14} /></span>
                <input type="text" placeholder={t('review.search')} value={search} onChange={e => setSearch(e.target.value)} className={`${inputCls} !h-8 !rounded-full pl-9`} />
              </span>
              {list.length > 0 && <Btn size="sm" flat onClick={() => setPicked(new Set())}>{t('cards.pick')}</Btn>}
            </>
          )}
        </span>
      </div>}

      {cards !== null && list.length === 0 ? (
        <p className="py-8 text-sm text-mute">{inDeck.length ? t('cards.noMatch') : deck === 'line' ? t('review.emptyLine') : t('review.emptyWord')}</p>
      ) : (
        <ul>
          {list.map(c => (
            <li key={c.id} className={`group min-h-[60px] py-2.5 flex items-center gap-4 border-b border-line ${picked ? 'cursor-pointer' : ''}`} onClick={picked ? () => toggle(c.id) : undefined}>
              {picked ? (
                <input type="checkbox" checked={picked.has(c.id)} onChange={() => toggle(c.id)} onClick={e => e.stopPropagation()} aria-label={t('cards.pick')} className="w-4 h-4 mx-2 shrink-0 accent-accent" />
              ) : (
                <button type="button" disabled={!hasAudio(c)} onClick={() => { listen(c).catch(console.error); }} title={t('review.play')} aria-label={t('review.play')}
                  className="press shrink-0 w-8 h-8 rounded-full bg-shade text-ink group-hover:bg-accent group-hover:text-white disabled:group-hover:bg-shade disabled:group-hover:text-ink flex items-center justify-center">
                  <Play size={12} fill="currentColor" className="ml-0.5" />
                </button>
              )}
              {c.deck === 'word' ? (
                <>
                  <span className="w-44 shrink-0 font-serif text-[22px] leading-snug break-words">{c.word}</span>
                  <span className="w-56 shrink-0 text-sm line-clamp-2">{plain(c.definition)}</span>
                  <span className="flex-1 min-w-0 font-serif text-[15px] text-mute truncate">{text(c)}</span>
                </>
              ) : (
                <>
                  <span className="flex-1 min-w-0 font-serif text-lg leading-snug line-clamp-2">{c.text}</span>
                  <span className="w-52 shrink-0 text-xs text-mute truncate" title={c.videoName}>{c.videoName}</span>
                  <span className="w-4 shrink-0 text-ink" title={c.saved ? t('review.saved') : undefined}>{c.saved && <Bookmark size={14} fill="currentColor" />}</span>
                </>
              )}
              <span className={`w-24 shrink-0 text-right text-[13px] ${due(c) ? 'text-ink font-medium' : 'text-mute'}`} title={sub(c)}>{when(c)}</span>
              {!picked && (
                <Btn square size="sm" flat onClick={() => { remove(c).catch(console.error); }} title={t('review.remove')} aria-label={t('review.remove')}
                  className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"><Trash2 size={15} /></Btn>
              )}
            </li>
          ))}
        </ul>
      )}

      {clip.video('hidden')}
    </div>
  );
};

export default CardsPage;
