// Batch export engine for AnkiDroid (docs/android-roadmap.md M2.5, docs/anki-export.md).
// Reuses utils/ankiExport.ts's pure `runExport` state machine and `cutSpan`, utils/anki.ts's
// note type & formatting helpers, and utils/deckLang.ts for per-language sub-decks.
import {
  escHtml,
  LINGUACLIP_FIELDS,
  LINGUACLIP_NAME,
  linguaClipFront,
  rubySentence,
  withAiBlock,
} from '../utils/anki';
import { cutSpan, runExport, toolMissing, type ExportResult, type Media } from '../utils/ankiExport';
import { clean } from '../utils/cleanHtml';
import { clipKey, findSource, type Source } from '../utils/clips';
import { cardLangs, type DeckLang, type LangSource } from '../utils/deckLang';
import { clipPath, cutClip, pathExists } from '../utils/desktop';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { furigana, readingOf, type Ruby } from '../utils/japanese';
import type { Word } from '../utils/resegment';
import { getAllCards, getCard, hasAudio, markAnkiSent, type ReviewCard } from '../utils/review';
import { formatTimeCode, getAudioPaddingConfig, getWordFront } from '../utils/storage';
import { locateWord } from '../utils/wordAudio';
import { loadWords } from '../utils/wordTimes';
import { callAndroid } from './platform/androidBridge';
import {
  ankiAddMedia,
  ankiAddNote,
  ankiEnsureDeck,
  ankiEnsureModel,
  ankiStatus,
  type AnkiModelSpec,
} from './platform/ankiDroid';

export type { ExportResult };

// Same template back & CSS as desktop utils/anki.ts (kept in sync with LINGUACLIP_NAME).
const LINGUACLIP_BACK = `{{#Word}}{{Audio}}
<div class="shot">{{Image}}</div>
<div class="word">{{Word}}</div>{{/Word}}
{{^Word}}{{FrontSide}}{{/Word}}
<hr id="answer">
<div class="sentence">{{Sentence}}</div>
{{#Definition}}<div class="def">{{Definition}}</div>{{/Definition}}
{{#Example}}<div class="ex">{{Example}}</div>{{/Example}}
<div class="src">{{Video}}{{#Time}} · {{Time}}{{/Time}}</div>`;

const LINGUACLIP_CSS = `.card { font-family: -apple-system, "PingFang SC", sans-serif; font-size: 20px; line-height: 1.5; text-align: center; color: #1f2328; background: #fff; }
.nightMode.card, .night_mode .card { color: #e6e1d6; background: #16202a; }
.shot img { max-width: 100%; max-height: 50vh; border-radius: 6px; }
.word { margin-top: 12px; font-size: 30px; font-weight: 600; }
.front .word { font-size: 44px; }
.sentence { font-size: 22px; line-height: 2; }
.sentence b { color: #d9a441; }
rt { font-size: .45em; opacity: .65; }
.sentence ruby rt { visibility: hidden; }
.sentence ruby:hover rt, .sentence b rt { visibility: visible; }
.front .word rt, .front b rt { visibility: hidden !important; }
.def, .ex { margin-top: 12px; font-size: 16px; text-align: left; }
.ex { opacity: .75; }
.def .ai { margin-top: 8px; padding: 6px 10px; border-radius: 6px; background: rgba(217, 164, 65, .12); font-size: 15px; }
.src { margin-top: 16px; font-size: 12px; opacity: .5; }`;

const LANG_SUBDECK: Record<Exclude<DeckLang, 'other'>, string> = {
  en: 'English',
  ja: 'Japanese',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  no: 'Norwegian',
};

const FIELD_ORDER = Object.keys(LINGUACLIP_FIELDS);

const rubyHtml = (parts: Ruby[]) =>
  parts.map(p => (p.rt ? `<ruby>${escHtml(p.s)}<rt>${escHtml(p.rt)}</rt></ruby>` : escHtml(p.s))).join('');

const nameHash = (w: string) =>
  [...w].reduce((h, ch) => (h * 31 + ch.codePointAt(0)!) >>> 0, 7).toString(36);

export function deckNameForLang(lang: DeckLang, baseDeck = LINGUACLIP_NAME): string {
  if (lang === 'other') return baseDeck;
  return `${baseDeck}::${LANG_SUBDECK[lang] ?? lang}`;
}

export function linguaClipModelSpec(): AnkiModelSpec {
  return {
    name: LINGUACLIP_NAME,
    fields: FIELD_ORDER,
    front: linguaClipFront(getWordFront()),
    back: LINGUACLIP_BACK,
    css: LINGUACLIP_CSS,
  };
}

