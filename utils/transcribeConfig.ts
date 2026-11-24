import { isBadKey } from './aiConfig';
import { IS_WINDOWS } from './platform';

// Settings → Transcription: how "make subtitles" runs. On this machine with one
// of two model sizes, or on a cloud service with the user's own key: Groq
// (mode 'cloud', the first cloud option, kept for saved settings), Alibaba
// Cloud Bailian, or a custom OpenAI-compatible transcription endpoint (Android).
// Stored on this machine only, like the AI key.

export type TranscribeMode = 'local' | 'cloud' | 'bailian' | 'custom';
export type LocalModel = 'standard' | 'light';
// gpu: Windows only — run whisper on the graphics card (Vulkan) instead of the CPU;
// gpuName: which card ('' = automatic, a discrete one first; src-tauri/src/gpus.rs).
// splitLong: cut over-long lines of subtitles the user brings on a new import (utils/splitLong.ts).
export type TranscribeConfig = {
  mode: TranscribeMode;
  localModel: LocalModel;
  gpu: boolean;
  gpuName: string;
  groqKey: string;
  bailianKey: string;
  customUrl: string;
  customKey: string;
  customModel: string;
  splitLong: boolean;
};
export type CloudMode = 'cloud' | 'bailian';

export const CLOUD = {
  cloud: { name: 'transcribe.cloud', engine: 'groq', keyField: 'groqKey', keysUrl: 'https://console.groq.com/keys', placeholder: 'gsk_…' },
  bailian: { name: 'transcribe.bailian', engine: 'bailian', keyField: 'bailianKey', keysUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key', placeholder: 'sk-…' },
} as const;

const STORAGE_KEY = 'linguaclip_transcribe_config';
const DEFAULTS: TranscribeConfig = {
  mode: 'local',
  localModel: 'standard',
  gpu: false,
  gpuName: '',
  groqKey: '',
  bailianKey: '',
  customUrl: '',
  customKey: '',
  customModel: 'whisper-1',
  splitLong: true,
};

export function getTranscribeConfig(): TranscribeConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const mode: TranscribeMode = stored.mode === 'cloud' || stored.mode === 'bailian' || stored.mode === 'custom'
      ? stored.mode
      : 'local';
    return {
      mode,
      localModel: stored.localModel === 'light' ? 'light' : 'standard',
      gpu: stored.gpu === true,
      gpuName: str(stored.gpuName),
      groqKey: str(stored.groqKey),
      bailianKey: str(stored.bailianKey),
      customUrl: str(stored.customUrl),
      customKey: str(stored.customKey),
      customModel: str(stored.customModel) || 'whisper-1',
      splitLong: stored.splitLong !== false,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveTranscribeConfig(config: TranscribeConfig): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* localStorage unavailable */ }
}

const cloudKey = (config: TranscribeConfig): string => {
  if (config.mode === 'cloud') return config.groqKey.trim();
  if (config.mode === 'bailian') return config.bailianKey.trim();
  if (config.mode === 'custom') return config.customKey.trim();
  return '';
};

// A cloud service picked but no usable key: the add-video dialog stops here
// instead of starting an import that can only fail.
export function cloudKeyMissing(config = getTranscribeConfig()): boolean {
  if (config.mode === 'local') return false;
  const key = cloudKey(config);
  if (!key || isBadKey(key)) return true;
  if (config.mode === 'custom' && !config.customUrl.trim()) return true;
  return false;
}

// What start_import needs to know about the engine (src-tauri/src/import.rs).
// Desktop does not use 'custom' directly, so treat it safely as 'local' while keeping stored fields intact.
export function engineArgs(config = getTranscribeConfig()) {
  if (config.mode === 'cloud' || config.mode === 'bailian') {
    return { engine: CLOUD[config.mode].engine, model: null, gpu: false, gpuName: null, apiKey: cloudKey(config) };
  }
  return { engine: 'local', model: config.localModel, gpu: IS_WINDOWS && config.gpu, gpuName: config.gpuName || null, apiKey: null };
}

export interface AndroidCloudArgs {
  provider: 'groq' | 'bailian' | 'custom';
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

// Resolves the active cloud ASR provider on Android (defaults to whichever key is configured when mode='local').
export function androidCloudArgs(config = getTranscribeConfig()): AndroidCloudArgs | null {
  const ok = (k: string) => {
    const t = k.trim();
    return !!t && !isBadKey(t);
  };
  const mode = config.mode === 'local'
    ? (ok(config.groqKey) ? 'cloud' : ok(config.bailianKey) ? 'bailian' : (config.customUrl.trim() && ok(config.customKey)) ? 'custom' : 'cloud')
    : config.mode;
  if (mode === 'cloud') {
    return ok(config.groqKey) ? { provider: 'groq', apiKey: config.groqKey.trim() } : null;
  }
  if (mode === 'bailian') {
    return ok(config.bailianKey) ? { provider: 'bailian', apiKey: config.bailianKey.trim() } : null;
  }
  const baseUrl = config.customUrl.trim();
  if (!baseUrl || !ok(config.customKey)) return null;
  return {
    provider: 'custom',
    apiKey: config.customKey.trim(),
    baseUrl,
    model: config.customModel.trim() || 'whisper-1',
  };
}
