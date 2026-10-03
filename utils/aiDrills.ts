import { fetch } from '@tauri-apps/plugin-http';
import { ClozeLevel } from '../types';
import { getAIConfig, readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';
import { getRouter } from './resegment';
import { tokenizeText, getWordTokens } from './textTokenizer';
import { hasKana } from './japanese';

// Cloze drills: the model only returns word indices (never text), so it cannot
// rewrite a line, and every index can be checked against tokenizeText.

// Sized from the user's real subtitles: at ~8 words a line, a 1000-word batch
// swallowed up to 287 lines, and the model has to return exactly that many
// sub-arrays or the whole batch is thrown away. The line cap is the real guard
// here — the word cap alone does not bound how many answers we ask for at once.
export const BATCH_WORDS = 250;
export const BATCH_LINES = 25;
const REQUEST_TIMEOUT_MS = 90_000;

export function lineWordCount(text: string): number {
  return getWordTokens(tokenizeText(text)).length;
}

export function lineWords(text: string): string[] {
  return getWordTokens(tokenizeText(text)).map(w => w.value);
}

// djb2 — sync, no crypto.subtle. Unsigned hex so two runs of the same SRT match.
export function hashSrt(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export type LineBatch = { start: number; end: number };

export function batchLinesByWords(texts: string[], maxWords = BATCH_WORDS, maxLines = BATCH_LINES): LineBatch[] {
  const counts = texts.map(lineWordCount);
  const batches: LineBatch[] = [];
  let start = 0;
  let words = 0;
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    if (i > start && (words + n > maxWords || i - start >= maxLines)) {
      batches.push({ start, end: i });
      start = i;
      words = 0;
    }
    words += n;
  }
  if (start < texts.length) batches.push({ start, end: texts.length });
  return batches;
}

export function validateIndices(value: unknown, wordCount: number): number[] | null {
  if (!Array.isArray(value)) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (const item of value) {
    if (!Number.isInteger(item) || item < 0 || item >= wordCount || seen.has(item)) return null;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function extractLines(content: string): unknown[] {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : content;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no json');
  const parsed = JSON.parse(match[0]);
  if (!Array.isArray(parsed.lines)) throw new Error('no lines');
  return parsed.lines;
}

// Throws if the payload is not a lines array of the expected length (batch
// retry). A single bad sentence becomes null and leaves the rest of the batch.
export function parseClozeResponse(content: string, counts: number[]): (number[] | null)[] {
  const lines = extractLines(content);
  if (lines.length !== counts.length) throw new Error('lines length mismatch');
  return lines.map((line, i) => validateIndices(line, counts[i]));
}

// n: each line's box count when it was ranked. A Japanese line's count moves
// with its split (dictionary, AI check), and its indices with it.
export type ClozeCacheFile = { v: 1; srt: string; lines: unknown[]; n?: number[] };

export function parseClozeCache(raw: string, srtHash: string, counts: number[], texts?: string[]): (number[] | null)[] | null {
  let data: ClozeCacheFile;
  try { data = JSON.parse(raw); } catch { return null; }
  if (data?.v !== 1 || data.srt !== srtHash || !Array.isArray(data.lines)) return null;
  if (data.lines.length !== counts.length) return null;
  const n = Array.isArray(data.n) && data.n.length === counts.length ? data.n : null;
  // null, or [] for a line that has words (older caches saved failed batches
  // that way), means "not ranked yet" and gets asked again. So does a line
  // whose boxes changed since — or, in a file from before n, any Japanese line
  // (it was one box then).
  return data.lines.map((line, i) => {
    if (n ? n[i] !== counts[i] : !!texts && hasKana(texts[i])) return null;
    const ranked = validateIndices(line, counts[i]);
    return ranked && (ranked.length > 0 || counts[i] === 0) ? ranked : null;
  });
}

function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

export function pickBlanks(ranked: number[] | null | undefined, wordCount: number, level: ClozeLevel): number[] {
  if (level === 'full' || wordCount <= 0 || !ranked || ranked.length === 0) return range(wordCount);
  const n = level === 'easy' ? Math.min(3, wordCount) : Math.ceil(wordCount / 2);
  return ranked.slice(0, n);
}

type Router = { baseUrl: string; apiKey: string; model: string };

export function clozeRouter(): Router | null {
  return getRouter();
}

export function canCloze(): boolean {
  return clozeRouter() !== null;
}

function promptFor(texts: string[]): { prompt: string; counts: number[] } {
  const counts: number[] = [];
  const blocks = texts.map((text, li) => {
    const words = lineWords(text);
    counts.push(words.length);
    const listing = words.map((w, i) => `${i}\t${w}`).join('\n');
    return `第 ${li} 句（${words.length} 个词）：\n${listing}`;
  });
  const prompt = `下面有 ${texts.length} 句口语转录，每句是「序号<TAB>词」的清单。

请为每句选出最该练习听写的词。要求：
- 对每句给出一个按优先级排好序的下标数组（最该练的排前面），覆盖该句全部词，不重不漏。
- 只输出 JSON，格式：{"lines":[[3,0,1,...],[2,5,...],...]}
- lines 的长度必须等于 ${texts.length}，第 n 项对应第 n 句。
- 每个下标必须是该句词清单里出现过的整数序号。不要输出任何词的文本。

句子：
${blocks.join('\n\n')}`;
  return { prompt, counts };
}

async function askOnce(texts: string[]): Promise<(number[] | null)[]> {
  const router = clozeRouter();
  if (!router) throw new Error('no router configured');
  const { prompt, counts } = promptFor(texts);
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseClozeResponse(content, counts);
}

async function ask(texts: string[]): Promise<(number[] | null)[]> {
  try {
    return await askOnce(texts);
  } catch {
    return await askOnce(texts);
  }
}

export async function generateCloze(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  urgent?: () => boolean,
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  const results: (number[] | null)[] = texts.map(() => null);
  try {
    if (!canCloze()) return results;
    const groups = batchLinesByWords(texts);
    onProgress?.(0, groups.length);
    let done = 0;
    await Promise.all(groups.map(({ start, end }) => withAiSlot('cloze', async () => {
      try {
        const ranked = await ask(texts.slice(start, end));
        for (let j = 0; j < ranked.length; j++) results[start + j] = ranked[j];
      } catch {
        // this batch stays null → those lines practise as full write
      }
      done++;
      onProgress?.(done, groups.length);
    }, urgent)));
    return results;
  } catch {
    return results;
  }
}

export async function loadOrBuildCloze(opts: {
  lineTexts: string[];
  recordId: string | null;
  subtitleText: string;
  readText: (id: string) => Promise<string | null>;
  writeText: (id: string, text: string) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  urgent?: () => boolean;
}): Promise<(number[] | null)[]> {
  const counts = opts.lineTexts.map(lineWordCount);
  const srt = hashSrt(opts.subtitleText);
  let cached: (number[] | null)[] | null = null;
  if (opts.recordId) {
    try {
      const raw = await opts.readText(opts.recordId);
      if (raw) cached = parseClozeCache(raw, srt, counts, opts.lineTexts);
    } catch { /* missing cache is fine */ }
  }
  const result = cached ?? counts.map(() => null);
  // Only ask about lines not ranked yet: a failed batch retries next time
  // instead of being cached as "no blanks" for good.
  const missing = counts.flatMap((n, i) => (n > 0 && !result[i] ? [i] : []));
  if (missing.length === 0) return result;
  const generated = await generateCloze(missing.map(i => opts.lineTexts[i]), opts.onProgress, opts.urgent);
  missing.forEach((li, k) => { result[li] = generated[k] ?? null; });
  if (opts.recordId && generated.some(Boolean)) {
    const body = JSON.stringify({ v: 1, srt, lines: result, n: counts } satisfies ClozeCacheFile);
    try { await opts.writeText(opts.recordId, body); } catch { /* cache must not break practice */ }
  }
  return result;
}

// --- Break it down: pick the 1–3 things worth learning in one line ---
// The model returns word-index ranges into the line (split on spaces) plus one
// note per point. The notes are the only free text it writes and are never
// used to locate anything; any rule broken below throws the whole answer out.

// One short line, and the user is sitting there waiting on it.
const BREAKDOWN_TIMEOUT_MS = 30_000;
const MAX_POINT_WORDS = 6;
// Shorter lines are just dictated whole; no point asking about them.
export const BREAKDOWN_MIN_WORDS = 5;

export type BreakdownPoint = { from: number; to: number; note: string }; // words[from..to], inclusive
// sounds: what makes the line hard to hear (docs/breakdown.md). undefined = never
// asked (older caches), [] = asked and there is nothing, or the answer was unusable.
export type Breakdown = { lang: string; points: BreakdownPoint[]; sounds?: BreakdownPoint[] };
const MAX_SOUNDS = 3;

export const soundsOn = () => getAIConfig().breakdownSounds !== false;

// Lines are split on spaces, not tokenizeText: punctuation stays on its word
// ("Mary."), so a point's text is exactly what the user sees in the line.
export function spaceWords(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

// In order, no overlap, inside the line, at most MAX_POINT_WORDS, a note each.
function validRanges(list: unknown[], wordCount: number, wholeLineOk: boolean): BreakdownPoint[] | null {
  const out: BreakdownPoint[] = [];
  let prevTo = -1;
  for (const p of list) {
    const { from, to, note } = (p ?? {}) as { from?: unknown; to?: unknown; note?: unknown };
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    const f = from as number, t = to as number;
    if (f <= prevTo || t < f || t >= wordCount || t - f + 1 > MAX_POINT_WORDS) return null;
    if (!wholeLineOk && t - f + 1 >= wordCount) return null; // the whole line is the last step anyway
    if (typeof note !== 'string' || !note.trim()) return null;
    out.push({ from: f, to: t, note: note.trim() });
    prevTo = t;
  }
  return out;
}

export function validateSounds(value: unknown, wordCount: number): BreakdownPoint[] {
  return Array.isArray(value) && value.length <= MAX_SOUNDS ? validRanges(value, wordCount, true) ?? [] : [];
}

export function validateBreakdown(value: unknown, wordCount: number): Breakdown | null {
  const v = value as { lang?: unknown; points?: unknown; sounds?: unknown } | null;
  if (!v || typeof v.lang !== 'string' || !/^[a-z]{2}$/.test(v.lang) || !Array.isArray(v.points)) return null;
  if (v.points.length < 1 || v.points.length > 3) return null;
  const points = validRanges(v.points, wordCount, false);
  if (!points) return null;
  // A bad sounds list only costs the sounds; [] so it is not asked again.
  return v.sounds === undefined ? { lang: v.lang, points } : { lang: v.lang, points, sounds: validateSounds(v.sounds, wordCount) };
}

export function parseBreakdownResponse(content: string, wordCount: number): Breakdown | null {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : content;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return validateBreakdown(JSON.parse(match[0]), wordCount); } catch { return null; }
}

// One step per point in sentence order, then the whole line. Only the whole
// line has no note: it is practised on the video's own audio.
export type BreakdownStep = { text: string; note: string | null };

export function buildSteps(lineText: string, points: BreakdownPoint[]): BreakdownStep[] {
  const words = spaceWords(lineText);
  return [
    ...points.map(p => ({ text: words.slice(p.from, p.to + 1).join(' '), note: p.note })),
    { text: lineText, note: null },
  ];
}

// The rules shared by the one-line prompt and the batch one (utils/breakdownPrep.ts).
export function breakdownRules(lang: 'zh' | 'en'): string {
  const noteLang = lang === 'zh' ? '简体中文' : 'English';
  const example = lang === 'zh'
    ? '"was looking for：过去进行时 + look for（寻找），和后面的 when I saw 连用，表示「正在找的时候，突然看到」"'
    : '"was looking for: past continuous + look for (search for); paired with the later when I saw, it means \'in the middle of searching, suddenly saw\'"';
  return `- lang：这句话所用语言的 ISO 639-1 两字母小写代码（en、es、fr…）。
- from / to：这个点在句中连续的第一个和最后一个词的序号（含两端），最多 ${MAX_POINT_WORDS} 个词，不能是整句。按句中顺序排列，互不重叠。
- 如果一个结构在句中是断开的（如 was …ing … when …），只选其中最核心的连续几个词，在 note 里把整个结构讲清楚。
- note：用一两句简短的${noteLang}讲这个点的意思和用法，讲到语法结构这一层，例如 ${example}。
${soundsOn() ? soundsRules(lang) : ''}- JSON 以外不要输出任何文字。`;
}

function soundsRules(lang: 'zh' | 'en'): string {
  const noteLang = lang === 'zh' ? '简体中文' : 'English';
  const example = lang === 'zh' ? '"want to → wanna：to 弱读，和 want 连成一个音"' : '"want to → wanna: to is weakened and runs into want"';
  return `- sounds：这句里 0 到 ${MAX_SOUNDS} 处让人听不出来的地方（连读、弱读、吞音、失去爆破等），没有就给 []。每处 {"from":…,"to":…,"note":"…"}：from / to 是连续的第一个和最后一个词的序号（含两端），最多 ${MAX_POINT_WORDS} 个词，按句中顺序、互不重叠（和 points 各算各的）；note 用${noteLang}写成「原词 → 实际听到的样子：原因」，例如 ${example}。
`;
}

function breakdownPrompt(words: string[], lang: 'zh' | 'en'): string {
  const listing = words.map((w, i) => `${i}\t${w}`).join('\n');
  return `下面是一句口语转录，按「序号<TAB>词」列出，共 ${words.length} 个词。

挑出这句里最值得学的 1 到 3 个点：固定搭配、短语动词、从句、时态或其他语法结构。
只输出 JSON，格式：{"lang":"en","points":[{"from":1,"to":3,"note":"…"},{"from":6,"to":9,"note":"…"}]${soundsOn() ? ',"sounds":[{"from":2,"to":3,"note":"…"}]' : ''}}
${breakdownRules(lang)}

${listing}`;
}

// One short prompt to the router; the answer text, or null. A network hiccup
// gets one retry; an answer that fails the checks does not.
async function askShort(prompt: string): Promise<string | null> {
  const router = clozeRouter();
  if (!router) return null;
  const once = async (): Promise<string | null> => {
    const res = await fetch(`${router.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(BREAKDOWN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`router ${res.status}`);
    const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
    const content = body?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : null;
  };
  try { return await once(); } catch { try { return await once(); } catch { return null; } }
}

export async function askBreakdown(words: string[], lang: 'zh' | 'en'): Promise<Breakdown | null> {
  if (words.length === 0) return null;
  const content = await askShort(breakdownPrompt(words, lang));
  return content === null ? null : parseBreakdownResponse(content, words.length);
}

// Sounds only, for a line prepared before they were asked. null = no answer.
export async function askSounds(words: string[], lang: 'zh' | 'en'): Promise<BreakdownPoint[] | null> {
  if (words.length === 0) return null;
  const listing = words.map((w, i) => `${i}\t${w}`).join('\n');
  const content = await askShort(`下面是一句口语转录，按「序号<TAB>词」列出，共 ${words.length} 个词。

只输出 JSON，格式：{"sounds":[{"from":2,"to":3,"note":"…"}]}
${soundsRules(lang)}- JSON 以外不要输出任何文字。

${listing}`);
  const match = content?.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return validateSounds(JSON.parse(match[0])?.sounds, words.length); } catch { return null; }
}
