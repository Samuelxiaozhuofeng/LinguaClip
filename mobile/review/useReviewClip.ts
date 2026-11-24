// Media resolver & <audio> stretch player for phone review cards (docs/mobile-web.md 8).
// Resolves original audio first and falls back to standalone clips/ when the source file is gone.
import React, { useEffect, useRef, useState } from 'react';
import type { ReviewCard } from '../../utils/review';
import { getVideoFromDB } from '../../utils/fileSystemAccess';
import { parseSRT } from '../../utils/srtParser';
import { hashSrt } from '../../utils/aiDrills';
import { parseTransCache } from '../../pro/transPrep';
import { getLang } from '../../utils/i18n';
import { hasKana } from '../../utils/japanese';
import type { Word } from '../../utils/resegment';
import { getWordTokens, targetWords, tokenizeText, TokenType } from '../../utils/textTokenizer';
import { playSpan, wordSpans, wordsInLine } from '../../utils/wordTimes';
import { prepareSrc, readCacheText, resolveCardClipSrc, videoSrcFromPath } from '../platform/desktop';

const countLetters = (s: string) => s.replace(/[^\p{L}\p{M}\p{N}]/gu, '').length;

// Pure PWA-safe copy of utils/wordAudio.ts's locateWord (avoids pulling desktop-only clipPath/cutClip into dist-mobile).
export function locateWordInLine(
  line: { text: string; startTime: number; endTime: number },
  word: string,
  words: Word[] | null,
): { from: number; to: number } | null {
  let range: [number, number] | null = null;
  const at = word && (hasKana(line.text) || /\p{Script=Han}/u.test(word)) ? line.text.indexOf(word) : -1;
  if (at >= 0) {
    range = [at, at + word.length];
  } else {
    const spans: [number, number][] = [];
    let off = 0;
    for (const tk of tokenizeText(line.text)) {
      if (tk.type === TokenType.WORD) spans.push([off, off + tk.value.length]);
      off += tk.value.length;
    }
    const picked = targetWords(getWordTokens(tokenizeText(line.text)).map(w => w.value), word);
    if (picked.length) range = [spans[picked[0]][0], spans[picked[picked.length - 1]][1]];
  }
  if (!range) return null;
  const pieces = [line.text.slice(0, range[0]), line.text.slice(range[0], range[1]), line.text.slice(range[1])];
  const parts = pieces.map((p, i) => ({ p, i })).filter(x => countLetters(x.p) > 0);
  const spans = wordSpans(parts.map(x => x.p), wordsInLine(words, line.startTime, line.endTime));
  const own = parts.findIndex(x => x.i === 1);
  let from: number, to: number;
  if (spans && own >= 0) {
    [from, to] = spans[own];
  } else {
    const all = countLetters(line.text) || 1;
    from = countLetters(pieces[0]) / all;
    to = (countLetters(pieces[0]) + countLetters(pieces[1])) / all;
  }
  const [a, b] = playSpan(line.startTime, line.endTime, from, to);
  return { from: a, to: b };
}

export type FoundCardMedia = {
  id: string;
  src: string | null;
  offset: number;
  trans: string | null;
};

export async function findCardMedia(c: ReviewCard): Promise<FoundCardMedia> {
  const rec = await getVideoFromDB(c.videoId).catch(() => null);
  const path = rec?.videoPath ?? c.videoPath;
  let src: string | null = null;
  let offset = 0;
  if (path) {
    try {
      await prepareSrc(path);
      src = videoSrcFromPath(path);
    } catch {
      src = null;
    }
  }
  if (!src && c.clip?.file) {
    try {
      const clipSrc = await resolveCardClipSrc(c.clip.file);
      if (clipSrc) {
        src = clipSrc;
        offset = c.clip.from;
      }
    } catch {
      src = null;
    }
  }
  let trans: string | null = null;
  if (rec && c.deck === 'line') {
    const lines = [...parseSRT(rec.subtitleText)].sort((a, b) => a.startTime - b.startTime);
    const texts = lines.map(l => l.text);
    const raw = await readCacheText(c.videoId, 'trans');
    const got = raw && parseTransCache(raw, hashSrt(texts.join('\n')), getLang() === 'en' ? 'en' : 'zh', texts.length);
    const i = lines.findIndex(l => Math.abs(l.startTime - c.start) < 0.01);
    trans = got && i >= 0 ? got[i] : null;
  }
  return { id: c.id, src, offset, trans };
}

export function useReviewClip() {
  const ref = useRef<HTMLAudioElement>(null);
  const stopAt = useRef<number | null>(null);
  const [bad, setBad] = useState<string | null>(null);

  const pendingGo = useRef<(() => void) | null>(null);
  const dropPending = () => {
    if (pendingGo.current) ref.current?.removeEventListener('loadedmetadata', pendingGo.current);
    pendingGo.current = null;
  };

  const play = (src: string, from: number, to: number) => {
    const a = ref.current;
    if (!a) return;
    dropPending();
    const go = () => {
      pendingGo.current = null;
      a.currentTime = Math.max(0, from);
      stopAt.current = to;
      a.play().catch(() => {});
    };
    if (a.getAttribute('src') !== src) {
      a.setAttribute('src', src);
      pendingGo.current = go;
      a.addEventListener('loadedmetadata', go, { once: true });
      a.load();
    } else {
      go();
    }
  };

  const stop = () => {
    dropPending(); // a card turned while its sound was still loading must stay quiet
    stopAt.current = null;
    ref.current?.pause();
  };

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const a = ref.current;
      if (a && stopAt.current !== null && a.currentTime >= stopAt.current) stop();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stop();
    };
  }, []);

  const node = React.createElement('audio', {
    ref,
    preload: 'auto',
    onError: () => setBad(ref.current?.getAttribute('src') ?? null),
  });
  return { play, stop, node, bad };
}
