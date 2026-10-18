// Sends a batch of library cards to Anki (docs/anki-export.md): cuts each card's sound from its source, adds the note, marks it sent.
import { addNote, getAnkiConfig, invokeAnki, withAiBlock } from './anki';
import { clean } from './cleanHtml';
import { cardLangs, type LangSource } from './deckLang';
import { getAllVideosFromDB } from './fileSystemAccess';
import { clipKey, findSource } from './clips';
import { cutClip } from './desktop';
import { formatTimeCode, getAudioPaddingConfig, getWordVoice } from './storage';
import { wordVoiceB64 } from './wordVoice';
import { getAllCards, getCard, hasAudio, markAnkiSent, type ReviewCard } from './review';
import { readClipB64 as readB64, wordClipB64 } from './wordAudio';
import { loadWords } from './wordTimes';

export interface ExportResult {
  sent: string[];   // ids sent this time, each marked as it went
  skipped: number;  // sent before (ankiAt)
  silent: number;   // sent with text only
  refused: number;  // Anki said no (or failed mid-batch): not marked, goes next time
  unmarked: number; // sent, but writing ankiAt failed: may go again next time
  stopped?: { why: 'anki' | 'tool' | 'read'; error: string }; // the batch stopped here
}

// --- Pure parts (test-anki-export.mjs) ---

// Where to cut a card's line from, in the source's own times, with the single add's padding (ms).
export const cutSpan = (c: Pick<ReviewCard, 'start' | 'end'>, offset: number, pad: { startPadding: number; endPadding: number }): [number, number] =>
  [Math.max(0, c.start - pad.startPadding / 1000 - offset), c.end + pad.endPadding / 1000 - offset];

// A cut that failed for its own line (ffmpeg: / clip: / missing:) vs the cutting tool itself missing (same as settleLine).
export const toolMissing = (e: unknown) => !/^(ffmpeg|clip|missing):/.test(String(e));

export interface Media { audio?: string; ext?: string; image?: string; word?: string; wordExt?: string; silent: boolean } // base64; word = the word's own sound (m4a, or mp3 when read aloud)
export interface Steps {
  media: (c: ReviewCard) => Promise<Media>; // throws only when the cutting tool is missing
  send: (c: ReviewCard, m: Media) => Promise<void>;
  reachable: () => Promise<boolean>;
  mark: (id: string) => Promise<void>;
  current: (id: string) => Promise<ReviewCard | null>; // the card as stored now; null = deleted
}

export const runExport = async (cards: ReviewCard[], steps: Steps, onProgress?: (done: number, total: number) => void): Promise<ExportResult> => {
  const todo = cards.filter(c => !c.ankiAt);
  const r: ExportResult = { sent: [], skipped: cards.length - todo.length, silent: 0, refused: 0, unmarked: 0 };
  onProgress?.(0, todo.length);
  let tried = false; // a send attempted yet: the first one failing is when to ask whether Anki is there at all
  for (let i = 0; i < todo.length; i++) {
    // Read the card as stored now, both before the cut (a clip saved meanwhile is used) and again
    // after it, right before sending (the cut takes a while): sent from the practice page meanwhile
    // → skipped; deleted meanwhile → just left out; unreadable → stop, keeping what went.
    const fresh = async (): Promise<ReviewCard | 'gone'> => {
      const now = await steps.current(todo[i].id);
      if (now && !now.ankiAt) return now;
      if (now) r.skipped++;
      onProgress?.(i + 1, todo.length);
      return 'gone';
    };
    let c: ReviewCard | 'gone';
    try { c = await fresh(); } catch (e) { r.stopped = { why: 'read', error: String(e) }; break; }
    if (c === 'gone') continue;
    let m: Media;
    try { m = await steps.media(c); } catch (e) {
      // Sent / deleted while cutting: skip it rather than stop the batch over it.
      let again: ReviewCard | 'gone';
      try { again = await fresh(); } catch (e2) { r.stopped = { why: 'read', error: String(e2) }; break; }
      if (again === 'gone') continue;
      r.stopped = { why: 'tool', error: String(e) };
      break;
    }
    try { c = await fresh(); } catch (e) { r.stopped = { why: 'read', error: String(e) }; break; }
    if (c === 'gone') continue;
    const first = !tried;
    tried = true;
    try {
      await steps.send(c, m);
    } catch (e) {
      // The very first one failing because Anki isn't there: stop rather than hit it card after card.
      if (first && !await steps.reachable()) { r.stopped = { why: 'anki', error: e instanceof Error ? e.message : String(e) }; break; }
      r.refused++;
      onProgress?.(i + 1, todo.length);
      continue;
    }
    await steps.mark(c.id).catch(e => { console.error(e); r.unmarked++; });
    r.sent.push(c.id);
    if (m.silent) r.silent++;
    onProgress?.(i + 1, todo.length);
  }
  return r;
};

