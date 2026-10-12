// A Groq answer → timed words and lines, tidied the way the desktop import does:
// punctuation back onto the words (src-tauri/src/cloud_asr.rs `punctuate`), word
// times in order (word_order.rs `in_order`), and a phrase / line whisper wrote
// over and over kept once (repeat_fix.rs `collapse`). No re-transcribing here.
// Same inputs give the same output as the Rust: mobile/test-cleanup.mjs.
import type { Word } from '../utils/resegment';

export type Cue = { from: number; to: number; text: string };
export type GroqResp = {
  segments?: { start: number; end: number; text: string }[];
  words?: { word: string; start: number; end: number }[];
};

// import.rs is_cjk
const CJK = /[々぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/u;
const isCjk = (c: string) => CJK.test(c);
const isAlnum = (c: string) => /[\p{Alphabetic}\p{N}]/u.test(c);
const isSpace = (c: string) => /\s/u.test(c);

const ms = (s: number) => Math.round(Math.max(0, s) * 1000);

// ---- cloud_asr.rs ------------------------------------------------------------

// Groq's lines, as subtitles (empty ones skipped).
export function cuesOf(resp: GroqResp): Cue[] {
  return (resp.segments ?? [])
    .filter(s => s.text.trim())
    .map(s => ({ from: ms(s.start), to: Math.max(ms(s.end), ms(s.start)), text: s.text.trim() }));
}

// Groq's word list carries no punctuation; each word takes its spelling and the
// punctuation around it from the segment text. An entry not preceded by a space
// continues the previous word, except in Chinese / Japanese.
export function punctuate(resp: GroqResp): Word[] {
  const text = [...(resp.segments ?? []).map(s => s.text.trim()).join(' ')];
  const letters: [string, number][] = [];
  text.forEach((c, i) => { if (isAlnum(c)) for (const l of c.toLowerCase()) letters.push([l, i]); });
  const out: Word[] = [];
  let li = 0;
  let end = 0;
  for (const raw of resp.words ?? []) {
    const want = [...raw.word].filter(isAlnum).flatMap(c => [...c.toLowerCase()]);
    if (want.length === 0) continue;
    const from = ms(raw.start);
    const to = Math.max(ms(raw.end), ms(raw.start));
    let found = -1;
    for (let s = li; s < Math.min(letters.length, li + 40); s++) {
      if (s + want.length <= letters.length && want.every((ch, k) => letters[s + k][0] === ch)) { found = s; break; }
    }
    if (found < 0) {
      out.push({ w: raw.word.trim(), from, to });
      continue;
    }
    const s = found;
    let a = letters[s][1];
    let b = letters[s + want.length - 1][1] + 1;
    while (a > end && !isSpace(text[a - 1]) && !isAlnum(text[a - 1])) a--;
    while (b < text.length && !isSpace(text[b]) && !isAlnum(text[b])) b++;
    const joins = a > 0 && a === end && !isSpace(text[a - 1]) && out.length > 0 && !isCjk(text[letters[s][1]]);
    const piece = text.slice(Math.max(a, end), b).join('');
    if (joins) {
      const last = out[out.length - 1];
      last.w += piece;
      last.to = to;
    } else {
      out.push({ w: piece.trim(), from, to });
    }
    li = s + want.length;
    end = b;
  }
  return out;
}

// ---- word_order.rs -----------------------------------------------------------

// Small overlaps (≤ 1s) are nudged forward; bigger jumps are glitches: keep the
// longest run of start times that never goes back, drop the rest.
export function inOrder(input: Word[]): Word[] {
  const words = input.map(w => ({ ...w }));
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1].from;
    if (words[i].from < prev && words[i].from + 1000 >= prev) words[i].from = prev;
  }
  const tails: number[] = [];
  const parent: (number | null)[] = words.map(() => null);
  for (let i = 0; i < words.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (words[tails[mid]].from <= words[i].from) lo = mid + 1; else hi = mid;
    }
    parent[i] = lo > 0 ? tails[lo - 1] : null;
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
  }
  const keep = words.map(() => false);
  let at: number | null = tails.length ? tails[tails.length - 1] : null;
  while (at !== null) { keep[at] = true; at = parent[at]; }
  return words.filter((_, i) => keep[i]).map(w => ({ ...w, to: Math.max(w.to, w.from) }));
}

// ---- repeat_fix.rs (the "keep one copy" half) --------------------------------

const PHRASE_REPS = 4;
const MAX_UNIT = 40;
const LINE_REPS = 3;

// Lowercased words with their [start, end) in the text: each CJK character on
// its own, letters and digits run together, an apostrophe between letters stays.
export function tokens(text: string): [string, number, number][] {
  const out: [string, number, number][] = [];
  const chars: [number, string][] = [];
  for (let i = 0; i < text.length;) {
    const c = String.fromCodePoint(text.codePointAt(i)!);
    chars.push([i, c]);
    i += c.length;
  }
  let open = false;
  chars.forEach(([i, c], n) => {
    const end = i + c.length;
    const next = chars[n + 1]?.[1];
    const inner = (c === "'" || c === '’') && open && next !== undefined && isAlnum(next) && !isCjk(next);
    if (inner) {
      const t = out[out.length - 1];
      t[0] += "'";
      t[2] = end;
    } else if (isCjk(c)) {
      out.push([c, i, end]);
      open = false;
    } else if (isAlnum(c)) {
      if (open) {
        const t = out[out.length - 1];
        t[0] += c.toLowerCase();
        t[2] = end;
      } else {
        out.push([c.toLowerCase(), i, end]);
      }
      open = true;
    } else {
      open = false;
    }
  });
  return out;
}

