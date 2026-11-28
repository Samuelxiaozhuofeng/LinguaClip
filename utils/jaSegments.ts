import { fetch } from '@tauri-apps/plugin-http';
import { aiRouter } from './aiConfig';
import { getAIConfig, readJsonBody } from './aiConfig';
import { extractLines } from './aiDrills';
import { withAiSlot } from './aiLimit';
import { readCacheText, writeCacheText } from './desktop';
import { getVideoRecord } from './videoStorage';
import { hasKana, jaMorphs, loadJa, setJaCuts } from './japanese';

// The AI check of Japanese phrase splits, one background job per video, saved
// in <id>.segments.json as { v:1, lines: { [line text]: group start offsets | null } }.
// The model only answers which fragment starts each phrase — numbers, never
// text — and a line whose answer breaks a rule keeps the dictionary's split
// (null: asked again next time).

type SegFile = { v: 1; lines: Record<string, number[] | null> };
type SegJob = { done: number; total: number; urgent: boolean; cancelled?: boolean; saving?: Promise<void>; promise: Promise<void> };

const BATCH_LINES = 25;
const BATCH_MORPHS = 300;
const REQUEST_TIMEOUT_MS = 90_000;

const jobs = new Map<string, SegJob>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

export const getSegJob = (recordId: string) => jobs.get(recordId);
export function subscribeSeg(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export const jaCheckOn = () => !!getAIConfig().jaSegmentAi && aiRouter('segment') !== null;

const validOffsets = (v: unknown, len: number): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((n, i) => Number.isInteger(n) && n >= 0 && n < len && (i === 0 || n > v[i - 1]));

async function readFile(recordId: string): Promise<SegFile['lines']> {
  const raw = await readCacheText(recordId, 'segments').catch(() => null);
  if (!raw) return {};
  try {
    const data = JSON.parse(raw);
    return data?.v === 1 && data.lines && typeof data.lines === 'object' ? data.lines : {};
  } catch {
    return {};
  }
}

const apply = (lines: SegFile['lines']) =>
  setJaCuts(Object.entries(lines).filter((e): e is [string, number[]] => validOffsets(e[1], e[0].length)));

// Every screen that counts boxes goes through here first, so they all count the
// same split. false = the video has Japanese lines but no dictionary: callers
// then leave those lines alone (no blanks read or written for the video).
export async function settleSplits(recordId: string | null, lineTexts: string[], runCheck = false): Promise<boolean> {
  if (!lineTexts.some(hasKana)) return true;
  if (!await loadJa()) return false;
  if (!recordId) return true;
  if (runCheck && jaCheckOn()) await prepareSegments(recordId, lineTexts).catch(() => {});
  else apply(await readFile(recordId));
  return true;
}

// Before a record's files go to the Trash: a finishing job must not write the file back.
export async function cancelSegments(recordId: string): Promise<void> {
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}

export function prepareSegments(recordId: string, lineTexts: string[], urgent = false): Promise<void> {
  const running = jobs.get(recordId);
  if (running) { running.urgent ||= urgent; return running.promise; }
  const job: SegJob = { done: 0, total: 0, urgent, promise: Promise.resolve() };
  job.promise = run(recordId, lineTexts, job).finally(() => {
    if (jobs.get(recordId) === job) jobs.delete(recordId);
    notify();
  });
  jobs.set(recordId, job);
  notify();
  return job.promise;
}

async function run(recordId: string, lineTexts: string[], job: SegJob): Promise<void> {
  if (!await loadJa()) return;
  const lines = await readFile(recordId);
  apply(lines);
  // One word has nothing to group; lines seen before are not asked again.
  const todo = [...new Set(lineTexts)].filter(text =>
    hasKana(text) && !validOffsets(lines[text], text.length) && (jaMorphs(text)?.filter(m => !m.punct).length ?? 0) > 1);
  if (todo.length === 0 || !jaCheckOn()) return;
  const batches: string[][] = [];
  let cur: string[] = [];
  let n = 0;
  for (const text of todo) {
    const k = jaMorphs(text)!.filter(m => !m.punct).length;
    if (cur.length && (cur.length >= BATCH_LINES || n + k > BATCH_MORPHS)) { batches.push(cur); cur = []; n = 0; }
    cur.push(text);
    n += k;
  }
  if (cur.length) batches.push(cur);
  job.total = batches.length;
  let answered = false;
  notify();
  await Promise.all(batches.map(batch => withAiSlot('segment', async () => {
    try {
      const answers = await ask(batch).catch(() => ask(batch));
      batch.forEach((text, i) => { lines[text] = answers[i]; });
      answered = true;
    } catch {
      // this batch keeps the dictionary's split; asked again next time
    }
    job.done++;
    notify();
  }, () => job.urgent)));
  // Deleted meanwhile (even before this job could be cancelled): write nothing back.
  if (!answered || !await getVideoRecord(recordId).catch(() => null)) return;
  if (job.cancelled) return; // checked after the await: a delete may have come in during it
  job.saving = writeCacheText(recordId, 'segments', JSON.stringify({ v: 1, lines } satisfies SegFile)).catch(() => {});
  await job.saving;
  apply(lines);
}

export function segmentPrompt(batch: string[]): string {
  const blocks = batch.map((text, li) => {
    const words = jaMorphs(text)!.filter(m => !m.punct);
    return `第 ${li} 句：${text}\n${words.map((m, i) => `${i}\t${m.s}`).join('\n')}`;
  });
  return `下面有 ${batch.length} 句日语，每句已被切成最小的片段，按「序号<TAB>片段」列出（标点已去掉）。

这些句子用于听写练习，每个词组一个输入格。请把每句的片段合并成词组：
- 一个词组 = 一个实词（名词、动词、形容词、副词、感叹词等）加上紧跟在它后面的助词、助动词、词尾，例如「今日は」「天気ですね」「行きませんか」「食べさせられたくなかった」「やめとけって」。
- 复合词、专有名词、外来语不要拆开（「スマートフォンを」「東京オリンピックの」各是一个词组）。
- 前缀和它后面的词在一起（「お茶を」）。

对每句给出每个词组第一个片段的序号，从 0 开始、严格递增。
只输出 JSON，格式：{"lines":[[0,2,5],[0,3],...]}，lines 的长度必须等于 ${batch.length}，第 n 项对应第 n 句。不要输出任何片段的文字。

${blocks.join('\n\n')}`;
}

// Throws when the reply is not a lines array of the right length (the batch is
// retried); a single bad line becomes null.
export function parseSegmentResponse(content: string, batch: string[]): (number[] | null)[] {
  const lines = extractLines(content);
  if (lines.length !== batch.length) throw new Error('lines length mismatch');
  return lines.map((starts, i) => {
    const words = jaMorphs(batch[i])!.filter(m => !m.punct);
    const ok = Array.isArray(starts) && starts[0] === 0 &&
      starts.every((n, j) => Number.isInteger(n) && n < words.length && (j === 0 || n > starts[j - 1]));
    return ok ? (starts as number[]).map(j => words[j].at) : null;
  });
}

async function ask(batch: string[]): Promise<(number[] | null)[]> {
  const router = aiRouter('segment');
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: router.headers,
    body: JSON.stringify({ model: router.model, ...router.extra, messages: [{ role: 'user', content: segmentPrompt(batch) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseSegmentResponse(content, batch);
}
