// Pure logic for phone review & card library (docs/android-roadmap.md M2.5, docs/review.md):
// language deck pills, search/filter/sort, queue deletion, defer checks, AnkiDroid state & summary.
import { DECK_LANGS, type DeckLang } from '../../utils/deckLang';
import { hasAudio, isDue, type Deck, type ReviewCard } from '../../utils/review';
import type { ExportResult } from '../../utils/ankiExport';
import type { AnkiDroidStatus } from '../platform/ankiDroid';

export type LangFilter = DeckLang | 'all';

export interface LangPill {
  lang: LangFilter;
  count: number;
}

export interface LibraryFilter {
  deck: Deck;
  lang: LangFilter;
  langs: Map<string, DeckLang> | null;
  query: string;
}

export type AnkiSetupState = 'loading' | 'not_installed' | 'no_permission' | 'not_initialized' | 'ready';

// Language pills for the active deck: "All" + present languages in DECK_LANGS order (including 'other').
export function buildLangPills(
  cards: ReviewCard[],
  langs: Map<string, DeckLang> | null,
  deck: Deck,
): LangPill[] {
  const inDeck = cards.filter(c => c.deck === deck);
  const pills: LangPill[] = [{ lang: 'all', count: inDeck.length }];
  if (!langs || inDeck.length === 0) return pills;
  for (const l of DECK_LANGS) {
    const count = inDeck.filter(c => langs.get(c.id) === l).length;
    if (count > 0) pills.push({ lang: l, count });
  }
  return pills;
}

// Effective language filter: falls back to 'all' if the picked language has no cards in the current deck.
export function resolveLangFilter(picked: LangFilter, pills: LangPill[]): LangFilter {
  if (picked === 'all') return 'all';
  return pills.some(p => p.lang === picked && p.count > 0) ? picked : 'all';
}

// Filter and sort cards for the phone card library.
export function filterLibraryCards(cards: ReviewCard[], filter: LibraryFilter): ReviewCard[] {
  const q = filter.query.trim().toLowerCase();
  return cards
    .filter(c => c.deck === filter.deck)
    .filter(c => filter.lang === 'all' || !filter.langs || filter.langs.get(c.id) === filter.lang)
    .filter(c => !q || [c.text, c.word, c.videoName].some(s => s?.toLowerCase().includes(q)))
    .sort((a, b) => Number(hasAudio(b)) - Number(hasAudio(a)) || a.fsrs.due - b.fsrs.due);
}

export function unsentAnkiCount(cards: ReviewCard[]): number {
  return cards.filter(c => !c.ankiAt).length;
}

// Removes later in-round "Again" repeats of the deleted card while preserving indices <= idx.
export function removeCardFromQueue(queue: ReviewCard[], idx: number, cardId: string): ReviewCard[] {
  return queue.filter((c, i) => i <= idx || c.id !== cardId);
}

// Whether leaving the current card without grading should defer it to the back of the next queue.
export function shouldDeferCard(card: ReviewCard | undefined, done: boolean, repeats: ReadonlySet<string>): boolean {
  return !!card && !done && !repeats.has(card.id);
}

// Count unique cards finished this round, excluding deleted cards (docs/review.md).
export function finishedCardCount(queue: ReviewCard[], removedIds: ReadonlySet<string>): number {
  return new Set(queue.map(c => c.id).filter(id => !removedIds.has(id))).size;
}

export function classifyAnkiStatus(status: AnkiDroidStatus | null): AnkiSetupState {
  if (!status) return 'loading';
  if (!status.installed) return 'not_installed';
  if (!status.permitted) return 'no_permission';
  if (!status.apiAvailable) return 'not_initialized';
  return 'ready';
}

export interface ExportSummaryLines {
  headlineKey: 'm.ankiSentSummary' | 'm.ankiSentNone';
  sentCount: number;
  notes: { key: 'm.ankiNoteSkipped' | 'm.ankiNoteSilent' | 'm.ankiNoteRefused' | 'm.ankiNoteUnmarked'; n: number }[];
  stopped?: { key: 'm.ankiStoppedAnki' | 'm.ankiStoppedTool' | 'm.ankiStoppedRead'; err?: string };
}

export function buildExportSummary(r: ExportResult): ExportSummaryLines {
  const notes: ExportSummaryLines['notes'] = [];
  if (r.skipped > 0) notes.push({ key: 'm.ankiNoteSkipped', n: r.skipped });
  if (r.silent > 0) notes.push({ key: 'm.ankiNoteSilent', n: r.silent });
  if (r.refused > 0) notes.push({ key: 'm.ankiNoteRefused', n: r.refused });
  if (r.unmarked > 0) notes.push({ key: 'm.ankiNoteUnmarked', n: r.unmarked });
  let stopped: ExportSummaryLines['stopped'];
  if (r.stopped) {
    if (r.stopped.why === 'anki') stopped = { key: 'm.ankiStoppedAnki' };
    else if (r.stopped.why === 'read') stopped = { key: 'm.ankiStoppedRead' };
    else stopped = { key: 'm.ankiStoppedTool', err: r.stopped.error };
  }
  return {
    headlineKey: r.sent.length > 0 ? 'm.ankiSentSummary' : 'm.ankiSentNone',
    sentCount: r.sent.length,
    notes,
    stopped,
  };
}

const DAY_MS = 86_400_000;
const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

export type ScheduleLabel =
  | { kind: 'noAudio' }
  | { kind: 'mastered' }
  | { kind: 'dueNow' }
  | { kind: 'tomorrow' }
  | { kind: 'inDays'; days: number; dueMs: number };

export function cardScheduleLabel(c: ReviewCard, now = Date.now()): ScheduleLabel {
  if (!hasAudio(c)) return { kind: 'noAudio' };
  if (c.mastered) return { kind: 'mastered' };
  if (isDue(c, now)) return { kind: 'dueNow' };
  const days = Math.max(1, Math.round((startOfDay(c.fsrs.due) - startOfDay(now)) / DAY_MS));
  if (days <= 1) return { kind: 'tomorrow' };
  return { kind: 'inDays', days, dueMs: c.fsrs.due };
}

export function stripHtmlPlain(html?: string): string {
  if (!html) return '';
  if (typeof DOMParser !== 'undefined') {
    return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';
  }
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
