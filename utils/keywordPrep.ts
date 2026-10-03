import { fetch } from '@tauri-apps/plugin-http';
import { getAIConfig, readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';
import { clozeRouter, hashSrt } from './aiDrills';
import { readCacheText, writeCacheText } from './desktop';
import { parseSRT } from './srtParser';
import { getLang, type Lang } from './i18n';

// "This episode's keywords" (docs/keywords.md): a two-sentence summary and up to 15 words,
// asked once per record and kept in ~/Movies/LinguaClip/<id>.keywords.json. The model
// points at words — line number + the word as written there — and each is checked against
// that line; only the meaning / note / summary are its own words. One job per record:
// the import's end, the practice panel and the listening page all share it.

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_WORDS = 15;
const MAX_INPUT_WORDS = 20_000;

export type Keyword = { line: number; start: number; word: string; at: number; meaning: string; note: string };
export type Keywords = { v: 1; srt: string; lang: Lang; summary: string; words: Keyword[] };
type Line = { text: string; startTime: number };

const srtOf = (lines: Line[]) => hashSrt(lines.map(l => l.text).join('\n'));
export const keywordLines = (subtitleText: string) => parseSRT(subtitleText);

const cjk = /[぀-ヿ㐀-鿿가-힯]/;
const letter = /[\p{L}\p{M}\p{N}]/u;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

// Where the word sits in the line (first time), or -1. Latin letters: any case, whole word
// only; with Chinese / Japanese / Korean in it, a plain substring (no spaces to go by).
export function findWord(text: string, word: string): number {
  const hay = text.toLowerCase(), needle = word.toLowerCase();
  if (!needle) return -1;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (cjk.test(word)) return at;
    if (!letter.test(hay[at - 1] ?? '') && !letter.test(hay[at + needle.length] ?? '')) return at;
  }
  return -1;
}

function extractJson(content: string): unknown {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : content).match(/\{[\s\S]*\}/);
  if (!raw) throw new Error('no JSON');
  return JSON.parse(raw[0]);
}

// Throws on a broken answer (retried, then the job fails); a word that isn't in its
// line is dropped. No word left counts as broken: never kept as "no keywords".
export function parseKeywordResponse(content: string, lines: Line[]): { summary: string; words: Keyword[] } {
  const data = extractJson(content) as { summary?: unknown; words?: unknown };
  const summary = clip(data?.summary, 300);
  if (!summary || !Array.isArray(data.words)) throw new Error('bad shape');
  const seen = new Set<string>();
  const words: Keyword[] = [];
  for (const item of data.words as Record<string, unknown>[]) {
    if (words.length >= MAX_WORDS) break;
    const line = item?.line;
    const word = clip(item?.word, 41).normalize('NFC');
    if (!Number.isInteger(line) || (line as number) < 0 || (line as number) >= lines.length || !word || word.length > 40) continue;
    const l = lines[line as number];
    const at = findWord(l.text, word);
    const key = word.toLowerCase();
    if (at < 0 || seen.has(key)) continue;
    seen.add(key);
    words.push({ line: line as number, start: l.startTime, word: l.text.slice(at, at + word.length), at, meaning: clip(item.meaning, 40), note: clip(item.note, 80) });
  }
  if (words.length === 0) throw new Error('no word found in its line');
  return { summary, words };
}

// A saved file still fits these subtitles: same text, each word still where it was.
export function parseKeywordCache(raw: string | null, lines: Line[]): Keywords | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Keywords;
    if (data?.v !== 1 || data.srt !== srtOf(lines) || typeof data.summary !== 'string' || !data.summary || !Array.isArray(data.words)) return null;
    // Item by item, every field its type: a bad one is dropped, never rendered.
    const words = data.words.filter((w: Keyword) => {
      if (!w || typeof w !== 'object' || !Number.isInteger(w.line) || !Number.isInteger(w.at) || typeof w.start !== 'number'
        || typeof w.word !== 'string' || !w.word || typeof w.meaning !== 'string' || typeof w.note !== 'string') return false;
      const l = lines[w.line];
      return !!l && Math.abs(l.startTime - w.start) < 0.01 && l.text.slice(w.at, w.at + w.word.length).toLowerCase() === w.word.toLowerCase();
    }).map(({ line, start, word, at, meaning, note }) => ({ line, start, word, at, meaning, note }));
    return words.length ? { ...data, words } : null;
  } catch {
    return null;
  }
}

