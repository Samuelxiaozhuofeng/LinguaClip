import { fetch } from '@tauri-apps/plugin-http';
import { readJsonBody } from '../utils/aiConfig';
import { withAiSlot } from '../utils/aiLimit';
import { batchLinesByWords, clozeRouter, extractLines, hashSrt } from '../utils/aiDrills';
import { readCacheText, writeCacheText } from '../utils/desktop';

// The reader's folded translation: one line of the user's UI language per subtitle
// line, asked once per video and kept in ~/Movies/LinguaClip/<id>.trans.json. A
// background job per video like levelPrep.ts; lines whose batch failed stay null
// (asked again next time). Saved after every batch, so leaving early keeps what came.

const REQUEST_TIMEOUT_MS = 90_000;

export type TransTo = 'zh' | 'en';
export type TransCacheFile = { v: 1; srt: string; to: TransTo; lines: (string | null)[] };

const srtOf = (texts: string[]) => hashSrt(texts.join('\n'));

// Translations that came ready-made (a starter episode, docs/starter.md), saved as if asked for.
export const writeTransCache = (recordId: string, texts: string[], to: TransTo, lines: (string | null)[]): Promise<void> =>
  writeCacheText(recordId, 'trans', JSON.stringify({ v: 1, srt: srtOf(texts), to, lines } satisfies TransCacheFile));

// Throws when the payload is not a lines array of the right length (batch retry).
export function parseTransResponse(content: string, n: number): (string | null)[] {
  const lines = extractLines(content);
  if (lines.length !== n) throw new Error('lines length mismatch');
  return lines.map(l => (typeof l === 'string' && l.trim() ? l.trim() : null));
}

export function parseTransCache(raw: string, srt: string, to: TransTo, n: number): (string | null)[] | null {
  try {
    const data = JSON.parse(raw) as TransCacheFile;
    if (data?.v !== 1 || data.srt !== srt || data.to !== to || !Array.isArray(data.lines) || data.lines.length !== n) return null;
    return data.lines.map(l => (typeof l === 'string' && l ? l : null));
  } catch {
    return null;
  }
}

export function transPrompt(texts: string[], to: TransTo): string {
  const lang = to === 'zh' ? '简体中文' : 'English';
  return `下面是一段视频的连续字幕，共 ${texts.length} 句，每行是「序号<TAB>原文」。请把每句翻译成${lang}，给语言学习者对照理解用：意思准确、口语自然，结合上下文，不加解释。

只输出 JSON：{"lines":["…","…",...]}
- lines 的长度必须等于 ${texts.length}，第 n 项是第 n 句的译文。
- JSON 以外不要输出任何文字。

${texts.map((t, i) => `${i}\t${t.replace(/\s+/g, ' ')}`).join('\n')}`;
}

async function askOnce(texts: string[], to: TransTo): Promise<(string | null)[]> {
  const router = clozeRouter();
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: transPrompt(texts, to) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseTransResponse(content, texts.length);
}

// `lines` fills in as batches arrive; `failed` = some batch gave up this run.
export type TransJob = { lines: (string | null)[]; done: number; total: number; failed: boolean; cancelled?: boolean; saving: Promise<void>; promise: Promise<(string | null)[]> };
const jobs = new Map<string, TransJob>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

export const getTransJob = (recordId: string): TransJob | undefined => jobs.get(recordId);

export function subscribeTrans(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Before a record's files go to the Trash: a finishing job must not write the cache back.
export async function cancelTrans(recordId: string): Promise<void> {
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}

// Translations from the cache, plus the AI for lines still missing.
export function prepareTrans(recordId: string, texts: string[], to: TransTo): Promise<(string | null)[]> {
  const running = jobs.get(recordId);
  if (running) return running.promise;
  const job: TransJob = { lines: texts.map(() => null), done: 0, total: 0, failed: false, saving: Promise.resolve(), promise: Promise.resolve([]) };
  job.promise = (async () => {
    const srt = srtOf(texts);
    const raw = await readCacheText(recordId, 'trans').catch(() => null);
    const cached = raw && parseTransCache(raw, srt, to, texts.length);
    if (cached) { job.lines = cached; notify(); }
    const missing = job.lines.flatMap((l, i) => (l === null ? [i] : []));
    if (missing.length === 0 || !clozeRouter()) return job.lines;
    const groups = batchLinesByWords(missing.map(i => texts[i]));
    job.total = groups.length;
    notify();
    // Saves run one after another, each writing the whole file as it stands.
    const save = () => {
      if (job.cancelled) return;
      const text = JSON.stringify({ v: 1, srt, to, lines: job.lines } satisfies TransCacheFile);
      job.saving = job.saving.then(() => (job.cancelled ? undefined : writeCacheText(recordId, 'trans', text))).catch(() => {});
    };
    await Promise.all(groups.map(({ start, end }) => withAiSlot('cloze', async () => {
      if (job.cancelled) return;
      const idx = missing.slice(start, end);
      const batch = idx.map(i => texts[i]);
      try {
        const out = await askOnce(batch, to).catch(() => askOnce(batch, to));
        job.lines = job.lines.slice();
        idx.forEach((li, k) => { job.lines[li] = out[k]; });
        if (out.some(Boolean)) save();
      } catch {
        job.failed = true; // those lines stay null
      }
      job.done++;
      notify();
    }, () => true)));
    await job.saving;
    return job.lines;
  })().finally(() => {
    if (jobs.get(recordId) === job) jobs.delete(recordId);
    notify();
  });
  jobs.set(recordId, job);
  notify();
  return job.promise;
}
