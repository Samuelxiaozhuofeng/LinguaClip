import { fetch } from '@tauri-apps/plugin-http';
import { aiRouter } from './aiConfig';
import { readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';
import { batchLinesByWords, clozeRouter, extractLines, hashSrt } from './aiDrills';
import { readCacheText, writeCacheText } from './desktop';
import { LineLabel, validateLabel } from './customPick';

// Custom practice's AI step: one CEFR level (or "not worth it") per line, asked
// once per video and kept in ~/Movies/LinguaClip/<id>.levels.json. The model
// only returns codes, each checked against a closed list. A background job per
// video, like clozePrep.ts; it shares the cloze calls' in-flight cap.

const REQUEST_TIMEOUT_MS = 90_000;

type Line = { text: string; startTime: number; endTime: number };
export type LevelCacheFile = { v: 1; srt: string; lines: LineLabel[] };

const srtOf = (lines: Line[]) => hashSrt(lines.map(l => l.text).join('\n'));

// Throws when the payload is not a lines array of the right length (batch
// retry); one bad code only nulls that line.
export function parseLevelResponse(content: string, n: number): LineLabel[] {
  const lines = extractLines(content);
  if (lines.length !== n) throw new Error('lines length mismatch');
  return lines.map(validateLabel);
}

export function parseLevelCache(raw: string, srt: string, n: number): LineLabel[] | null {
  try {
    const data = JSON.parse(raw) as LevelCacheFile;
    if (data?.v !== 1 || data.srt !== srt || !Array.isArray(data.lines) || data.lines.length !== n) return null;
    return data.lines.map(validateLabel);
  } catch {
    return null;
  }
}

const isCjk = (text: string) => /[぀-ヿ一-鿿]/.test(text);

export function levelPrompt(lines: Line[]): string {
  const rows = lines.map((l, i) => {
    const sec = Math.max(l.endTime - l.startTime, 0.1);
    const pace = isCjk(l.text)
      ? `${((l.text.match(/\p{L}/gu) ?? []).length / sec).toFixed(1)} 字/秒`
      : `${(l.text.split(/\s+/).filter(Boolean).length / sec).toFixed(1)} 词/秒`;
    return `${i}\t${sec.toFixed(1)} 秒\t${pace}\t${l.text.replace(/\s+/g, ' ')}`;
  });
  return `下面是一段视频的连续字幕，共 ${lines.length} 句，每行是「序号<TAB>时长<TAB>语速<TAB>原文」。

学习者要用这些句子做听写。请按「只听声音、听懂并写出这句有多难」给每句一个 CEFR 等级：A1 A2 B1 B2 C1 C2。综合看：生词和习语、语法结构、语速（越快越难）、连读吞音和口语省略。
不值得练的句子标 "x"：只有语气词或感叹（嗯、Oh、Yeah）、只喊人名、歌词或唱歌、音效或音乐标记、断成半截没有意思的碎片。

只输出 JSON：{"lines":["B1","x","A2",...]}
- lines 的长度必须等于 ${lines.length}，第 n 项对应第 n 句。
- 每项只能是 "A1" "A2" "B1" "B2" "C1" "C2" "x" 之一。
- JSON 以外不要输出任何文字。

${rows.join('\n')}`;
}

async function askOnce(lines: Line[]): Promise<LineLabel[]> {
  const router = aiRouter('cloze');
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: router.headers,
    body: JSON.stringify({ model: router.model, ...router.extra, messages: [{ role: 'user', content: levelPrompt(lines) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseLevelResponse(content, lines.length);
}

type LevelJob = { done: number; total: number; urgent: boolean; cancelled?: boolean; saving?: Promise<void>; promise: Promise<LineLabel[]> };
const jobs = new Map<string, LevelJob>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

export const getLevelJob = (recordId: string): LevelJob | undefined => jobs.get(recordId);

export function subscribeLevels(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Before a record's files go to the Trash: a finishing job must not write the cache back.
export async function cancelLevels(recordId: string): Promise<void> {
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}

// Just the saved labels (null lines where none), without asking the AI.
export async function readLevels(recordId: string, lines: Line[]): Promise<LineLabel[] | null> {
  const raw = await readCacheText(recordId, 'levels').catch(() => null);
  return raw ? parseLevelCache(raw, srtOf(lines), lines.length) : null;
}

// Labels from the cache, plus the AI for lines still unlabelled. Lines whose
// batch failed stay null (asked again next time), never saved as "x".
export function prepareLevels(recordId: string, lines: Line[], urgent = false): Promise<LineLabel[]> {
  const running = jobs.get(recordId);
  if (running) { running.urgent ||= urgent; return running.promise; }
  const job: LevelJob = { done: 0, total: 0, urgent, promise: Promise.resolve([]) };
  job.promise = (async () => {
    const srt = srtOf(lines);
    const raw = await readCacheText(recordId, 'levels').catch(() => null);
    const labels = (raw && parseLevelCache(raw, srt, lines.length)) || lines.map((): LineLabel => null);
    const missing = labels.flatMap((l, i) => (l === null ? [i] : []));
    if (missing.length === 0 || !clozeRouter()) return labels;
    const groups = batchLinesByWords(missing.map(i => lines[i].text));
    job.total = groups.length;
    notify();
    let got = false;
    await Promise.all(groups.map(({ start, end }) => withAiSlot('cloze', async () => {
      const idx = missing.slice(start, end);
      const batch = idx.map(i => lines[i]);
      try {
        const out = await askOnce(batch).catch(() => askOnce(batch));
        idx.forEach((li, k) => { labels[li] = out[k]; });
        got ||= out.some(Boolean);
      } catch { /* those lines stay null */ }
      job.done++;
      notify();
    }, () => job.urgent)));
    if (got && !job.cancelled) {
      job.saving = writeCacheText(recordId, 'levels', JSON.stringify({ v: 1, srt, lines: labels } satisfies LevelCacheFile)).catch(() => {});
      await job.saving;
    }
    return labels;
  })().finally(() => {
    if (jobs.get(recordId) === job) jobs.delete(recordId);
    notify();
  });
  jobs.set(recordId, job);
  notify();
  return job.promise;
}
