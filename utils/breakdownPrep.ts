import { fetch } from '@tauri-apps/plugin-http';
import { readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';
import { BREAKDOWN_MIN_WORDS, Breakdown, breakdownRules, clozeRouter, soundsOn, spaceWords, validateBreakdown } from './aiDrills';
import { readCacheText, writeCacheText } from './desktop';
import { parseSRT } from './srtParser';

// "Prepare break it down" from the shelf: every line of a video goes to the AI
// ahead of time, so the button in practice opens at once. Only the text is
// prepared here; the read-aloud clips are still made on click (useBreakdown).
// Results live in ~/Movies/LinguaClip/<id>.breakdown.json, keyed by line text.

// Each line asks for up to three notes, so answers run long: ten lines a batch
// keeps the model careful to the last line, and a bad answer only costs ten.
export const PREP_BATCH_LINES = 10;
const REQUEST_TIMEOUT_MS = 120_000;

export type BreakdownCache = { v: 1; lang: 'zh' | 'en'; lines: Record<string, Breakdown> };

const keyOf = (text: string) => spaceWords(text).join(' ');

// Unique lines long enough to break down, in order.
export function eligibleLines(subtitleText: string): string[] {
  const keys = parseSRT(subtitleText).map(s => keyOf(s.text));
  return [...new Set(keys.filter(k => spaceWords(k).length >= BREAKDOWN_MIN_WORDS))];
}

export function parseBreakdownCache(raw: string | null): BreakdownCache | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (data?.v !== 1 || (data.lang !== 'zh' && data.lang !== 'en') || typeof data.lines !== 'object' || !data.lines) return null;
    const lines: Record<string, Breakdown> = {};
    for (const [text, value] of Object.entries(data.lines)) {
      const ok = validateBreakdown(value, spaceWords(text).length);
      if (ok) lines[text] = ok;
    }
    return { v: 1, lang: data.lang, lines };
  } catch {
    return null;
  }
}

export function batchPrompt(lines: string[], lang: 'zh' | 'en'): string {
  const blocks = lines.map((text, li) => {
    const words = spaceWords(text);
    return `第 ${li} 句（${words.length} 个词）：\n${words.map((w, i) => `${i}\t${w}`).join('\n')}`;
  });
  return `下面有 ${lines.length} 句口语转录，每句按「序号<TAB>词」列出。

对每一句，挑出最值得学的 1 到 3 个点：固定搭配、短语动词、从句、时态或其他语法结构。
只输出 JSON，格式：{"lines":[{"lang":"en","points":[{"from":1,"to":3,"note":"…"}]${soundsOn() ? ',"sounds":[{"from":2,"to":3,"note":"…"}]' : ''}},{"lang":"en","points":[…]}]}
- lines 的长度必须等于 ${lines.length}，第 n 项对应第 n 句；序号都是该句自己的词序号。
${breakdownRules(lang)}

${blocks.join('\n\n')}`;
}

const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// A note must name its own phrase ("was looking for：…", as the prompt shows):
// an answer shifted onto the wrong line points at words the note never mentions.
function noteMatches(b: Breakdown, line: string): boolean {
  const words = spaceWords(line);
  return b.points.every(p => bare(p.note).includes(bare(words[p.from])));
}

// One answer per line, or null for a line whose answer broke a rule. A wrong
// count throws: the answers could be shifted onto the wrong lines.
export function parseBatchResponse(content: string, lines: string[]): (Breakdown | null)[] {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : content).match(/\{[\s\S]*\}/);
  if (!raw) throw new Error('no JSON');
  const items = JSON.parse(raw[0])?.lines;
  if (!Array.isArray(items) || items.length !== lines.length) throw new Error('wrong line count');
  return items.map((item, i) => {
    const b = validateBreakdown(item, spaceWords(lines[i]).length);
    return b && noteMatches(b, lines[i]) ? b : null;
  });
}

async function askBatch(lines: string[], lang: 'zh' | 'en'): Promise<(Breakdown | null)[]> {
  const router = clozeRouter();
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: batchPrompt(lines, lang) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseBatchResponse(content, lines);
}

export async function loadBreakdownCache(recordId: string): Promise<BreakdownCache | null> {
  return parseBreakdownCache(await readCacheText(recordId, 'breakdown'));
}

// The prepared answer for one line, whatever language it was prepared in.
export async function cachedBreakdown(recordId: string, lineText: string): Promise<Breakdown | null> {
  return (await loadBreakdownCache(recordId))?.lines[keyOf(lineText)] ?? null;
}

// --- Running jobs: module-level so leaving the shelf does not stop them ---

export type PrepJob = { done: number; total: number; cancelled?: boolean; saving?: Promise<void> };
const jobs = new Map<string, PrepJob>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());

export function getPrepJob(recordId: string): PrepJob | undefined {
  return jobs.get(recordId);
}

// Before a record's files go to the Trash: stop saving, and wait out a write
// already on its way so it cannot put the file back afterwards.
export async function cancelPrep(recordId: string): Promise<void> {
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}

export function subscribePrep(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Asks only for lines not prepared yet (all of them if the language changed),
// saving after every batch so practice can use a half-done job.
export async function prepareBreakdowns(recordId: string, subtitleText: string, lang: 'zh' | 'en'): Promise<void> {
  if (jobs.has(recordId)) return;
  const job: PrepJob = { done: 0, total: 0 };
  jobs.set(recordId, job);
  notify();
  try {
    const old = await loadBreakdownCache(recordId);
    const cache: BreakdownCache = old && old.lang === lang ? old : { v: 1, lang, lines: {} };
    const missing = eligibleLines(subtitleText).filter(k => !cache.lines[k]);
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += PREP_BATCH_LINES) batches.push(missing.slice(i, i + PREP_BATCH_LINES));
    job.total = batches.length;
    notify();
    // Writes are chained so an older snapshot never lands after a newer one.
    job.saving = Promise.resolve();
    const save = () => {
      if (job.cancelled) return;
      const body = JSON.stringify(cache);
      job.saving = job.saving!.then(() => (job.cancelled ? undefined : writeCacheText(recordId, 'breakdown', body))).catch(() => {});
    };
    await Promise.all(batches.map(lines => withAiSlot('breakdown', async () => {
      if (job.cancelled) return;
      let answers: (Breakdown | null)[] = [];
      try { answers = await askBatch(lines, lang); } catch {
        try { answers = await askBatch(lines, lang); } catch { /* these lines fall back to asking on click */ }
      }
      answers.forEach((a, i) => { if (a) cache.lines[lines[i]] = a; });
      if (answers.some(Boolean)) save();
      job.done++;
      notify();
    })));
    await job.saving;
  } finally {
    jobs.delete(recordId);
    notify();
  }
}

// How much of a video is still unprepared in this language, for the shelf.
export async function prepStatus(recordId: string, subtitleText: string, lang: 'zh' | 'en'): Promise<{ eligible: number; missing: number }> {
  const lines = eligibleLines(subtitleText);
  const cache = await loadBreakdownCache(recordId);
  const have = cache && cache.lang === lang ? cache.lines : {};
  return { eligible: lines.length, missing: lines.filter(k => !have[k]).length };
}
