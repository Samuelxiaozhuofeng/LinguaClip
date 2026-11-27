// Read-only cached line translations for phone practice ways (never calls AI on the fly).
// Picks up starter translations or previously generated translations from <id>.trans.json / cache,
// and listens to any already-running transPrep job without starting a new one.
import { useEffect, useMemo, useState } from 'react';
import type { Subtitle } from '../../types';
import { getTransJob, parseTransCache, subscribeTrans, type TransTo } from '../../pro/transPrep';
import { hashSrt } from '../../utils/aiDrills';
import { useLang } from '../../utils/i18n';
import { readCacheText } from '../platform/desktop';

export function useCachedTrans(recordId: string, lines: Subtitle[]): (string | null)[] | null {
  const uiLang = useLang();
  const to: TransTo = uiLang === 'en' ? 'en' : 'zh';
  const texts = useMemo(() => lines.map(l => l.text), [lines]);
  const srtHash = useMemo(() => hashSrt(texts.join('\n')), [texts]);
  const [trans, setTrans] = useState<(string | null)[] | null>(null);

  useEffect(() => {
    setTrans(null);
    if (!texts.length) return;
    let live = true;
    const running = getTransJob(recordId);
    if (running && running.lines.length === texts.length) {
      setTrans(running.lines);
    }
    readCacheText(recordId, 'trans').then(raw => {
      if (!live) return;
      const parsed = raw ? parseTransCache(raw, srtHash, to, texts.length) : null;
      if (parsed) setTrans(parsed);
    }).catch(() => {});
    const unsub = subscribeTrans(() => {
      const job = getTransJob(recordId);
      if (live && job && job.lines.length === texts.length) {
        setTrans(job.lines);
      }
    });
    return () => {
      live = false;
      unsub();
    };
  }, [recordId, texts, srtHash, to]);

  return trans;
}
