// Groq transcription straight from the browser (docs/mobile-web.md「转录」): a file
// from the phone goes up as is, a podcast episode as its link. Every failure is
// thrown as an Error whose message is a code (same codes as the desktop's
// src-tauri/src/groq.rs, plus file:toolarge / cloud:nokey); the screen translates it.
import { getTranscribeConfig } from '../utils/transcribeConfig';
import type { GroqResp } from './cleanup';

const URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const MODEL = 'whisper-large-v3-turbo';
// Groq's free tier, for an upload and for a link alike (measured 10-10).
export const MAX_BYTES = 26214400;

// Settings → Groq key. Read the field itself: cloudKey() is empty while mode is 'local'.
export const groqKey = () => getTranscribeConfig().groqKey.trim();

// anchor.fm play links carry the real address, URL-encoded, at the end.
export function anchorUrl(url: string): string | null {
  const m = url.match(/anchor\.fm\/s\/[^/]+\/podcast\/play\/\d+\/(https?%3A.+)$/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

// Groq does not follow redirects and podcast links usually redirect: where the
// link ends up, or the link itself when the browser cannot tell.
export async function resolveUrl(url: string, signal: AbortSignal): Promise<string> {
  const anchor = anchorUrl(url);
  if (anchor) return anchor;
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
    r.body?.cancel().catch(() => {});
    return r.url || url;
  } catch (err) {
    if (signal.aborted) throw err;
    return url;
  }
}

// Groq could not fetch the episode's address (a redirect the phone could not see through):
// only the desktop app, which downloads it first, can do this one.
export const NO_MEDIA = 'cloud:nomedia';

function httpError(status: number, body: string): string {
  let msg = body.slice(0, 200);
  try { msg = JSON.parse(body)?.error?.message ?? msg; } catch { /* not json */ }
  if (status === 413 || /too large|size limit/i.test(msg)) return 'cloud:toolarge';
  if (/retrieve media|media_fetch|fetch media/i.test(`${msg} ${body.slice(0, 500)}`)) return NO_MEDIA;
  if (status === 401) return 'cloud:key';
  if (status === 429) return `cloud:quota:${msg}`;
  if (status === 403) return `cloud:denied:${msg}`;
  return `cloud:HTTP ${status} ${msg}`;
}

export type Source = { file: Blob; name: string } | { url: string };

// One request, one answer. An abort rejects with the AbortError itself.
export async function transcribe(source: Source, lang: string, signal: AbortSignal): Promise<GroqResp> {
  const key = groqKey();
  if (!key) throw new Error('cloud:nokey');
  if ('file' in source && source.file.size > MAX_BYTES) throw new Error('file:toolarge');
  const body = new FormData();
  if ('file' in source) body.append('file', source.file, source.name);
  else body.append('url', await resolveUrl(source.url, signal));
  body.append('model', MODEL);
  body.append('response_format', 'verbose_json');
  body.append('timestamp_granularities[]', 'word');
  body.append('timestamp_granularities[]', 'segment');
  body.append('temperature', '0');
  if (lang && lang !== 'auto') body.append('language', lang);
  let res: Response;
  let text: string;
  try {
    res = await fetch(URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body, signal });
    text = await res.text();
  } catch (err) {
    if (signal.aborted) throw err;
    throw new Error(`cloud:network:${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new Error(httpError(res.status, text));
  try {
    return JSON.parse(text) as GroqResp;
  } catch {
    throw new Error('cloud:bad answer');
  }
}
