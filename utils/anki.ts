import { ankiRequest } from './desktop';
import { AnkiConfig, AnkiCardTemplateConfig, WordFront } from '../types';
import { getWordFront } from './storage';
import { sentenceParts } from './textTokenizer';
import { furigana, readingOf, type Ruby } from './japanese';

const STORAGE_KEY_ANKI = 'linguaclip_anki_config';
const DEFAULT_URL = 'http://127.0.0.1:8765';

export const getAnkiConfig = (): AnkiConfig | null => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_ANKI);
    if (!stored) return null;

    const parsed: any = JSON.parse(stored);
    if (!parsed || typeof parsed !== 'object') return null;

    // Oldest shape: one template at the top level
    if ('deckName' in parsed && 'modelName' in parsed) {
      return {
        url: parsed.url || DEFAULT_URL,
        card: { deckName: parsed.deckName, modelName: parsed.modelName, fieldMapping: parsed.fieldMapping || {} },
      };
    }

    if ('url' in parsed) {
      // Before 2026-09 there were word + audio cards; both add buttons already
      // preferred the audio one, so keep that and nothing changes for the user.
      const card = parsed.card || parsed.audioCard || parsed.wordCard || null;
      return { url: parsed.url || DEFAULT_URL, card };
    }

    return null;
  } catch (e) {
    return null;
  }
};

export const saveAnkiConfig = (config: AnkiConfig) => {
  localStorage.setItem(STORAGE_KEY_ANKI, JSON.stringify(config));
};

// Helper to invoke AnkiConnect actions
export const invokeAnki = async (action: string, params: any = {}, url: string = DEFAULT_URL) => {
  try {
    const raw = await ankiRequest(url, JSON.stringify({ action, version: 6, params }));
    let result: any;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error(`not AnkiConnect: ${raw.slice(0, 120) || '(empty body)'}`);
    }

    if (result.error) {
      throw new Error(result.error);
    }
    
    return result.result;
  } catch (e) {
    console.error(`AnkiConnect Error (${action}):`, e);
    throw e;
  }
};

export const getDeckNames = async (url: string) => {
  return invokeAnki('deckNames', {}, url);
};

export const getModelNames = async (url: string) => {
  return invokeAnki('modelNames', {}, url);
};

export const getModelFieldNames = async (modelName: string, url: string) => {
  return invokeAnki('modelFieldNames', { modelName }, url);
};

export const addNote = async (
  url: string,
  template: AnkiCardTemplateConfig,
  data: { 
    sentence: string; 
    videoName: string; 
    timestamp: string; 
    screenshotBase64?: string;
    audioBase64?: string;
    audioExt?: string;
    word?: string;
    definition?: string;
    example?: string;
  }
) => {
  const fields: Record<string, string> = {};
  // Our own note type gets furigana as <ruby> (its CSS decides when it shows) and is
  // brought up to the current template first; anyone else's gets plain bold text.
  const own = template.modelName === LINGUACLIP_NAME;
  if (own) await syncLinguaClipTemplate(url).catch(console.error);
  const sentence = own ? rubySentence(data.sentence, data.word) : boldWord(data.sentence, data.word || '');
  const word = own && data.word ? rubyHtml(furigana(data.word, readingOf(data.word))) : escHtml(data.word || '');
  const picture: any[] = [];
  const audio: any[] = [];

  // Map app data to Anki fields
  Object.entries(template.fieldMapping).forEach(([ankiField, appKey]) => {
    if (!appKey) return;

    if (appKey === 'sentence') fields[ankiField] = sentence;
    else if (appKey === 'videoName') fields[ankiField] = escHtml(data.videoName);
    else if (appKey === 'timestamp') fields[ankiField] = escHtml(data.timestamp);
    else if (appKey === 'word') fields[ankiField] = word;
    else if (appKey === 'definition') fields[ankiField] = data.definition || '';
    else if (appKey === 'example') fields[ankiField] = data.example || '';
    else if (appKey === 'context') fields[ankiField] = sentence; // Context is usually the full sentence
    else if (appKey === 'screenshot' && data.screenshotBase64) {
        picture.push({
            data: data.screenshotBase64.replace(/^data:image\/(png|jpg|jpeg);base64,/, ""),
            filename: `linguaclip_img_${Date.now()}.png`,
            fields: [ankiField]
        });
    }
    else if (appKey === 'audio' && data.audioBase64) {
        audio.push({
            data: data.audioBase64,
            filename: `linguaclip_audio_${Date.now()}.${data.audioExt || 'webm'}`,
            fields: [ankiField]
        });
    }
  });

  const note = {
    deckName: template.deckName,
    modelName: template.modelName,
    fields: fields,
    options: {
      allowDuplicate: true, // Fix for "cannot create note because it is a duplicate"
      duplicateScope: "deck",
    },
    picture: picture.length > 0 ? picture : undefined,
    audio: audio.length > 0 ? audio : undefined,
  };

  return invokeAnki('addNote', { note }, url);
};

// Subtitle lines, words and AI replies are text: in an Anki field they must not become tags.
export const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Wrap the looked-up word in <b> where it sits in the sentence, as escaped HTML. Whole-word
// match first (so "a" doesn't light up inside "want"); scripts without spaces (Japanese)
// fall back to the first plain occurrence. Matched on the raw text, each piece escaped after.
export const boldWord = (sentence: string, word: string): string => {
  const w = word.trim();
  if (!w) return escHtml(sentence);
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const whole = new RegExp(`(?<![\\p{L}\\p{N}])${esc}(?![\\p{L}\\p{N}])`, 'iu');
  const m = whole.exec(sentence) ?? new RegExp(esc, 'iu').exec(sentence);
  if (!m) return escHtml(sentence);
  const end = m.index + m[0].length;
  return `${escHtml(sentence.slice(0, m.index))}<b>${escHtml(m[0])}</b>${escHtml(sentence.slice(end))}`;
};

