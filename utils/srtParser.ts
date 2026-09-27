import { Subtitle } from '../types';

// Helper to convert SRT timestamp (00:00:00,000) to seconds
const timeToSeconds = (timeString: string): number => {
  const [time, milliseconds] = timeString.split(',');
  const [hours, minutes, seconds] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds + Number(milliseconds) / 1000;
};

export const parseSRT = (data: string): Subtitle[] => {
  // Normalize line endings
  const normalizedData = data.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const blocks = normalizedData.split('\n\n');
  
  const subtitles: Subtitle[] = [];
  let idCounter = 1;

  blocks.forEach((block) => {
    const lines = block.trim().split('\n');
    if (lines.length >= 2) {
      // Handle index (sometimes missing or weirdly formatted, so we rely on regex finding the timestamp)
      let timeLineIndex = 0;
      const timeMatch = lines.find((line, index) => {
        if (line.includes('-->')) {
          timeLineIndex = index;
          return true;
        }
        return false;
      });

      if (timeMatch) {
        const [startStr, endStr] = timeMatch.split('-->').map((s) => s.trim());
        const startTime = timeToSeconds(startStr);
        const endTime = timeToSeconds(endStr);

        // Join the rest of the lines as text
        const textLines = lines.slice(timeLineIndex + 1);
        const text = textLines
          .join(' ')
          .replace(/<[^>]*>/g, '') // Remove HTML tags like <i> or <b> often found in SRT
          .trim();

        if (text && !isNaN(startTime) && !isNaN(endTime)) {
          subtitles.push({
            id: idCounter++,
            startTime,
            endTime,
            text,
          });
        }
      }
    }
  });

  return subtitles;
};

// The last line that has started by `t` (-1 before the first). Lines are sorted by start.
export const lineAt = (lines: Subtitle[], t: number): number => {
  let lo = 0, hi = lines.length - 1, at = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].startTime <= t + 0.001) { at = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return at;
};
