import { Subtitle } from '../types';

// "00:01:02,500", "00:01:02.5" or "01:02,500" to seconds; NaN when it is none of these.
const timeToSeconds = (timeString: string): number => {
  const m = timeString.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/);
  if (!m) return NaN;
  const [, h = '0', min, sec, ms = '0'] = m;
  return Number(h) * 3600 + Number(min) * 60 + Number(sec) + Number(ms.padEnd(3, '0')) / 1000;
};

export const parseSRT = (data: string): Subtitle[] => {
  // Normalize line endings; a "blank" line holding spaces still ends a block
  const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalizedData.split(/\n[ \t\u00a0]*\n/);

  const subtitles: Subtitle[] = [];

  blocks.forEach((block) => {
    const lines = block.trim().split('\n');
    if (lines.length >= 2) {
      // Handle index (sometimes missing or weirdly formatted, so we rely on regex finding the timestamp)
      const timeLineIndex = lines.findIndex(line => line.includes('-->'));

      if (timeLineIndex >= 0) {
        const [startStr, endStr] = lines[timeLineIndex].split('-->');
        const startTime = timeToSeconds(startStr);
        const endTime = timeToSeconds(endStr);

        // Join the rest of the lines as text
        const textLines = lines.slice(timeLineIndex + 1);
        const text = textLines
          .join(' ')
          .replace(/<[^>]*>/g, '') // Remove HTML tags like <i> or <b> often found in SRT
          .trim();

        // A line that ends before it starts is broken: nothing to play.
        if (text && !isNaN(startTime) && !isNaN(endTime) && endTime >= startTime) {
          subtitles.push({ id: 0, startTime, endTime, text });
        }
      }
    }
  });

  // Everything downstream (lineAt, sections, practice order) assumes start order.
  subtitles.sort((a, b) => a.startTime - b.startTime);
  subtitles.forEach((s, i) => { s.id = i + 1; });
  return subtitles;
};

// A seek to a line's start can land a hair before it: still that line.
const EPS = 0.001;

// The last line that has started by `t` (-1 before the first). Lines are sorted by start.
export const lineAt = (lines: Subtitle[], t: number): number => {
  let lo = 0, hi = lines.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startTime <= t + EPS) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
};

// Did playback from `before` to `now` run past `end`? Same slack as lineAt: with the next line
// starting right at a line's end, lineAt already moves on EPS early, and a frame landing in that
// sliver would otherwise skip the stop (the line loop / pause at line end "not braking"). Every
// stop on one page uses this, so none of them is beaten to it by another one EPS earlier.
export const passed = (end: number, before: number, now: number) => before < end - EPS && now >= end - EPS;
export const lineEnded = (line: Subtitle, before: number, now: number) => passed(line.endTime, before, now);
