// Collapsible "This episode's keywords" card at the top of the phone's Read page (docs/keywords.md, M2.3).
// Reuses utils/keywordPrep.ts (<id>.keywords.json). Hidden silently when no AI key / not generated / turned off.
// Speaker buttons use speakWordAux (dict recording -> Edge TTS -> falls back to playing the keyword's line).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Subtitle, VideoRecord } from '../../types';
import { getAIConfig } from '../../utils/aiConfig';
import { canCloze } from '../../utils/aiDrills';
import type { DictLang } from '../../utils/dictionary';
import { useT } from '../../utils/i18n';
import {
  keywordLines,
  keywordsOn,
  prepareKeywords,
  readKeywords,
  type Keyword,
  type Keywords,
} from '../../utils/keywordPrep';
import { addWordIfNew, getAllCards, wordCardId } from '../../utils/review';
import { CAN_SPEAK_WORD, speakWordAux } from '../platform/wordPlatform';

const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

const SpeakerSvg: React.FC<{ active: boolean }> = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={active ? 'animate-pulse' : ''}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

export const KeywordsCard: React.FC<{
  record: VideoRecord;
  lines: Subtitle[];
  lang: DictLang | null;
  onJumpLine: (line: Subtitle) => void;
  onPlayLine: (line: Subtitle) => void;
}> = ({ record, lines, lang, onJumpLine, onPlayLine }) => {
  const t = useT();
  const [data, setData] = useState<Keywords | 'wait' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  const [kept, setKept] = useState<Set<string> | 'error' | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    let live = true;
    setData(null);
    setPicked(null);
    if (getAIConfig().autoKeywords === false) return () => { live = false; };
    readKeywords(record.id, record.subtitleText).then(saved => {
      if (!live) return;
      if (saved) { setData(saved); return; }
      if (!keywordsOn() || !canCloze()) return;
      setData('wait');
      prepareKeywords(record.id, record.subtitleText, true)
        .then(k => { if (live) setData(k); }, () => { if (live) setData(null); });
    }, () => { /* unreadable cache: stay hidden */ });
    return () => { live = false; };
  }, [record.id, record.subtitleText]);

  useEffect(() => {
    if (!expanded || data === null || data === 'wait') return;
    let live = true;
    getAllCards()
      .then(cards => {
        if (live) setKept(new Set(cards.filter(c => c.deck === 'word' && c.videoId === record.id).map(c => c.id)));
      })
      .catch(() => { if (live) setKept('error'); });
    return () => { live = false; };
  }, [expanded, data, record.id]);

  const parsedLines = useMemo(() => keywordLines(record.subtitleText), [record.subtitleText]);
  const lineById = useMemo(() => new Map(lines.map(l => [l.id, l])), [lines]);

  if (!data) return null;

  const idOf = (k: Keyword) => wordCardId(record.id, k.start, k.word);
  const subOf = (k: Keyword): Subtitle | null => {
    const raw = parsedLines[k.line];
    return raw ? (lineById.get(raw.id) ?? raw) : null;
  };

  const speakKeyword = async (k: Keyword) => {
    const id = idOf(k);
    const sub = subOf(k);
    setSpeakingId(id);
    let ok = false;
    if (CAN_SPEAK_WORD && lang) {
      ok = await speakWordAux(k.word, lang);
    }
    if (!aliveRef.current) return;
    setSpeakingId(cur => (cur === id ? null : cur));
    if (!ok && sub) onPlayLine(sub);
  };

  const saveKeyword = (k: Keyword) => {
    const id = idOf(k);
    const sub = subOf(k);
    if (!(kept instanceof Set) || kept.has(id) || busyId === id || !sub) return;
    setBusyId(id);
    const definition = `<b>${esc(k.word)}</b><br/>${esc(k.meaning)}${k.note ? `<br/>${esc(k.note)}` : ''}`;
    addWordIfNew(
      { videoId: record.id, videoName: record.videoFileName, text: sub.text, start: sub.startTime, end: sub.endTime },
      k.word,
      definition,
    )
      .then(() => { if (aliveRef.current) setKept(s => (s instanceof Set ? new Set(s).add(id) : s)); })
      .catch(console.error)
      .finally(() => { if (aliveRef.current) setBusyId(cur => (cur === id ? null : cur)); });
  };

  const activeWord = data !== 'wait' && picked !== null ? data.words[picked] ?? null : null;
  const activeSub = activeWord ? subOf(activeWord) : null;

  return (
    <section data-testid="reader-keywords-card" className="shrink-0 bg-page rounded-2xl shadow-card overflow-hidden">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(v => !v)}
        className="w-full min-h-[48px] px-4 py-2.5 flex items-center justify-between gap-2 text-left"
      >
        <span className="text-[14px] font-semibold text-ink">
          {data === 'wait'
            ? t('m.keywordsCardLoading')
            : t('m.keywordsCardTitle', { n: data.words.length })}
        </span>
        <span aria-hidden className="text-xs text-mute shrink-0">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && data === 'wait' && (
        <p className="px-4 pb-3.5 text-[13px] text-mute" aria-live="polite">{t('keywords.preparing')}</p>
      )}

      {expanded && data !== 'wait' && (
        <div className="px-4 pb-4 flex flex-col gap-3 border-t border-shade pt-3">
          <p className="text-[13px] text-ink/90 leading-relaxed">{data.summary}</p>
          <div className="flex flex-wrap gap-2">
            {data.words.map((k, i) => {
              const id = idOf(k);
              const has = kept instanceof Set && kept.has(id);
              const isOpen = picked === i;
              return (
                <div
                  key={id}
                  className={`inline-flex items-center rounded-full border text-[13px] ${
                    isOpen ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
                  }`}
                >
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => setPicked(cur => (cur === i ? null : i))}
                    className="min-h-[44px] pl-3 pr-1.5 text-left"
                  >
                    <span className="font-semibold text-ink">{k.word}</span>
                    {k.meaning && <span className="text-mute"> · {k.meaning}</span>}
                  </button>
                  <button
                    type="button"
                    aria-label={`${t('m.speakWord')}: ${k.word}`}
                    onClick={() => { void speakKeyword(k); }}
                    className={`w-10 h-11 inline-flex items-center justify-center ${
                      speakingId === id ? 'text-accent' : 'text-mute'
                    }`}
                  >
                    <SpeakerSvg active={speakingId === id} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${t(has ? 'keywords.added' : 'keywords.add')}: ${k.word}`}
                    disabled={kept === null || kept === 'error' || has || busyId === id}
                    onClick={() => saveKeyword(k)}
                    className={`w-10 h-11 pr-1 inline-flex items-center justify-center text-base disabled:opacity-40 ${
                      has ? 'text-accent font-semibold' : 'text-mute'
                    }`}
                  >
                    {has ? '✓' : '＋'}
                  </button>
                </div>
              );
            })}
          </div>

          {activeWord && activeSub && (
            <div className="rounded-xl bg-shade px-3.5 py-3 flex flex-col gap-2">
              <p className="font-serif text-[16px] leading-relaxed text-ink">
                {activeSub.text.slice(0, activeWord.at)}
                <b className="text-accent font-semibold">
                  {activeSub.text.slice(activeWord.at, activeWord.at + activeWord.word.length)}
                </b>
                {activeSub.text.slice(activeWord.at + activeWord.word.length)}
              </p>
              {activeWord.note && <p className="text-xs text-mute leading-relaxed">{activeWord.note}</p>}
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => onJumpLine(activeSub)}
                  className="min-h-[44px] px-3.5 rounded-[10px] bg-page shadow-card text-xs font-medium text-ink"
                >
                  {t('m.keywordsJump')}
                </button>
                <button
                  type="button"
                  onClick={() => onPlayLine(activeSub)}
                  className="min-h-[44px] px-3.5 rounded-[10px] bg-page shadow-card text-xs font-medium text-ink"
                >
                  ▶ {t('keywords.playLine')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
