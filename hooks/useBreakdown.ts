import { useEffect, useRef, useState } from 'react';
import { Subtitle } from '../types';
import { BREAKDOWN_MIN_WORDS, BreakdownPoint, BreakdownStep, askBreakdown, askSounds, buildSteps, soundsOn, spaceWords } from '../utils/aiDrills';
import { cachedBreakdown } from '../utils/breakdownPrep';
import { Clip, loadClip, playClip, releaseClip, stopClip } from '../utils/speech';
import { getLang } from '../utils/i18n';

// "Break it down" for the current line: the AI picks 1–3 points, each practised
// on a clean read-aloud clip, then the whole line on the video's own audio.
// It never touches progress: the line index only moves when the user finishes
// the last step and Studio calls onContinue. A line prepared from the shelf
// (utils/breakdownPrep.ts) skips the AI wait; only its clips are made here.

export type BreakdownState =
  | { status: 'idle' }
  | { status: 'loading'; lineId: number }
  | { status: 'failed'; lineId: number }
  | { status: 'active'; lineId: number; steps: BreakdownStep[]; clips: Clip[]; step: number; reviewing: boolean; sounds?: BreakdownPoint[] };

export function useBreakdown(currentSub: Subtitle | undefined, recordId: string | null) {
  const [state, setState] = useState<BreakdownState>({ status: 'idle' });
  const seq = useRef(0);
  const clips = useRef<Clip[]>([]);

  const reset = () => {
    seq.current++;
    stopClip();
    clips.current.forEach(releaseClip);
    clips.current = [];
    setState({ status: 'idle' });
  };

  const lineId = currentSub?.id;
  useEffect(() => { reset(); }, [lineId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => reset, []); // eslint-disable-line react-hooks/exhaustive-deps

  const tooShort = !!currentSub && spaceWords(currentSub.text).length < BREAKDOWN_MIN_WORDS;

  const start = async () => {
    if (!currentSub || tooShort) return;
    const id = currentSub.id;
    const mine = ++seq.current;
    setState({ status: 'loading', lineId: id });
    const prepared = recordId ? await cachedBreakdown(recordId, currentSub.text) : null;
    const result = prepared ?? await askBreakdown(spaceWords(currentSub.text), getLang());
    if (mine !== seq.current) return;
    if (!result) { setState({ status: 'failed', lineId: id }); return; }
    const steps = buildSteps(currentSub.text, result.points);
    const loaded = await Promise.all(steps.slice(0, -1).map(s => loadClip(s.text, result.lang)));
    if (mine !== seq.current) { loaded.forEach(releaseClip); return; }
    clips.current = loaded;
    const sounds = soundsOn() ? result.sounds : undefined;
    setState({ status: 'active', lineId: id, steps, clips: loaded, step: 0, reviewing: false, sounds });
    // Prepared before sounds were asked: ask for them alone, in the background.
    if (soundsOn() && result.sounds === undefined) {
      const extra = await askSounds(spaceWords(currentSub.text), getLang());
      if (extra && mine === seq.current) setState(s => (s.status === 'active' ? { ...s, sounds: extra } : s));
    }
  };

  // Plays the current step's clip; false on the last step (the whole line),
  // which the caller plays from the video instead.
  const play = (): boolean => {
    if (state.status !== 'active') return false;
    const clip = state.clips[state.step];
    if (!clip) return false;
    playClip(clip);
    return true;
  };

  const review = () => setState(s => (s.status === 'active' ? { ...s, reviewing: true } : s));
  // Returns false once the last step (the whole line) is done.
  const next = (): boolean => {
    if (state.status !== 'active' || state.step >= state.steps.length - 1) return false;
    stopClip();
    setState(s => (s.status === 'active' ? { ...s, step: s.step + 1, reviewing: false } : s)); // keeps sounds that came in meanwhile
    return true;
  };

  return { state, tooShort, start, cancel: reset, play, review, next };
}