export function keywordPrompt(lines: Line[], lang: Lang): string {
  const rows: string[] = [];
  let count = 0;
  for (let i = 0; i < lines.length && count < MAX_INPUT_WORDS; i++) {
    const text = lines[i].text.replace(/\s+/g, ' ');
    count += cjk.test(text) ? Math.ceil(text.length / 2) : text.split(' ').length;
    rows.push(`${i}\t${text}`);
  }
  const out = lang === 'zh' ? '简体中文' : 'English';
  return `下面是一集视频 / 播客的字幕，每行是「序号<TAB>原文」。

学习者看之前想先知道这集讲什么、有哪些值得先认识的词。请给出：
1. summary：两句话的本集摘要，用${out}写。
2. words：最多 ${MAX_WORDS} 个关键词——对理解这集最要紧、学习者可能不认识的词或固定短语（不要人名、地名、太简单的词）。每项：
   - line：这个词出现的那一句的序号（整数）。
   - word：这个词在那一句里**原样**的写法，一字不改（不还原原形，不改拼写，可以是 2–4 个词的短语）。
   - meaning：它在这句里的意思，用${out}，10 个字 / 5 个词以内。
   - note：一句备注（用法、搭配或语气），用${out}，30 个字 / 15 个词以内。

只输出 JSON：{"summary":"…","words":[{"line":12,"word":"…","meaning":"…","note":"…"}]}
JSON 以外不要输出任何文字。

${rows.join('\n')}`;
}

async function askOnce(lines: Line[], lang: Lang): Promise<{ summary: string; words: Keyword[] }> {
  const router = clozeRouter();
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: keywordPrompt(lines, lang) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parseKeywordResponse(content, lines);
}

export const keywordsOn = (): boolean => getAIConfig().autoKeywords === true;

type Job = { urgent: boolean; cancelled?: boolean; saving?: Promise<void>; promise: Promise<Keywords | null> };
const jobs = new Map<string, Job>();

// Just the saved file, without asking the AI.
export async function readKeywords(recordId: string, subtitleText: string): Promise<Keywords | null> {
  return parseKeywordCache(await readCacheText(recordId, 'keywords').catch(() => null), keywordLines(subtitleText));
}

export const keywordsRunning = (recordId: string): boolean => jobs.has(recordId);

// The saved file if it fits, else the AI (when set up). null = none this time (no AI,
// or it failed: nothing is written, the next open tries again). One job per record.
export function prepareKeywords(recordId: string, subtitleText: string, urgent = false): Promise<Keywords | null> {
  const running = jobs.get(recordId);
  if (running) { running.urgent ||= urgent; return running.promise; }
  const job: Job = { urgent, promise: Promise.resolve(null) };
  job.promise = (async () => {
    const lines = keywordLines(subtitleText);
    const saved = parseKeywordCache(await readCacheText(recordId, 'keywords').catch(() => null), lines);
    if (saved || !lines.length || !clozeRouter()) return saved;
    const lang = getLang();
    const got = await withAiSlot('cloze', () => askOnce(lines, lang).catch(() => askOnce(lines, lang)), () => job.urgent).catch(() => null);
    if (!got || job.cancelled) return null;
    const file: Keywords = { v: 1, srt: srtOf(lines), lang, ...got };
    job.saving = writeCacheText(recordId, 'keywords', JSON.stringify(file)).catch(() => {});
    await job.saving;
    return file;
  })().finally(() => { if (jobs.get(recordId) === job) jobs.delete(recordId); });
  jobs.set(recordId, job);
  return job.promise;
}

// The listening page's card shows once per episode: ids it has shown for.
const SEEN_KEY = 'linguaclip_keywords_seen';
const readSeen = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const writeSeen = (ids: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(ids)); } catch { /* full: shows again */ } };
export const keywordsSeen = (recordId: string): boolean => readSeen().includes(recordId);
export const markKeywordsSeen = (recordId: string) => { const ids = readSeen(); if (!ids.includes(recordId)) writeSeen([...ids, recordId]); };

// Before a record's files go to the Trash: a finishing job must not write its file back.
export async function forgetKeywords(recordId: string): Promise<void> {
  if (keywordsSeen(recordId)) writeSeen(readSeen().filter(id => id !== recordId));
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}
