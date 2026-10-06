import { fetch } from '@tauri-apps/plugin-http';
import { getAIConfig, readJsonBody } from './aiConfig';
import { withAiSlot } from './aiLimit';
import { clozeRouter, hashSrt } from './aiDrills';
import { readCacheText, writeCacheText } from './desktop';
import { getLang, type Lang } from './i18n';
import { findWord, keywordLines } from './keywordPrep';

// "This episode's phrases" in the reader (docs/phrases.md): phrasal verbs and set phrases,
// found by the AI in batches of ~400 words sent at once (bigger ones come back with fewer, kept in <id>.phrases.json.
// phrases: measured 21 / 34 / 54 on one episode at 1500 / 800 / 400 words, each ~3s).
// The model points — line number + the stretch as written there — and each is checked
// against that line; only base / meaning / note are its own words. One job per record.

const REQUEST_TIMEOUT_MS = 120_000;
const BATCH_WORDS = 400;

export type Phrase = { line: number; start: number; text: string; at: number; base: string; meaning: string; note: string };
export type Phrases = { v: 1; srt: string; lang: Lang; items: Phrase[] };
type Line = { text: string; startTime: number };

const cjk = /[぀-ヿ㐀-鿿가-힯]/;
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const srtOf = (lines: Line[]) => hashSrt(lines.map(l => l.text).join('\n'));
const wordsIn = (text: string) => (cjk.test(text) ? Math.ceil(text.length / 2) : text.split(/\s+/).filter(Boolean).length);

// Whole lines, ~BATCH_WORDS each: [from, to) line numbers. A short tail joins the batch before.
export function phraseBatches(lines: Line[], size = BATCH_WORDS): [number, number][] {
  const out: [number, number][] = [];
  let from = 0, count = 0;
  lines.forEach((l, i) => {
    count += wordsIn(l.text);
    if (count >= size) { out.push([from, i + 1]); from = i + 1; count = 0; }
  });
  if (from < lines.length) {
    if (out.length && count < size / 4) out[out.length - 1][1] = lines.length;
    else out.push([from, lines.length]);
  }
  return out;
}

// Throws on a broken answer (retried, then the whole job fails). An item not found in its
// line is dropped; none at all is a real answer (this stretch has no phrases).
export function parsePhraseResponse(content: string, lines: Line[], from: number, to: number): Phrase[] {
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fence ? fence[1] : content).match(/\{[\s\S]*\}/);
  if (!raw) throw new Error('no JSON');
  const data = JSON.parse(raw[0]) as { items?: unknown };
  if (!Array.isArray(data?.items)) throw new Error('bad shape');
  const seen = new Set<string>();
  const out: Phrase[] = [];
  for (const item of data.items as Record<string, unknown>[]) {
    const line = item?.line;
    const text = clip(item?.text, 61).normalize('NFC');
    if (!Number.isInteger(line) || (line as number) < from || (line as number) >= to || !text || text.length > 60) continue;
    const l = lines[line as number];
    // The same stretch twice in a line: each item takes the next place not yet taken.
    let at = findWord(l.text, text);
    while (at >= 0 && seen.has(`${line}|${at}`)) at = findWord(l.text, text, at + 1);
    if (at < 0) continue;
    seen.add(`${line}|${at}`);
    const written = l.text.slice(at, at + text.length);
    out.push({ line: line as number, start: l.startTime, text: written, at, base: clip(item.base, 60) || written, meaning: clip(item.meaning, 40), note: clip(item.note, 80) });
  }
  return out;
}

// A saved file still fits these subtitles: same text, each item still where it was.
export function parsePhraseCache(raw: string | null, lines: Line[]): Phrases | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as Phrases;
    if (data?.v !== 1 || data.srt !== srtOf(lines) || !Array.isArray(data.items)) return null;
    const items = data.items.filter((p: Phrase) => {
      if (!p || typeof p !== 'object' || !Number.isInteger(p.line) || !Number.isInteger(p.at) || typeof p.start !== 'number'
        || typeof p.text !== 'string' || !p.text || typeof p.base !== 'string' || typeof p.meaning !== 'string' || typeof p.note !== 'string') return false;
      const l = lines[p.line];
      return !!l && Math.abs(l.startTime - p.start) < 0.01 && l.text.slice(p.at, p.at + p.text.length).toLowerCase() === p.text.toLowerCase();
    }).map(({ line, start, text, at, base, meaning, note }) => ({ line, start, text, at, base: base || text, meaning, note }));
    return { ...data, items };
  } catch {
    return null;
  }
}

