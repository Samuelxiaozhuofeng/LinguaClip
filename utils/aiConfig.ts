import { fetch } from '@tauri-apps/plugin-http';
import type { AIConfig, AIProfile } from '../types';

// Where the AI settings live, and how they turn into an OpenAI-compatible
// endpoint. Kept apart from ai.ts so utils/resegment.ts can read the same
// settings without dragging i18n/React along.

const STORAGE_KEY_AI = 'linguaclip_ai_config';

export const DEFAULT_PROMPT = `Define the word "{word}" as it is used in this sentence: "{context}". Provide a brief definition and its part of speech.`;

const DEFAULTS: AIConfig = {
  model: '',
  temperature: 0.7,
  promptTemplate: DEFAULT_PROMPT,
  apiKey: '',
  baseUrl: '',
  segmentModel: '',
};

export const getAIConfig = (): AIConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY_AI);
    return { ...DEFAULTS, ...(stored ? JSON.parse(stored) : {}) };
  } catch {
    return { ...DEFAULTS };
  }
};

export const saveAIConfig = (config: AIConfig) => {
  localStorage.setItem(STORAGE_KEY_AI, JSON.stringify(config));
};

// No default endpoint: the user brings their own provider, address and key.
export const normalizeBaseUrl = (url?: string): string =>
  (url?.trim() ?? '').replace(/\/+$/, '');

// Some gateways glue a trailing SSE "data: [DONE]" onto an otherwise normal
// JSON body, which makes res.json() throw a bare "string did not match the
// expected pattern". Read the text and clean it ourselves instead.
export const readJsonBody = async <T,>(res: Response): Promise<T> => {
  const raw = await res.text();
  return JSON.parse(raw.replace(/\s*data:\s*\[DONE\]\s*$/, '').trim()) as T;
};

export type Endpoint = { baseUrl: string; apiKey: string };

// A key is printable ASCII with no spaces. Anything else (a pasted sentence, a
// stray space) cannot even go into a request header — the webview throws a bare
// "Type error" — so such a key counts as not set, and Settings says why.
export const isBadKey = (key: string): boolean => /[^\x21-\x7e]/.test(key);

export const getEndpoint = (): Endpoint | null => {
  const config = getAIConfig();
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!config.apiKey || !baseUrl || isBadKey(config.apiKey)) return null;
  return { baseUrl, apiKey: config.apiKey };
};

// Providers the phone's AI tab offers as one tap (docs/ai-providers.md). All are
// spoken to through their OpenAI-compatible endpoint, so every caller stays one
// code path; "custom" is any other OpenAI-compatible address.
export type AiProvider = 'openai' | 'claude' | 'gemini' | 'custom';
export const AI_PRESETS: Record<Exclude<AiProvider, 'custom'>, { label: string; baseUrl: string; keysUrl: string; placeholder: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keysUrl: 'https://platform.openai.com/api-keys', placeholder: 'sk-...' },
  claude: { label: 'Claude', baseUrl: 'https://api.anthropic.com/v1', keysUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-...' },
  gemini: { label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keysUrl: 'https://aistudio.google.com/apikey', placeholder: 'AIza...' },
};

// Which provider tab the config is on: the phone's explicit pick wins (a custom
// entry may well use an official address); a preset whose address was since
// edited elsewhere (desktop) counts as custom; older configs are told by address.
export const providerOf = (config: Pick<AIConfig, 'provider' | 'baseUrl'>): AiProvider => {
  const url = normalizeBaseUrl(config.baseUrl);
  if (config.provider === 'custom') return 'custom';
  if (config.provider) return !url || url === AI_PRESETS[config.provider].baseUrl ? config.provider : 'custom';
  for (const [id, p] of Object.entries(AI_PRESETS)) if (url === p.baseUrl) return id as AiProvider;
  return 'custom';
};

const isAnthropic = (baseUrl: string) => /^https:\/\/api\.anthropic\.com(\/|$)/.test(normalizeBaseUrl(baseUrl));

// Request headers for an AI call. Anthropic wants a version header on GET /models,
// and a browser (the phone PWA) must opt in to its CORS; those extra headers go
// only to Anthropic so other gateways' CORS preflight stays simple.
export const aiHeaders = (baseUrl: string, apiKey: string, json = true): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  ...(isAnthropic(baseUrl) ? { 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
});

// Each AI job can use its own model (phone Settings → AI → per feature). A job the
// phone has set to "use default" (key present, value '') takes the main model;
// a job never touched falls back as before: look-up → main model, batch jobs →
// the desktop "line-splitting model" if set, else the main model.
export type AiFeature = 'lookup' | 'breakdown' | 'translate' | 'segment' | 'cloze' | 'keywords';
export const AI_FEATURES: AiFeature[] = ['lookup', 'breakdown', 'translate', 'segment', 'cloze', 'keywords'];

