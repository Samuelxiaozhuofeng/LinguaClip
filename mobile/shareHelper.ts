// Pure helpers for Android system share intake (M1.4):
// classifies incoming ACTION_SEND payloads (audio/video URI or podcast link text)
// and sanitizes external titles/text as plain strings (never HTML).
import { classifyPaste } from '../pro/podcastFeed';
import type { SharePayload } from './platform/androidBridge';

export type ShareIntent =
  | { kind: 'media'; uri: string; mime: string }
  | { kind: 'feed'; url: string }
  | { kind: 'apple'; id: string }
  | { kind: 'closed'; name: string }
  | { kind: 'unsupported' };

const DEFAULT_MAX_LEN = 160;
const TRAILING_PUNCT = /[.,;:!?'"\]\}>，。！？、；：“”‘’）】》」』…]+$/;

/** Strips control / bidi-override characters, normalizes whitespace, and truncates length. */
export function sanitizeShareText(raw: string, maxLen = DEFAULT_MAX_LEN): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (maxLen <= 0 || cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen).trimEnd();
}

/** Extracts the first http(s) URL from free-form share copy, trimming trailing punctuation / unmatched ')'. */
export function extractUrlFromShare(text: string): string | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const match = /https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef\u4e00-\u9fff]+/i.exec(text);
  if (!match) return null;
  let url = match[0];
  let prev = '';
  while (url && url !== prev) {
    prev = url;
    url = url.replace(TRAILING_PUNCT, '');
    while (url.endsWith(')')) {
      const opens = (url.match(/\(/g) ?? []).length;
      const closes = (url.match(/\)/g) ?? []).length;
      if (closes > opens) url = url.slice(0, -1);
      else break;
    }
  }
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url) ? url : null;
}

/** Classifies a SharePayload from Android ACTION_SEND into a concrete app intent. */
export function classifySharePayload(payload: SharePayload | null | undefined): ShareIntent {
  if (!payload || typeof payload !== 'object') return { kind: 'unsupported' };
  if (payload.kind === 'uri') {
    const uri = typeof payload.uri === 'string' ? payload.uri.trim() : '';
    if (!uri) return { kind: 'unsupported' };
    return { kind: 'media', uri, mime: sanitizeShareText(payload.mime ?? '', 80) };
  }
  if (payload.kind === 'text') {
    const raw = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!raw) return { kind: 'unsupported' };
    const direct = classifyPaste(raw);
    if (direct.kind !== 'bad') return direct;
    const url = extractUrlFromShare(raw);
    if (url) {
      const fromUrl = classifyPaste(url);
      if (fromUrl.kind !== 'bad') return fromUrl;
    }
  }
  return { kind: 'unsupported' };
}

/** Stable short-window deduplication key for cold-start getPendingShare vs hot shareReceived. */
export function shareDedupeKey(payload: SharePayload): string {
  return payload.kind === 'uri'
    ? `uri|${(payload.uri ?? '').trim()}`
    : `text|${(payload.text ?? '').trim()}`;
}
