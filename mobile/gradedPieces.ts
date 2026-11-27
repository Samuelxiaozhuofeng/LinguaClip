// Pure graded-piece filtering and grouping shared by phone dictation and review faces
// (docs/dictation-judge.md): suppresses `extra` tokens already paired into a `near` miss
// within the same unmatched gap between `ok` anchors so a near-miss word is never marked twice.
import type { Piece } from './dictation';

export interface PieceGroup {
  key: number;
  piece?: Piece;
  punct: string;
}

/**
 * Filters out `extra` pieces (and their immediately following synthetic space) that were
 * already paired into a `near` miss inside the same unmatched gap between `ok` anchors.
 */
export function filterPairedNearExtras(pieces: Piece[]): Piece[] {
  const skip = new Set<number>();
  let gapStart = 0;

  const flushGap = (gapEnd: number) => {
    const nearCounts = new Map<string, number>();
    for (let i = gapStart; i < gapEnd; i++) {
      const p = pieces[i];
      if (p.kind === 'miss' && p.near && p.typed) {
        nearCounts.set(p.typed, (nearCounts.get(p.typed) ?? 0) + 1);
      }
    }
    if (nearCounts.size === 0) return;
    for (let i = gapStart; i < gapEnd; i++) {
      const p = pieces[i];
      if (p.kind === 'extra') {
        const left = nearCounts.get(p.s) ?? 0;
        if (left > 0) {
          nearCounts.set(p.s, left - 1);
          skip.add(i);
          if (i + 1 < gapEnd && pieces[i + 1].kind === 'text' && !pieces[i + 1].s.trim()) {
            skip.add(i + 1);
          }
        }
      }
    }
  };

  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i].kind === 'ok') {
      flushGap(i);
      gapStart = i + 1;
    }
  }
  flushGap(pieces.length);

  if (skip.size === 0) return pieces;
  return pieces.filter((_, i) => !skip.has(i));
}

/** Groups filtered graded pieces with trailing punctuation attached to the preceding word piece. */
export function groupGradedPieces(pieces: Piece[]): PieceGroup[] {
  const filtered = filterPairedNearExtras(pieces);
  const out: PieceGroup[] = [];
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    if (p.kind === 'text') {
      const trimmed = p.s.trim();
      if (!trimmed) continue;
      if (out.length > 0 && out[out.length - 1].piece && out[out.length - 1].piece!.kind !== 'extra') {
        out[out.length - 1].punct += trimmed;
      } else {
        out.push({ key: i, punct: trimmed });
      }
      continue;
    }
    out.push({ key: i, piece: p, punct: '' });
  }
  return out;
}
