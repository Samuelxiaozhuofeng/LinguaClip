import { fetch } from '@tauri-apps/plugin-http';
import { getAIConfig, getEndpoint, readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';

// Whisper breaks a transcript wherever its decoder happened to stop, which
// regularly lands you a 12-second, 30-word line. Dictation on a line that long
// stops testing listening and starts testing memory. So we hand the word list
// to a model, ask only for cut points (never for text — it cannot mangle words
// it is not allowed to rewrite), and rebuild the SRT around those cuts.

export type Word = { w: string; from: number; to: number };

const TARGET_WORDS = 10;   // what we ask each line to be
const MAX_WORDS = 16;      // hard ceiling we enforce ourselves
const BATCH_WORDS = 250;   // one model call; keeps it counting reliably
const TAIL_MS = 400;       // whisper's end times run a touch early
const REQUEST_TIMEOUT_MS = 90_000;

// Only the user's own AI settings: the segment model if set, else the main one.
type Router = { baseUrl: string; apiKey: string; model: string };

export function getRouter(): Router | null {
  const config = getAIConfig();
  const endpoint = getEndpoint();
  const model = config.segmentModel?.trim() || config.model?.trim();
  if (!endpoint || !model) return null;
  return { ...endpoint, model };
}

export function canResegment(): boolean {
  return getRouter() !== null;
}

const ENDS_SENTENCE = /[.!?。！？…]["')\]]?$/;

// Split into model-sized batches, preferring a sentence end so a batch boundary
// is never also a bad cut point.
function batches(words: Word[]): Word[][] {
  const out: Word[][] = [];
  let start = 0;
  while (start < words.length) {
    let end = Math.min(start + BATCH_WORDS, words.length);
    if (end < words.length) {
      for (let i = end; i > start + BATCH_WORDS / 2; i--) {
        if (ENDS_SENTENCE.test(words[i - 1].w)) { end = i; break; }
      }
    }
    out.push(words.slice(start, end));
    start = end;
  }
  return out;
}

function prompt(words: Word[]): string {
  const listing = words.map((w, i) => `${i}\t${w.w}`).join('\n');
  return `下面是一段口语转录的逐词清单，每行是「序号<TAB>词」。

请把它切成一系列短句，供听写练习使用。要求：
- 每段目标 ${TARGET_WORDS} 个词左右（6-14 之间浮动），不得出现超过 ${MAX_WORDS} 个词的段。
- 切点必须落在语义自然的地方：句末、从句边界、连词前、意群之间。绝不能把一个固定搭配或介词短语劈开。
- 必须覆盖全部词，不重不漏。

只输出 JSON，格式为每段起始词的序号数组，第一个必须是 0：
{"starts":[0,11,23,...]}

逐词清单：
${listing}`;
}

function readBody(parsed: { choices?: { message?: { content?: string } }[] }): string {
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return content;
}

function readStarts(content: string, count: number): number[] {
  const match = content.match(/\{[^{}]*"starts"[^{}]*\}/s);
  if (!match) throw new Error('no starts array');
  const starts = JSON.parse(match[0]).starts;
  if (!Array.isArray(starts) || starts.length === 0) throw new Error('starts not an array');
  if (starts[0] !== 0) throw new Error('starts must begin at 0');
  for (let i = 0; i < starts.length; i++) {
    const n = starts[i];
    if (!Number.isInteger(n) || n < 0 || n >= count) throw new Error('start out of range');
    if (i > 0 && n <= starts[i - 1]) throw new Error('starts not increasing');
  }
  return starts;
}

// Where a batch the model failed on gets cut: after every sentence end.
export function ruleStarts(words: Word[]): number[] {
  const starts = [0];
  for (let i = 1; i < words.length; i++) if (ENDS_SENTENCE.test(words[i - 1].w)) starts.push(i);
  return starts;
}

const MIN_PIECE = 3;
const ENDS_CLAUSE = /[,;:—]["'”’)\]]?$/;

// Cut point for words[a..b): after in-sentence punctuation, else at the longest
// pause, else evenly; each side keeps at least MIN_PIECE words, ties go to the
// one nearest the middle so a line is not nibbled three words at a time.
function cutPoint(words: Word[], a: number, b: number): number {
  const mid = (a + b) / 2;
  const cands: number[] = [];
  for (let c = a + MIN_PIECE; c <= b - MIN_PIECE; c++) cands.push(c);
  const nearest = (cs: number[]) => cs.reduce((x, y) => (Math.abs(y - mid) < Math.abs(x - mid) ? y : x));
  const punct = cands.filter(c => ENDS_CLAUSE.test(words[c - 1].w));
  if (punct.length) return nearest(punct);
  const gap = (c: number) => words[c].from - words[c - 1].to;
  const longest = Math.max(...cands.map(gap));
  if (longest > 0) return nearest(cands.filter(c => gap(c) === longest));
  return a + Math.ceil((b - a) / Math.ceil((b - a) / MAX_WORDS));
}

// Keeps the ceiling a promise rather than a request: any line over MAX_WORDS is
// cut again until every piece fits.
export function enforceCeiling(starts: number[], words: Word[]): number[] {
  const out: number[] = [];
  const split = (a: number, b: number) => {
    if (b - a <= MAX_WORDS) { out.push(a); return; }
    const c = cutPoint(words, a, b);
    split(a, c);
    split(c, b);
  };
  starts.forEach((a, i) => split(a, i + 1 < starts.length ? starts[i + 1] : words.length));
  return out;
}

async function askOnce(words: Word[]): Promise<number[]> {
  // Without a deadline a router that accepts the connection and then goes quiet
  // leaves the import stuck on "shaping lines" with no way out.
  const router = getRouter();
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: prompt(words) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  return readStarts(readBody(await readJsonBody(res)), words.length);
}

async function ask(words: Word[]): Promise<number[]> {
  try {
    return await askOnce(words);
  } catch {
    return await askOnce(words); // one retry: the router 500s now and then
  }
}

const stamp = (ms: number): string => {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3600000);
  const m = Math.floor(clamped / 60000) % 60;
  const s = Math.floor(clamped / 1000) % 60;
  const milli = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
};

// Whisper's word times carry roughly a word of slop, so each line runs on until
// the next one begins (capped, so a genuine pause is not dead air). Nothing
// spoken falls between two lines that way.
export function buildSrt(words: Word[], starts: number[]): string {
  const blocks: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i];
    const b = i + 1 < starts.length ? starts[i + 1] : words.length;
    const slice = words.slice(a, b);
    if (slice.length === 0) continue;
    const text = slice.map(w => w.w).join(' ').trim();
    if (!text) continue;
    const from = slice[0].from;
    const ownEnd = slice[slice.length - 1].to;
    const nextStart = b < words.length ? words[b].from : Infinity;
    const to = Math.max(from + 1, Math.min(nextStart, ownEnd + TAIL_MS));
    blocks.push(`${blocks.length + 1}\n${stamp(from)} --> ${stamp(to)}\n${text}\n`);
  }
  return blocks.join('\n');
}

