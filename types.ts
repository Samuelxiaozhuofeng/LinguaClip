export interface Subtitle {
  id: number;
  startTime: number; // in seconds
  endTime: number;   // in seconds
  text: string;
}

export enum AppState {
  UPLOAD = 'UPLOAD',
  PRACTICE = 'PRACTICE',
  LIBRARY = 'LIBRARY',
  CARDS = 'CARDS',
  SETTINGS = 'SETTINGS',
  WATCH = 'WATCH',       // watch mode: the whole window is the video (components/WatchPage.tsx)
  READ = 'READ',         // reading the subtitles before practice (pro/ReaderPage.tsx)
}

export enum PracticeMode {
  LISTENING = 'LISTENING', // Video is playing, controls active
  INPUT = 'INPUT',         // Video paused at end of line, waiting for user input
  FEEDBACK = 'FEEDBACK',   // User submitted, showing corrections
  BLUR = 'BLUR',           // Blur mode: subtitles shown as placeholders, user can reveal words
}

// Learning Mode: determines the overall practice approach
export enum LearningMode {
  DICTATION = 'DICTATION',  // Original mode: listen, input, feedback
  BLUR = 'BLUR',            // Blur mode: watch with blurred subtitles, reveal on demand
}

// Blur Mode Playback Style
export enum BlurPlaybackMode {
  SENTENCE_BY_SENTENCE = 'SENTENCE_BY_SENTENCE',  // Auto-pause after each subtitle
  CONTINUOUS = 'CONTINUOUS',                       // Continuous playback, manual pause
}

export interface VideoSource {
  url: string;
  file: File;
}

export interface SavedLine {
  id: string;        // Unique ID for storage
  text: string;
  dateSaved: number;
  videoName?: string;
  timeDisplay: string; // e.g. "01:23"
}

// How many words the user types in dictation. Global (all videos share one).
export type ClozeLevel = 'easy' | 'medium' | 'full';

// Practice Configuration
export type WordFront = 'word' | 'sentence';

export interface PracticeConfig {
  sectionLength: number; // in minutes. 0 means "Full Video" (no sections)
  learningMode?: LearningMode; // Default learning mode for new videos
  blurPlaybackMode?: BlurPlaybackMode; // Default playback mode for blur mode
  clozeLevel?: ClozeLevel; // Dictation blank density; default 'full'
  autoAddReview?: boolean; // stuck lines go into the sentence deck on their own; default false
  saveClips?: boolean; // review cards keep their own clip of the line (utils/clips.ts); default false
  clipKind?: 'video' | 'audio'; // what a new clip is: a small video, or sound + a still; default video
  videoShare?: number; // % of the practice page's width given to the video; default 60
  wordFront?: WordFront; // what a word card shows before it is turned (review and Anki); default 'word'
  custom?: import('./utils/customPick').CustomConfig; // the start-of-practice panel's last choice
}

export interface VideoSection {
  id: number;
  label: string;
  startTime: number;
  endTime: number;
  subtitleIndices: number[]; // Indices relative to the full subtitle array (optional usage)
  subtitles: Subtitle[];
}

// Anki specific types
export interface AnkiCardTemplateConfig {
  deckName: string;
  modelName: string;
  fieldMapping: Record<string, string>; // Anki Field Name -> App Data Key
  deckByLang?: Partial<Record<import('./utils/dictionary').DictLang, string>>; // a language's own deck; unset = deckName
}

export interface AnkiConfig {
  url: string;
  card: AnkiCardTemplateConfig | null;
}

// AI Configuration
export interface AIConfig {
  model: string;
  temperature: number;
  promptTemplate?: string;
  apiKey?: string;      // User's own key for the OpenAI-compatible endpoint
  baseUrl?: string;     // OpenAI-compatible base URL; required
  segmentModel?: string; // model used to re-cut transcript lines on import
  autoBreakdown?: boolean; // prepare breakdowns as soon as an import finishes
  autoCloze?: boolean;     // prepare cloze blanks as soon as an import finishes
  jaSegmentAi?: boolean;   // have the AI check Japanese phrase splits (utils/jaSegments.ts)
  limits?: { segment?: number; breakdown?: number; cloze?: number }; // AI calls in flight per job kind (utils/aiLimit.ts)
}

// Audio Padding Configuration
export interface AudioPaddingConfig {
  startPadding: number; // in milliseconds
  endPadding: number;   // in milliseconds
}

export const APP_DATA_FIELDS = [
  { key: 'sentence', label: 'Sentence (Subtitle)' },
  { key: 'videoName', label: 'Video Name' },
  { key: 'timestamp', label: 'Timestamp (MM:SS)' },
  { key: 'screenshot', label: 'Screenshot (Image)' },
  { key: 'audio', label: 'Audio (Clip)' },
  { key: 'word', label: 'Selected Word' },
  { key: 'definition', label: 'Word Definition' },
  { key: 'example', label: 'Example Sentences (Dictionary)' },
  { key: 'context', label: 'Context (Sentence)' },
] as const;

// Video History and Progress Types
export interface VideoRecord {
  id: string;                           // UUID
  displayName: string;                  // Display name (from file name)
  videoFileName: string;                // Original video file name
  subtitleFileName: string;             // Original subtitle file name

  // File access (for File System Access API)
  videoFileHandle?: any;                // FileSystemFileHandle (stored separately in IndexedDB)
  videoPath?: string;                   // Absolute video path on disk (desktop)
  subtitleText: string;                 // Subtitle content (stored in IndexedDB)

  // Progress information
  currentSubtitleIndex: number;         // Current subtitle index
  currentSectionIndex: number;          // Current section index
  totalSubtitles: number;               // Total number of subtitles
  completionRate: number;               // Completion percentage (0-100)

  // Metadata
  dateAdded: number;                    // Timestamp when added
  lastPracticed: number;                // Timestamp of last practice
  totalPracticeTime: number;            // Total practice time in seconds
  learningMode?: LearningMode;          // Last-used practice mode
  blurPlaybackMode?: BlurPlaybackMode;  // Last-used blur playback variant
  lang?: import('./utils/dictionary').DictLang; // set by hand in the video's menu; unset = guessed from the subtitles (utils/deckLang.ts)

  // Present while a YouTube/local import is generating subtitles (or failed).
  // Cleared once videoPath / subtitleText / totalSubtitles are filled in.
  importJob?: {
    stage: 'queued' | 'setup' | 'download' | 'convertSetup' | 'convert' | 'extract' | 'transcribe' | 'cloud' | 'segment';
    percent?: number;
    error?: string;
    source: string;
    // What the user picked when they started this import, kept so a retry repeats
    // it instead of silently falling back to English/1080p. Absent on records made
    // before retry existed; the retry then uses those same defaults.
    lang?: string;
    quality?: number;
    // Convert to mp4 even though the file name says it plays ("convert and retry").
    convert?: boolean;
    // Subtitles the user brought, so nothing is transcribed: their own .srt (already
    // in subtitleText) or track N inside the video.
    subs?: 'own' | number;
    // Move `source` to the Trash once the whole import has succeeded.
    trashOriginal?: boolean;
    // The mp4 a conversion made; a retry starts from it instead of converting again.
    converted?: string;
  };
}

export interface PracticeProgress {
  videoId: string;
  currentSubtitleIndex: number;
  currentSectionIndex: number;
  lastUpdated: number;
}