// --- Wiring ---

// One batch at a time, across pages: progress lives here so a page opened mid-batch shows it.
let progress: [number, number] | null = null;
const listeners = new Set<() => void>();
const setProgress = (p: [number, number] | null) => { progress = p; listeners.forEach(fn => fn()); };
export const getExportProgress = () => progress;
export const subscribeExport = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export const exportToAnki = async (cards: ReviewCard[], onProgress?: (done: number, total: number) => void): Promise<ExportResult | null> => {
  const config = getAnkiConfig();
  const template = config?.card;
  if (progress || !config || !template) return null;
  setProgress([0, 0]);
  const keys = Object.values(template.fieldMapping);
  const wantAudio = keys.includes('audio'), wantShot = keys.includes('screenshot');
  const pad = getAudioPaddingConfig();
  const batch = Date.now(); // a fresh name per batch: Rust reuses a file already there
  // Two words of one line are two clips: the word goes in the name (ASCII only, safe_name).
  const nameHash = (w: string) => [...w].reduce((h, ch) => (h * 31 + ch.codePointAt(0)!) >>> 0, 7).toString(36);
  // Same language call as the library pages (ReviewPage), so cards whose video is gone still find their deck.
  const records: LangSource[] = await getAllVideosFromDB().catch(e => { console.error(e); return []; });
  const all = await getAllCards().catch(e => { console.error(e); return cards; }); // every card, as the library judges a video by all of its cards
  const langs = cardLangs(all, records);
  const deckFor = (c: ReviewCard) => {
    const lang = langs.get(c.id);
    const deck = lang && lang !== 'other' ? template.deckByLang?.[lang] : '';
    return deck ? { ...template, deckName: deck } : template;
  };

  const media = async (c: ReviewCard): Promise<Media> => {
    if (!wantAudio && !wantShot) return { silent: false };
    const src = hasAudio(c) ? await findSource(c).catch(() => null) : null;
    if (!src) return { silent: wantAudio };
    const [from, to] = cutSpan(c, src.offset, pad);
    let cut: { file: string; image: string | null };
    try {
      cut = await cutClip(src.path, from, to, `anki_${batch}_${clipKey(c)}`, 'audio');
    } catch (e) {
      if (toolMissing(e)) throw e;
      return { silent: wantAudio };
    }
    const audio = wantAudio ? await readB64(cut.file).catch(() => undefined) : undefined;
    const shot = cut.image ?? c.clip?.image;
    const image = wantShot && shot ? await readB64(shot).catch(() => undefined) : undefined;
    // A word card's own word first (docs/word-audio.md): only where its word times are exact.
    const said = wantAudio && c.deck === 'word' && c.word && getWordVoice() === 'tts' ? await wordVoiceB64(c.word, c.videoId) : undefined;
    const word = said ?? (wantAudio && c.deck === 'word' && c.word
      ? await wordClipB64(src, { text: c.text, startTime: c.start, endTime: c.end }, c.word, await loadWords(c.videoId), `anki_${batch}_${clipKey(c)}_w${nameHash(c.word)}`)
      : undefined);
    return { audio, ext: 'm4a', image, word, wordExt: said ? 'mp3' : undefined, silent: wantAudio && !audio };
  };

  const send = async (c: ReviewCard, m: Media) => {
    const word = c.deck === 'word' ? c.word : undefined;
    await addNote(config.url, deckFor(c), {
      sentence: c.text,
      videoName: c.videoName || 'Unknown',
      timestamp: c.start >= 0 ? formatTimeCode(c.start) : '',
      screenshotBase64: m.image,
      audioBase64: m.audio,
      audioExt: m.ext,
      wordAudioBase64: m.word,
      wordAudioExt: m.wordExt,
      word,
      definition: word ? withAiBlock(clean(c.definition ?? ''), c.ai ?? '') : undefined,
      example: word && c.example ? clean(c.example) : undefined,
    });
  };

  try {
    return await runExport(cards, {
      media,
      send,
      reachable: () => invokeAnki('version', {}, config.url).then(() => true, () => false),
      mark: id => markAnkiSent(id, Date.now()),
      current: getCard,
    }, (done, total) => { setProgress([done, total]); onProgress?.(done, total); });
  } finally {
    setProgress(null);
  }
};
