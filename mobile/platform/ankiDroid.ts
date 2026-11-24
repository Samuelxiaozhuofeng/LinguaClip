// Typed contract for the AnkiDroid bridge (Kotlin AnkiDroidBridge.kt, routes "anki.*";
// docs/android-roadmap.md M2.5). Safe to import on web/PWA: every call rejects with
// 'android:unavailable' there, so callers gate on isAndroidNative() first.
// Error codes (Error.message): 'anki:not_installed' | 'anki:no_permission' | 'anki:api_unavailable'
// | 'anki:media_failed' | 'anki:add_failed' | 'anki:<other short reason>'.
import { callAndroid } from './androidBridge';

export interface AnkiDroidStatus {
  installed: boolean;     // com.ichi2.anki present (needs <queries> on Android 11+)
  permitted: boolean;     // com.ichi2.anki.permission.READ_WRITE_DATABASE granted
  apiAvailable: boolean;  // the FlashCardsContract provider answers (AnkiDroid opened at least once)
  version?: string;       // AnkiDroid versionName, for the settings row
}
export interface AnkiDeck { id: number; name: string }
export interface AnkiModelSpec {
  name: string;           // e.g. utils/anki.ts LINGUACLIP_NAME
  fields: string[];       // field names, in order
  front: string;          // card front template
  back: string;           // card back template
  css: string;
}

export const ankiStatus = () => callAndroid<AnkiDroidStatus>('anki.status');
/** Shows the system permission dialog when not yet granted; resolves after the user answers. */
/** `settings`: Android stopped showing the prompt, so the app's permission page was opened instead. */
export const ankiRequestPermission = () => callAndroid<{ granted: boolean; settings?: boolean }>('anki.requestPermission');
/** Opens AnkiDroid, or its store page when not installed. */
export const ankiOpen = () => callAndroid<{ opened: 'app' | 'store' }>('anki.open');
export const ankiDecks = () => callAndroid<{ decks: AnkiDeck[] }>('anki.decks');
/** Finds the deck by full name ("A::B" allowed) or creates it. */
export const ankiEnsureDeck = (name: string) => callAndroid<{ deckId: number }>('anki.ensureDeck', { name });
/** Finds the note type by name with the same field list, or creates it (templates updated when they differ). */
export const ankiEnsureModel = (spec: AnkiModelSpec) => callAndroid<{ modelId: number }>('anki.ensureModel', { ...spec });
/**
 * Copies a file under the app's own dir into AnkiDroid's media (FileProvider + grantUriPermission).
 * `ref` is what goes into a field: "[sound:name.m4a]" for audio, "<img src=\"name.jpg\">" for images.
 */
export const ankiAddMedia = (path: string, preferredName: string, kind: 'audio' | 'image') =>
  callAndroid<{ ref: string; fileName: string }>('anki.addMedia', { path, preferredName, kind });
/** Adds one note; `fields` in the model's field order. noteId null = AnkiDroid refused (e.g. duplicate first field). */
export const ankiAddNote = (modelId: number, deckId: number, fields: string[], tags: string[] = []) =>
  callAndroid<{ noteId: number | null }>('anki.addNote', { modelId, deckId, fields, tags });
