import { isBadKey } from './aiConfig';
import { IS_WINDOWS } from './platform';

// Settings → Transcription: how "make subtitles" runs. On this machine with one
// of two model sizes, or on a cloud service with the user's own key: Groq
// (mode 'cloud', the first cloud option, kept for saved settings) or Alibaba
// Cloud Bailian. Stored on this machine only, like the AI key.

export type TranscribeMode = 'local' | 'cloud' | 'bailian';
export type LocalModel = 'standard' | 'light';
// gpu: Windows only — run whisper on the graphics card (Vulkan) instead of the CPU;
// gpuName: which card ('' = automatic, a discrete one first; src-tauri/src/gpus.rs).
export type TranscribeConfig = { mode: TranscribeMode; localModel: LocalModel; gpu: boolean; gpuName: string; groqKey: string; bailianKey: string };
export type CloudMode = Exclude<TranscribeMode, 'local'>;

export const CLOUD = {
  cloud: { name: 'transcribe.cloud', engine: 'groq', keyField: 'groqKey', keysUrl: 'https://console.groq.com/keys', placeholder: 'gsk_…' },
  bailian: { name: 'transcribe.bailian', engine: 'bailian', keyField: 'bailianKey', keysUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', placeholder: 'sk-…' },
} as const;

const STORAGE_KEY = 'linguaclip_transcribe_config';
const DEFAULTS: TranscribeConfig = { mode: 'local', localModel: 'standard', gpu: false, gpuName: '', groqKey: '', bailianKey: '' };

export function getTranscribeConfig(): TranscribeConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      mode: stored.mode === 'cloud' || stored.mode === 'bailian' ? stored.mode : 'local',
      localModel: stored.localModel === 'light' ? 'light' : 'standard',
      gpu: stored.gpu === true,
      gpuName: str(stored.gpuName),
      groqKey: str(stored.groqKey),
      bailianKey: str(stored.bailianKey),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTranscribeConfig(config: TranscribeConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* localStorage unavailable */ }
}

const cloudKey = (config: TranscribeConfig): string =>
  config.mode === 'local' ? '' : config[CLOUD[config.mode].keyField].trim();

// A cloud service picked but no usable key: the add-video dialog stops here
// instead of starting an import that can only fail.
export function cloudKeyMissing(config = getTranscribeConfig()): boolean {
  const key = cloudKey(config);
  return config.mode !== 'local' && (!key || isBadKey(key));
}

// What start_import needs to know about the engine (src-tauri/src/import.rs).
export function engineArgs(config = getTranscribeConfig()) {
  return config.mode === 'local'
    ? { engine: 'local', model: config.localModel, gpu: IS_WINDOWS && config.gpu, gpuName: config.gpuName || null, apiKey: null }
    : { engine: CLOUD[config.mode].engine, model: null, gpu: false, gpuName: null, apiKey: cloudKey(config) };
}