// Chinese / Japanese words arrive one character or kana run each, so the model
// cannot see where a word ends and cuts through the middle of them ("向か / おうよ").
// whisper's own lines there are whole sentences already: keep them.
const CJK = /[\u3005\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u;
export function mostlyCjk(words: Word[]): boolean {
  return words.filter(w => CJK.test(w.w)).length * 2 > words.length;
}

// Returns null only when there is no AI, nothing to cut, CJK, or a bug; the
// caller then keeps whisper's own line breaks. A batch the model fails on is
// cut at sentence ends instead, so one bad call no longer sinks the rest.
export async function resegment(words: Word[]): Promise<string | null> {
  if (words.length === 0 || mostlyCjk(words)) return null;
  // No AI configured: same sentence-end cut + ceiling the failed batches get.
  if (!canResegment()) {
    const srt = buildSrt(words, enforceCeiling(ruleStarts(words), words));
    return srt.trim() ? srt : null;
  }
  try {
    const groups = batches(words);
    // An hour of speech is a dozen-odd calls at ~12s each; run them side by
    // side (up to the user's cap) so a long video is not stuck here for minutes.
    const offsets: number[] = [];
    let running = 0;
    for (const group of groups) { offsets.push(running); running += group.length; }
    // Two failures in a row and batches not yet sent skip the AI. braked is
    // sticky so a slow success landing later cannot lift the brake; calls
    // already in flight are left to finish.
    let streak = 0;
    let braked = false;
    const results = await Promise.all(groups.map(g => withAiSlot('segment', async () => {
      if (braked) return ruleStarts(g);
      try {
        const starts = await ask(g);
        streak = 0;
        return starts;
      } catch (err) {
        console.error('resegment batch failed, cutting at sentence ends:', err);
        if (++streak >= 2) braked = true;
        return ruleStarts(g);
      }
    })));
    const starts: number[] = [];
    results.forEach((local, i) => { for (const n of local) starts.push(offsets[i] + n); });
    const srt = buildSrt(words, enforceCeiling(starts, words));
    return srt.trim() ? srt : null;
  } catch (err) {
    console.error('resegment failed, keeping whisper line breaks:', err);
    return null;
  }
}