export function phrasePrompt(lines: Line[], from: number, to: number, lang: Lang): string {
  const rows = lines.slice(from, to).map((l, k) => `${from + k}\t${l.text.replace(/\s+/g, ' ')}`);
  const out = lang === 'zh' ? '简体中文' : 'English';
  return `下面是一段视频 / 播客字幕，每行是「序号<TAB>原文」。

请找出其中所有值得学习者注意的词组：动词短语（如 pick up、crack on with、give away）、习语、固定搭配和固定说法。不要单个的词、人名、地名。每次出现都列一项（同一个词组出现在不同句子就列多项）。每项：
- line：它所在那一句的序号（整数）。
- text：它在那一句里**原样连续**的一段，一字不改；被拆开的（picked it up）就给包括中间部分的整段。
- base：词典原形（pick up、make a cock-up），用原文语言。
- meaning：它在这句语境里的意思，用${out}，12 个字 / 6 个词以内。
- note：一句备注（语气、用法或这里为什么这么说），用${out}，30 个字 / 15 个词以内。

只输出 JSON：{"items":[{"line":12,"text":"…","base":"…","meaning":"…","note":"…"}]}
没有就输出 {"items":[]}。JSON 以外不要输出任何文字。

${rows.join('\n')}`;
}

async function askOnce(lines: Line[], from: number, to: number, lang: Lang): Promise<Phrase[]> {
  const router = clozeRouter();
  if (!router) throw new Error('no router configured');
  const res = await fetch(`${router.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${router.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: router.model, messages: [{ role: 'user', content: phrasePrompt(lines, from, to, lang) }] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`router ${res.status}`);
  const body = await readJsonBody<{ choices?: { message?: { content?: string } }[] }>(res);
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('no content in response');
  return parsePhraseResponse(content, lines, from, to);
}

export const phrasesOn = (): boolean => getAIConfig().autoPhrases === true;

type Job = { cancelled?: boolean; saving?: Promise<void>; promise: Promise<Phrases | null> };
const jobs = new Map<string, Job>();

// The saved file if it fits, else the AI. null = none this time (no AI, or a batch failed:
// nothing is written, the next open tries again). One job per record.
export function preparePhrases(recordId: string, subtitleText: string): Promise<Phrases | null> {
  const running = jobs.get(recordId);
  if (running) return running.promise;
  const job: Job = { promise: Promise.resolve(null) };
  job.promise = (async () => {
    const lines = keywordLines(subtitleText);
    const saved = parsePhraseCache(await readCacheText(recordId, 'phrases').catch(() => null), lines);
    if (saved || !lines.length || !clozeRouter()) return saved;
    const lang = getLang();
    // ponytail: all batches or nothing; keep per-batch results if long films fail often.
    // Deleted meanwhile, or another batch already failed (the whole job is lost): a batch still
    // queued or about to retry asks nothing and stops jumping the queue. A retry waits a moment (rate limits).
    let dead = false;
    const live = () => !job.cancelled && !dead;
    const ask = (a: number, b: number) => (live() ? askOnce(lines, a, b, lang) : Promise.reject(new Error('stopped')));
    const retry = (a: number, b: number) => new Promise(r => setTimeout(r, 1500)).then(() => ask(a, b));
    const got = await Promise.all(phraseBatches(lines).map(([a, b]) =>
      withAiSlot('cloze', () => ask(a, b).catch(() => retry(a, b)), live))).catch(() => { dead = true; return null; });
    if (!got || job.cancelled) return null;
    const file: Phrases = { v: 1, srt: srtOf(lines), lang, items: got.flat() };
    job.saving = writeCacheText(recordId, 'phrases', JSON.stringify(file)).catch(() => {});
    await job.saving;
    return file;
  })().finally(() => { if (jobs.get(recordId) === job) jobs.delete(recordId); });
  jobs.set(recordId, job);
  return job.promise;
}

// Just the saved file, without asking the AI.
export async function readPhrases(recordId: string, subtitleText: string): Promise<Phrases | null> {
  return parsePhraseCache(await readCacheText(recordId, 'phrases').catch(() => null), keywordLines(subtitleText));
}

// Before a record's files go to the Trash: a finishing job must not write its file back.
export async function forgetPhrases(recordId: string): Promise<void> {
  const job = jobs.get(recordId);
  if (!job) return;
  job.cancelled = true;
  await job.saving;
}
