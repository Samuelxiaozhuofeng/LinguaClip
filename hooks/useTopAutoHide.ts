// The practice page's top bar (back + name + parts, line count): shows for a moment on entry,
// then only with the pointer near the top or on the bar, so the picture stays clear while you work.
// Only the pills hide: the bar itself stays hit-testable, so the window drag region always works.
import { useEffect, useState } from 'react';

const INTRO_MS = 2500; // same as the watch page: long enough to find the bar on entry
const TOP_ZONE = 88; // px from the top edge that bring the bar up

export function useTopAutoHide() {
  const [intro, setIntro] = useState(true);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setIntro(false), INTRO_MS);
    return () => window.clearTimeout(id);
  }, []);
  const onMouseMove = (e: React.MouseEvent) => {
    const top = e.clientY < TOP_ZONE || !!(e.target as Element).closest?.('header');
    setNear(n => (n === top ? n : top));
  };
  const onMouseLeave = () => setNear(false);
  return { showTop: intro || near, onMouseMove, onMouseLeave };
}
