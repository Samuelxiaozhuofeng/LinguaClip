// The meaning of a tapped word, as a sheet from the bottom (design Lookup.dc.html): each
// meaning with its own "＋" into the word deck, where it came from, optional Android aux-channel
// pronunciation speaker, and "let AI explain" when an AI is set up.
// All text is rendered as React text nodes (no raw HTML injection); glyph images allow https:// only.
import React, { useEffect, useRef, useState } from 'react';
import type { Subtitle } from '../types';
import type { DictEntry, Seg } from '../utils/dictionary';
import { useT } from '../utils/i18n';
import { getWordVoice } from '../utils/storage';
import { useBackClose } from './backClose';
import { CAN_SPEAK_WORD, WORD_PLATFORM, speakWordAux } from './platform/wordPlatform';
import { aiFields, firstFields, isSafeImgUrl, senseFields, type Def, type Keep } from './useWordLookup';

const ERROR_KEY = {
  offline: 'definition.dictOffline',
  noDict: 'definition.noDictLang',
  dictsOff: 'definition.dictsOff',
  noLocal: 'definition.noLocalDict',
  notFound: 'definition.notFound',
} as const satisfies Record<Exclude<Def['error'], ''>, string>;

export type ErrorI18nKey = (typeof ERROR_KEY)[keyof typeof ERROR_KEY];
export const errorKeyOf = (error: Def['error']): ErrorI18nKey | null => (error ? ERROR_KEY[error] : null);

export function dictSourceLabel(
  entries: DictEntry[],
  translate: (k: string, vars?: Record<string, string | number>) => string,
  platform: 'web' | 'android' = WORD_PLATFORM,
  hasExplain = false,
): string {
  if (platform !== 'android') return translate(hasExplain ? 'm.fromWiki' : 'm.fromWikiNoAi');
  if (entries.length === 0) return '';
  const names = [...new Set(entries.map(e => e.dictName ?? translate(`dict.${e.source}`)))];
  return translate('m.dictSource', { name: names.join(' / ') });
}

export const SegText: React.FC<{ line: Seg[] }> = ({ line }) => (
  <>{line.map((p, k) => typeof p === 'string'
    ? <React.Fragment key={k}>{p}</React.Fragment>
    : 'ruby' in p ? <ruby key={k}>{p.ruby}<rt>{p.rt}</rt></ruby>
    : isSafeImgUrl(p.img) ? <img key={k} src={new URL(p.img).href} alt="" className="inline h-[1em] align-[-0.12em] mix-blend-multiply" />
    : null)}</>
);

const SpeakerIcon: React.FC<{ speaking: boolean }> = ({ speaking }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={speaking ? 'animate-pulse' : ''}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
  </svg>
);