export const modelFor = (feature: AiFeature, config: AIConfig = getAIConfig()): string => {
  const own = config.featureModels?.[feature];
  const legacy = own === undefined && feature !== 'lookup' ? config.segmentModel?.trim() : '';
  return own?.trim() || legacy || config.model?.trim() || '';
};

// Extra chat body fields per provider. Claude's compatible endpoint wants a reply
// budget, and newer Claude models reject any temperature below 1 (400), so for
// Claude temperature is never sent (ai.ts) and max_tokens always is.
export const chatExtras = (baseUrl: string): Record<string, unknown> =>
  isAnthropic(baseUrl) ? { max_tokens: 8192 } : {};
// OpenAI's reasoning models (o1 / o3 / o4-mini, gpt-5…) also refuse a custom temperature.
export const sendsTemperature = (baseUrl: string, model = '') =>
  !isAnthropic(baseUrl) && !/^(o\d|gpt-5)/i.test(model.replace(/^.*\//, ''));

export type AiRouter = Endpoint & { model: string; headers: Record<string, string>; extra: Record<string, unknown> };

// Everything one AI call needs, or null when the user has not set AI up.
export const aiRouter = (feature: AiFeature): AiRouter | null => {
  const config = getAIConfig();
  const endpoint = getEndpoint();
  const model = modelFor(feature, config);
  if (!endpoint || !model) return null;
  return { ...endpoint, model, headers: aiHeaders(endpoint.baseUrl, endpoint.apiKey), extra: chatExtras(endpoint.baseUrl) };
};

// The fetched list is remembered so the picker still has options the next time
// Settings is opened, without another round trip.
const STORAGE_KEY_MODELS = 'linguaclip_ai_models';

export const getCachedModels = (): string[] => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_MODELS) || '[]');
    return Array.isArray(stored) ? stored.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    return [];
  }
};

// GET /models — every OpenAI-compatible provider exposes it (Claude and Gemini
// too, docs/ai-providers.md); used by "Fetch models" in Settings so the user need
// not type ids by hand. Embedding / speech / image models are dropped: none of them
// can answer a chat prompt. Gemini lists "models/gemini-…"; chat wants the bare id.
const NOT_CHAT = /embed|whisper|tts|dall-e|moderation|davinci|babbage|transcribe|realtime|audio|image|sora|aqa|imagen|veo/i;

export const tidyModelIds = (ids: string[]): string[] => {
  const bare = [...new Set(ids.map(id => id.replace(/^models\//, '')))];
  const chat = bare.filter(id => !NOT_CHAT.test(id));
  return (chat.length ? chat : bare).sort();
};

export const setCachedModels = (ids: string[]) => {
  try { localStorage.setItem(STORAGE_KEY_MODELS, JSON.stringify(ids)); } catch { /* ignore */ }
};

// Phone Settings → AI → tap another provider: park what the current one has
// (key, models, picks) under profiles, and bring back what the new one had last
// time — a model id never carries across providers.
export const switchProvider = (config: AIConfig, next: AiProvider, models: string[]): { config: AIConfig; models: string[] } => {
  const cur = providerOf(config);
  const parked: AIProfile = {
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
    segmentModel: config.segmentModel, featureModels: config.featureModels, models,
  };
  const profiles = { ...config.profiles, [cur]: parked };
  const back: AIProfile = (next === cur ? parked : profiles[next]) ?? {};
  return {
    config: {
      ...config,
      provider: next,
      profiles,
      baseUrl: next === 'custom' ? (back.baseUrl ?? '') : AI_PRESETS[next].baseUrl,
      apiKey: back.apiKey ?? '',
      model: back.model ?? '',
      segmentModel: back.segmentModel ?? '',
      featureModels: back.featureModels ?? {},
    },
    models: back.models ?? [],
  };
};

// `remember`: also store the list as the cached one (the phone stores it itself,
// after checking the answer is still for the provider on screen).
export const listModels = async (baseUrl: string, apiKey: string, remember = true): Promise<string[]> => {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}/models`, {
    headers: aiHeaders(baseUrl, apiKey, false),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await readJsonBody<{ data?: { id?: string }[] }>(res);
  const ids = tidyModelIds((body?.data ?? []).map(m => m?.id).filter((id): id is string => !!id));
  if (ids.length === 0) throw new Error('empty model list');
  if (remember) setCachedModels(ids);
  return ids;
};