export function buildNoteFields(
  card: ReviewCard,
  media: { audioRefs?: string[]; imageRef?: string } = {},
): string[] {
  const word = card.deck === 'word' ? card.word : undefined;
  const sentence = rubySentence(card.text, word);
  const wordHtml = word ? rubyHtml(furigana(word, readingOf(word))) : '';
  const definition = word ? withAiBlock(clean(card.definition ?? ''), card.ai ?? '') : '';
  const example = word && card.example ? clean(card.example) : '';
  const values: Record<string, string> = {
    sentence,
    audio: (media.audioRefs ?? []).join(''),
    screenshot: media.imageRef ?? '',
    word: wordHtml,
    definition,
    example,
    videoName: escHtml(card.videoName || 'Unknown'),
    timestamp: card.start >= 0 ? escHtml(formatTimeCode(card.start)) : '',
  };
  return FIELD_ORDER.map(fieldName => values[LINGUACLIP_FIELDS[fieldName]] ?? '');
}

const isFatalAnkiError = (e: unknown): boolean => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === 'anki:not_installed' || msg === 'anki:no_permission' || msg === 'anki:api_unavailable';
};

export interface AnkiDroidExportDeps {
  baseDeck?: string;
  getVideos?: () => Promise<LangSource[]>;
  getAllCards?: () => Promise<ReviewCard[]>;
  getCard?: (id: string) => Promise<ReviewCard | null>;
  markSent?: (id: string, at: number) => Promise<void>;
  clipPath?: (file: string) => Promise<string>;
  pathExists?: (path: string) => Promise<boolean>;
  findSource?: (c: ReviewCard) => Promise<Source | null>;
  cutClip?: (src: string, from: number, to: number, name: string, kind: 'video' | 'audio') => Promise<{ file: string; image: string | null }>;
  loadWords?: (videoId: string) => Promise<Word[] | null>;
  removeTempFile?: (path: string) => Promise<void>;
  status?: typeof ankiStatus;
  ensureModel?: typeof ankiEnsureModel;
  ensureDeck?: typeof ankiEnsureDeck;
  addMedia?: typeof ankiAddMedia;
  addNote?: typeof ankiAddNote;
  now?: () => number;
}

// --- Shared progress store (mirrors utils/ankiExport.ts) ---