const rubyHtml = (parts: Ruby[]) => parts.map(p => p.rt ? `<ruby>${escHtml(p.s)}<rt>${escHtml(p.rt)}</rt></ruby>` : escHtml(p.s)).join('');

// The line for a LinguaClip note: kanji with their kana (Japanese, dictionary loaded),
// the kept word in <b>. Plain text otherwise, as before.
export const rubySentence = (sentence: string, word?: string): string =>
  sentenceParts(sentence, word).flatMap(g => g.pieces).map(p => p.target ? `<b>${rubyHtml([p])}</b>` : rubyHtml([p])).join('').replace(/<\/b><b>/g, '');

// --- One-click LinguaClip card: a deck + note type made for this app ---

export const LINGUACLIP_NAME = 'LinguaClip';

// Anki field -> app data key. Sentence goes first: Anki refuses notes whose
// first field is empty, and both add buttons always send a sentence.
export const LINGUACLIP_FIELDS: Record<string, string> = {
  Sentence: 'sentence',
  Audio: 'audio',
  Image: 'screenshot',
  Word: 'word',
  Definition: 'definition',
  Example: 'example',
  Video: 'videoName',
  Time: 'timestamp',
};

// Sentence notes (no Word): sound + picture, answer the line. Word notes: think from the
// word (or its line, per Settings), then the sound, picture, kana and meaning.
export const linguaClipFront = (front: WordFront) => `{{#Word}}<div class="front">${front === 'word' ? '<div class="word">{{Word}}</div>' : '<div class="sentence">{{Sentence}}</div>'}</div>{{/Word}}
{{^Word}}{{Audio}}
<div class="shot">{{Image}}</div>{{/Word}}`;

const LINGUACLIP_BACK = `{{#Word}}{{Audio}}
<div class="shot">{{Image}}</div>
<div class="word">{{Word}}</div>{{/Word}}
{{^Word}}{{FrontSide}}{{/Word}}
<hr id="answer">
<div class="sentence">{{Sentence}}</div>
{{#Definition}}<div class="def">{{Definition}}</div>{{/Definition}}
{{#Example}}<div class="ex">{{Example}}</div>{{/Example}}
<div class="src">{{Video}}{{#Time}} · {{Time}}{{/Time}}</div>`;

// Furigana: over the kept word once the card is turned; over other words on hover (the front too, as in the app).
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

// Bump when the template or CSS above changes: each machine rewrites the note type once per version and front.
const TEMPLATE_VERSION = 3;
const TEMPLATE_KEY = 'linguaclip_anki_tpl';

// Rewrite the LinguaClip note type's card to the current one (the user chose this over
// keeping their own edits). Only its template and CSS: fields and notes stay as they are.
export const syncLinguaClipTemplate = async (url: string, force = false) => {
  const front = getWordFront();
  const mark = `${TEMPLATE_VERSION}:${front}`;
  if (!force) { try { if (localStorage.getItem(TEMPLATE_KEY) === mark) return; } catch { /* storage off: rewrite again */ } }
  // CSS first: stopped halfway, the old card under the new CSS still hides the kana on the front.
  await invokeAnki('updateModelStyling', { model: { name: LINGUACLIP_NAME, css: LINGUACLIP_CSS } }, url);
  await invokeAnki('updateModelTemplates', { model: { name: LINGUACLIP_NAME, templates: { [LINGUACLIP_NAME]: { Front: linguaClipFront(front), Back: LINGUACLIP_BACK } } } }, url);
  try { localStorage.setItem(TEMPLATE_KEY, mark); } catch { /* asked again next time */ }
};

// Create the LinguaClip deck and note type if missing (an existing one gets the
// current card and CSS; its fields stay), then return the card config pointing at them.
export const setupLinguaClipCard = async (url: string): Promise<AnkiCardTemplateConfig> => {
  await invokeAnki('createDeck', { deck: LINGUACLIP_NAME }, url);
  const models: string[] = await getModelNames(url);
  if (!models.includes(LINGUACLIP_NAME)) {
    await invokeAnki('createModel', {
      modelName: LINGUACLIP_NAME,
      inOrderFields: Object.keys(LINGUACLIP_FIELDS),
      css: LINGUACLIP_CSS,
      isCloze: false,
      cardTemplates: [{ Name: LINGUACLIP_NAME, Front: linguaClipFront(getWordFront()), Back: LINGUACLIP_BACK }],
    }, url);
  }
  await syncLinguaClipTemplate(url, true).catch(console.error);
  const fields: string[] = await getModelFieldNames(LINGUACLIP_NAME, url);
  const fieldMapping: Record<string, string> = {};
  fields.forEach((f) => { if (LINGUACLIP_FIELDS[f]) fieldMapping[f] = LINGUACLIP_FIELDS[f]; });
  return { deckName: LINGUACLIP_NAME, modelName: LINGUACLIP_NAME, fieldMapping };
};

// Re-export types for convenience in hooks/components
export type { AnkiConfig, AnkiCardTemplateConfig };