export const key = (text: string) => tokens(text).map(t => t[0]);

// First phrase repeated PHRASE_REPS+ times in a row: [start, length, times].
function phraseLoop(toks: string[]): [number, number, number] | null {
  const n = toks.length;
  for (let s = 0; s < n; s++) {
    for (let u = 2; u <= MAX_UNIT; u++) {
      if (s + u * PHRASE_REPS > n) break;
      const unit = toks.slice(s, s + u);
      let periodic = false;
      for (let p = 1; p < u && !periodic; p++) {
        if (u % p === 0 && unit.every((t, i) => i < p || t === unit[i - p])) periodic = true;
      }
      if (periodic) continue;
      if (u < 3 && unit.every(t => [...t].every(isCjk))) continue;
      const same = (at: number) => unit.every((t, i) => toks[at + i] === t);
      let r = 1;
      while (s + u * (r + 1) <= n && same(s + u * r)) r++;
      if (r >= PHRASE_REPS) return [s, u, r];
    }
  }
  return null;
}

const linePhraseLoop = (text: string) => phraseLoop(key(text));

const sameKey = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

// Runs [a, b) of LINE_REPS+ identical lines.
function lineRuns(cues: Cue[]): [number, number][] {
  const keys = cues.map(c => key(c.text));
  const runs: [number, number][] = [];
  let a = 0;
  while (a < keys.length) {
    let b = a + 1;
    while (b < keys.length && sameKey(keys[b], keys[a])) b++;
    if (keys[a].length && b - a >= LINE_REPS) runs.push([a, b]);
    a = b;
  }
  return runs;
}

// Looping lines as cue index ranges [a, b), in order.
export function findLoops(cues: Cue[]): [number, number][] {
  const out = lineRuns(cues);
  cues.forEach((c, i) => {
    if (!out.some(([a, b]) => i >= a && i < b) && linePhraseLoop(c.text)) out.push([i, i + 1]);
  });
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

function owner(cues: Cue[], w: Word): number {
  const mid = Math.floor((w.from + w.to) / 2);
  const i = cues.findIndex(c => c.to > mid);
  return i >= 0 ? i : Math.max(0, cues.length - 1);
}

// Keeps one copy of every loop: the first of identical lines (with its words),
// the first of a repeated phrase (cut the same way in the words).
export function collapse(cues: Cue[], words: Word[] | null): { cues: Cue[]; words: Word[] | null } {
  const drop = cues.map(() => false);
  for (const [a, b] of lineRuns(cues)) for (let i = a + 1; i < b; i++) drop[i] = true;
  let kept: Word[] | null = null;
  if (words) {
    const owners = words.map(w => owner(cues, w));
    const keep = owners.map(o => !(drop[o] ?? false));
    for (let ci = 0; ci < cues.length; ci++) {
      if (drop[ci]) continue;
      for (;;) {
        const toks: [string, number][] = [];
        words.forEach((w, i) => { if (keep[i] && owners[i] === ci) for (const t of key(w.w)) toks.push([t, i]); });
        const found = phraseLoop(toks.map(t => t[0]));
        if (!found) break;
        const [s, u, r] = found;
        const firstTok = new Map<number, number>();
        toks.forEach(([, wi], k) => { if (!firstTok.has(wi)) firstTok.set(wi, k); });
        let removed = false;
        for (const [wi, k] of firstTok) {
          if (k >= s + u && k < s + u * r) { keep[wi] = false; removed = true; }
        }
        if (!removed) break;
      }
    }
    kept = words.filter((_, i) => keep[i]);
  }
  const out: Cue[] = [];
  cues.forEach((c, i) => {
    if (drop[i]) return;
    let text = c.text;
    for (let f = linePhraseLoop(text); f; f = linePhraseLoop(text)) {
      const [s, u, r] = f;
      const t = tokens(text);
      text = text.slice(0, t[s + u - 1][2]) + text.slice(t[s + u * r - 1][2]);
    }
    out.push({ ...c, text });
  });
  return { cues: out, words: kept };
}

const srtTime = (t: number) => {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
};

// repeat_fix.rs write_srt
export const writeSrt = (cues: Cue[]) =>
  cues.map((c, i) => `${i + 1}\n${srtTime(c.from)} --> ${srtTime(c.to)}\n${c.text}\n\n`).join('');

// The whole tidy-up of one answer: lines and words (null = no word times).
export function cleanUp(resp: GroqResp): { cues: Cue[]; words: Word[] | null } {
  const cues = cuesOf(resp);
  const ws = inOrder(punctuate(resp));
  const words = ws.length ? ws : null;
  if (findLoops(cues).length === 0) return { cues, words };
  const fixed = collapse(cues, words);
  return { cues: fixed.cues, words: fixed.words?.length ? fixed.words : null };
}