let progress: [number, number] | null = null;
const listeners = new Set<() => void>();
const setProgress = (p: [number, number] | null) => {
  progress = p;
  listeners.forEach(fn => fn());
};
export const getAnkiDroidProgress = (): [number, number] | null => progress;
export const subscribeAnkiDroid = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export async function exportToAnkiDroid(
  cards: ReviewCard[],
  onProgress?: (done: number, total: number) => void,
  deps: AnkiDroidExportDeps = {},
): Promise<ExportResult | null> {
  if (progress) return null;
  setProgress([0, 0]);

  const baseDeck = deps.baseDeck ?? LINGUACLIP_NAME;
  const readVideos = deps.getVideos ?? getAllVideosFromDB;
  const readAllCards = deps.getAllCards ?? getAllCards;
  const readCard = deps.getCard ?? getCard;
  const markSent = deps.markSent ?? markAnkiSent;
  const resolveClip = deps.clipPath ?? clipPath;
  const checkExists = deps.pathExists ?? pathExists;
  const locateSource = deps.findSource ?? findSource;
  const doCut = deps.cutClip ?? cutClip;
  const readWords = deps.loadWords ?? loadWords;
  const removeTemp = deps.removeTempFile ?? (async (path: string) => {
    await callAndroid('media.removeFile', { path }).catch(() => {});
  });
  const getStatus = deps.status ?? ankiStatus;
  const ensureModel = deps.ensureModel ?? ankiEnsureModel;
  const ensureDeck = deps.ensureDeck ?? ankiEnsureDeck;
  const addMedia = deps.addMedia ?? ankiAddMedia;
  const addNote = deps.addNote ?? ankiAddNote;
  const now = deps.now ?? Date.now;

  const pad = getAudioPaddingConfig();
  const batch = now();
  const tempFiles = new Set<string>();
  const cardTemps = new Map<string, string[]>();
  const wordsCache = new Map<string, Promise<Word[] | null>>();
  let cachedModelId: number | null = null;
  const deckIdCache = new Map<string, number>();

  const cleanupCardTemps = async (cardId: string) => {
    const list = cardTemps.get(cardId);
    if (!list) return;
    cardTemps.delete(cardId);
    for (const p of list) {
      tempFiles.delete(p);
      await removeTemp(p).catch(() => {});
    }
  };

  const trackTemp = (cardId: string, path: string) => {
    tempFiles.add(path);
    const list = cardTemps.get(cardId);
    if (list) list.push(path);
    else cardTemps.set(cardId, [path]);
  };

  const wordsOf = (videoId: string): Promise<Word[] | null> => {
    if (!videoId) return Promise.resolve(null);
    let p = wordsCache.get(videoId);
    if (!p) {
      p = readWords(videoId).catch(() => null);
      wordsCache.set(videoId, p);
    }
    return p;
  };

  try {
    const records: LangSource[] = await readVideos().catch(e => { console.error(e); return []; });
    const all = await readAllCards().catch(e => { console.error(e); return cards; });
    const langs = cardLangs(all, records);

    const media = async (c: ReviewCard): Promise<Media> => {
      let audioPath: string | undefined;
      let imagePath: string | undefined;
      let wordPath: string | undefined;
      let srcForWord: Source | null = null;

      // 1. Prefer the card's existing standalone clip (never marked temporary, never deleted).
      if (c.clip?.file) {
        const existing = await resolveClip(c.clip.file).catch(() => '');
        if (existing && await checkExists(existing).catch(() => false)) {
          audioPath = existing;
          srcForWord = { path: existing, offset: c.clip.from };
        }
        if (c.clip.image) {
          const img = await resolveClip(c.clip.image).catch(() => '');
          if (img && await checkExists(img).catch(() => false)) imagePath = img;
        }
      }

      // 2. Otherwise cut a temporary anki_<batch>_<key> clip from the source audio.
      if (!audioPath && hasAudio(c)) {
        const src = await locateSource(c).catch(() => null);
        if (src) {
          srcForWord = src;
          const [from, to] = cutSpan(c, src.offset, pad);
          try {
            const cut = await doCut(src.path, from, to, `anki_${batch}_${clipKey(c)}`, 'audio');
            const full = await resolveClip(cut.file);
            trackTemp(c.id, full);
            audioPath = full;
            if (!imagePath && cut.image) {
              const imgFull = await resolveClip(cut.image);
              trackTemp(c.id, imgFull);
              imagePath = imgFull;
            }
          } catch (e) {
            if (toolMissing(e)) throw e;
          }
        }
      }

      // 3. Word audio for word cards (docs/word-audio.md): cut exact word clip when timestamps exist; never block the card.
      if (c.deck === 'word' && c.word && srcForWord) {
        try {
          const words = await wordsOf(c.videoId);
          const spot = locateWord({ text: c.text, startTime: c.start, endTime: c.end }, c.word, words);
          if (spot?.exact) {
            const wName = `anki_${batch}_${clipKey(c)}_w${nameHash(c.word)}`;
            const wCut = await doCut(srcForWord.path, Math.max(0, spot.from - srcForWord.offset), spot.to - srcForWord.offset, wName, 'audio');
            const wFull = await resolveClip(wCut.file);
            trackTemp(c.id, wFull);
            wordPath = wFull;
          }
        } catch (e) {
          console.error('[ankiDroid word clip]', e);
        }
      }

      return { audio: audioPath, image: imagePath, word: wordPath, silent: !audioPath };
    };

    const send = async (c: ReviewCard, m: Media) => {
      try {
        if (cachedModelId === null) {
          const res = await ensureModel(linguaClipModelSpec());
          cachedModelId = res.modelId;
        }
        const deckName = deckNameForLang(langs.get(c.id) ?? 'other', baseDeck);
        let deckId = deckIdCache.get(deckName);
        if (deckId === undefined) {
          const res = await ensureDeck(deckName);
          deckId = res.deckId;
          deckIdCache.set(deckName, deckId);
        }

        const audioRefs: string[] = [];
        let imageRef: string | undefined;
        const baseKey = clipKey(c).replace(/[^A-Za-z0-9_-]/g, '_');

        // Word audio goes before sentence audio in the Audio field (docs/word-audio.md).
        if (m.word) {
          try {
            const added = await addMedia(m.word, `lc_${batch}_${baseKey}_w`, 'audio');
            audioRefs.push(added.ref);
          } catch (e) {
            if (isFatalAnkiError(e)) throw e;
            console.error('[ankiDroid word media]', e);
          }
        }
        if (m.audio) {
          try {
            const added = await addMedia(m.audio, `lc_${batch}_${baseKey}`, 'audio');
            audioRefs.push(added.ref);
          } catch (e) {
            if (isFatalAnkiError(e)) throw e;
            console.error('[ankiDroid line media]', e);
            m.silent = true;
          }
        }
        if (m.image) {
          try {
            const added = await addMedia(m.image, `lc_${batch}_${baseKey}_img`, 'image');
            imageRef = added.ref;
          } catch (e) {
            if (isFatalAnkiError(e)) throw e;
            console.error('[ankiDroid image media]', e);
          }
        }

        const fields = buildNoteFields(c, { audioRefs, imageRef });
        const added = await addNote(cachedModelId, deckId, fields, ['linguaclip']);
        if (added.noteId == null) throw new Error('anki:add_failed');
      } finally {
        await cleanupCardTemps(c.id);
      }
    };

    const reachable = () =>
      getStatus().then(s => !!(s.installed && s.permitted && s.apiAvailable), () => false);

    return await runExport(
      cards,
      {
        media,
        send,
        reachable,
        mark: id => markSent(id, now()),
        current: readCard,
      },
      (done, total) => {
        setProgress([done, total]);
        onProgress?.(done, total);
      },
    );
  } finally {
    for (const p of tempFiles) {
      await removeTemp(p).catch(() => {});
    }
    tempFiles.clear();
    cardTemps.clear();
    setProgress(null);
  }
}