export const WordSheet: React.FC<{
  def: Def;
  onClose: () => void;
  onKeep: (k: Keep) => void;
  onExplain?: () => void;
  onPlayLine?: (line: Subtitle) => void;
}> = ({ def, onClose, onKeep, onExplain, onPlayLine }) => {
  const t = useT();
  useBackClose(true, onClose);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [speaking, setSpeaking] = useState(false);
  const [speakFail, setSpeakFail] = useState<'' | 'fail' | 'clip'>('');
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  useEffect(() => {
    setKept(new Set());
    setSpeaking(false);
    setSpeakFail('');
  }, [def.word, def.line.id]);

  const onSpeak = async () => {
    if (speaking) return;
    setSpeaking(true);
    setSpeakFail('');
    let ok = false;
    if (CAN_SPEAK_WORD && def.lang) {
      ok = await speakWordAux(def.phrase ? def.word : (def.dict?.[0]?.word || def.word), def.lang);
    }
    if (!aliveRef.current) return;
    setSpeaking(false);
    if (!ok) {
      if (onPlayLine) {
        onPlayLine(def.line);
        return;
      }
      setSpeakFail(getWordVoice() === 'clip' ? 'clip' : 'fail');
    }
  };

  const plus = (id: string, k: Keep) => (
    <button aria-label={t('m.keepWord')} aria-pressed={kept.has(id)} disabled={kept.has(id)}
      onClick={() => { setKept(s => new Set(s).add(id)); onKeep(k); }}
      className={`shrink-0 w-11 h-11 rounded-[10px] text-xl ${kept.has(id) ? 'bg-accent-soft text-accent text-base' : 'bg-shade text-ink'}`}>
      {kept.has(id) ? '✓' : '＋'}
    </button>
  );

  const errKey = errorKeyOf(def.error);
  const pickAiNote = [def.pickNote, def.pickCulture].filter(Boolean).join('\n');
  const phraseFields = def.phrase ? firstFields(def) : null;
  const phraseKept = kept.has('phrase');
  const canSpeak = (CAN_SPEAK_WORD && !!def.lang) || !!onPlayLine;
  let n = 0;

  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-label={def.word} data-testid={def.phrase ? 'phrase-sheet' : 'word-sheet'}>
      <button aria-label={t('m.close')} className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative max-h-[75vh] supports-[height:1dvh]:max-h-[75dvh] overflow-y-auto bg-page rounded-t-[22px] shadow-lift px-5 pt-2.5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-3">
        <div className="self-center w-9 h-[5px] rounded bg-line" />
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 flex flex-col gap-0.5">
            {def.phrase && <span className="self-start px-2 py-0.5 rounded-full bg-accent-soft text-accent text-[11px] font-medium">{t('m.phraseTag')}</span>}
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-serif text-[26px] font-semibold break-words leading-tight">{def.word}</span>
              {def.dict?.[0]?.phonetic && <span className="text-[13px] text-mute">{def.dict[0].phonetic}</span>}
            </div>
          </div>
          {canSpeak && !def.phrase && (
            <button
              type="button"
              onClick={() => { void onSpeak(); }}
              disabled={speaking}
              aria-label={t('m.speakWord')}
              aria-busy={speaking}
              className={`shrink-0 w-11 h-11 rounded-[10px] flex items-center justify-center ${speaking ? 'bg-accent-soft text-accent' : 'bg-shade text-ink'}`}
            >
              <SpeakerIcon speaking={speaking} />
            </button>
          )}
          <button onClick={onClose} className="shrink-0 w-11 h-11 -mr-2 text-mute text-xl flex items-center justify-center" aria-label={t('m.close')}>×</button>
        </div>
        {speaking && <p className="text-xs text-mute -mt-2" role="status">{t('m.speaking')}</p>}
        {!speaking && speakFail && (
          <p className="text-xs text-mute -mt-2" role="status">
            {t(speakFail === 'clip' ? 'm.speakClipMode' : 'm.speakFail')}
          </p>
        )}
        {def.loading && <p className="text-sm text-mute">{t('definition.asking')}</p>}
        {def.dict && def.picked == null && (def.pickNote || def.pickCulture) && (
          <div className="rounded-xl bg-accent-soft px-3.5 py-2.5 flex flex-col gap-1">
            {def.pickNote && <span className="text-[13px] text-accent font-medium leading-snug">AI：{def.pickNote}</span>}
            {def.pickCulture && <span className="text-[13px] text-ink/85 leading-snug whitespace-pre-line">{def.pickCulture}</span>}
          </div>
        )}
        {def.dict?.map((e, ei) => {
          const hasMultiDicts = new Set(def.dict?.map(x => x.dictName).filter(Boolean)).size > 1;
          const showDictHead = hasMultiDicts && !!e.dictName && (ei === 0 || def.dict?.[ei - 1]?.dictName !== e.dictName);
          return (
            <div key={ei} className="flex flex-col gap-2.5">
              {showDictHead && <p className="text-[11px] font-medium text-mute tracking-wide">{e.dictName}</p>}
              {(ei > 0 || e.note) && <p className="text-[13px] text-mute">{e.word}{e.note ? ` · ${e.note}` : ''}</p>}
              {e.senses.map((s, si) => {
                const id = `${ei}.${si}`;
                const num = ++n;
                const isPicked = def.picked != null && num === def.picked;
                return (
                  <div key={id} className={`flex gap-2.5 items-start ${isPicked ? 'rounded-xl bg-accent-soft/70 border-l-2 border-accent pl-2.5 pr-1.5 py-1.5 -mx-2' : ''}`}>
                    <span className={`text-[13px] w-4 pt-0.5 ${isPicked ? 'text-accent font-semibold' : 'text-mute'}`}>{num}</span>
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <span className="text-[15px] leading-snug">{s.pos && <i className="text-mute mr-1">{s.pos}</i>}{s.phrase && <b className="mr-1">{s.phrase}</b>}<SegText line={s.text} /></span>
                      {s.examples[0] && <span className="font-serif text-sm text-mute"><SegText line={s.examples[0]} /></span>}
                      {isPicked && def.pickNote && <span className="text-[13px] text-accent leading-snug">AI：{def.pickNote}</span>}
                      {isPicked && def.pickCulture && <span className="text-[13px] text-ink/80 leading-snug whitespace-pre-line">{def.pickCulture}</span>}
                    </div>
                    {plus(id, senseFields(e, s, def.ai, isPicked ? pickAiNote : ''))}
                  </div>
                );
              })}
            </div>
          );
        })}
        {!def.loading && !def.dict && errKey && !def.ai && !def.aiBusy && (
          <p className="text-sm text-mute">{def.phrase && !onExplain ? t('m.phraseNoAi') : t(errKey)}</p>
        )}
        {def.ai && (
          <div className="rounded-xl bg-accent-soft px-3.5 py-3 flex gap-2.5 items-start">
            <div className="flex-1 min-w-0 text-[15px] leading-relaxed whitespace-pre-line">
              <span className="text-xs text-accent font-medium block mb-0.5">AI{def.ai.partOfSpeech ? ` · ${def.ai.partOfSpeech}` : ''}</span>
              {def.ai.definition}{def.ai.culture ? `\n${def.ai.culture}` : ''}
            </div>
            {!def.dict && !def.phrase && plus('ai', aiFields(def.ai))}
          </div>
        )}
        {def.aiBusy && <p className="text-sm text-mute">{t('m.aiAsking')}</p>}
        {def.aiError && <p className="text-sm text-accent">{t('m.aiFail')}</p>}
        {def.dict && def.dict.length > 0 && <p className="text-xs text-mute">{dictSourceLabel(def.dict, t, WORD_PLATFORM, !!onExplain)}</p>}
        {onExplain && def.dict && !def.ai && (
          <button className="h-12 rounded-xl border border-line bg-page text-[15px] font-medium disabled:opacity-50" disabled={def.aiBusy} onClick={onExplain}>{t('m.aiExplain')}</button>
        )}
        {def.phrase && (
          <div className="pt-1 flex items-center gap-2.5">
            {canSpeak && (
              <button
                type="button"
                disabled={speaking}
                onClick={() => { void onSpeak(); }}
                className="min-h-[48px] px-4 rounded-[12px] bg-shade text-ink text-[15px] font-medium inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
              >
                <SpeakerIcon speaking={speaking} />
                <span>{t('m.phraseListen')}</span>
              </button>
            )}
            <button
              type="button"
              disabled={!phraseFields || phraseKept}
              onClick={() => {
                if (!phraseFields || phraseKept) return;
                setKept(s => new Set(s).add('phrase'));
                onKeep(phraseFields);
              }}
              className={`flex-1 min-h-[48px] px-4 rounded-[12px] text-[15px] font-semibold disabled:opacity-50 ${
                phraseKept ? 'bg-accent-soft text-accent' : 'bg-accent text-white'
              }`}
            >
              {phraseKept ? `✓ ${t('m.phraseSavedCard')}` : t('m.phraseSaveCard')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
