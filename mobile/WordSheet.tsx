// The meaning of a tapped word, as a sheet from the bottom (design Lookup.dc.html): each
// meaning with its own "＋" into the word deck, where it came from, and "let AI explain"
// when an AI is set up. Everything shown is plain text (dictionary segments, AI reply).
import React, { useState } from 'react';
import type { Seg } from '../utils/dictionary';
import { useT } from '../utils/i18n';
import { aiFields, senseFields, type Def, type Keep } from './useWordLookup';

const SegText: React.FC<{ line: Seg[] }> = ({ line }) => (
  <>{line.map((p, k) => typeof p === 'string' ? <React.Fragment key={k}>{p}</React.Fragment>
    : 'ruby' in p ? <ruby key={k}>{p.ruby}<rt>{p.rt}</rt></ruby> : null)}</>
);

export const WordSheet: React.FC<{ def: Def; onClose: () => void; onKeep: (k: Keep) => void; onExplain?: () => void }> = ({ def, onClose, onKeep, onExplain }) => {
  const t = useT();
  const [kept, setKept] = useState<Set<string>>(new Set());
  const plus = (id: string, k: Keep) => (
    <button aria-label={t('m.keepWord')} aria-pressed={kept.has(id)} disabled={kept.has(id)}
      onClick={() => { setKept(s => new Set(s).add(id)); onKeep(k); }}
      className={`shrink-0 w-11 h-11 rounded-[10px] text-xl ${kept.has(id) ? 'bg-accent-soft text-accent text-base' : 'bg-shade text-ink'}`}>
      {kept.has(id) ? '✓' : '＋'}
    </button>
  );
  let n = 0;
  return (
    <div className="fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-label={def.word}>
      <button aria-label={t('m.close')} className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative max-h-[70dvh] overflow-y-auto bg-page rounded-t-[22px] shadow-lift px-5 pt-2.5 pb-[max(24px,env(safe-area-inset-bottom))] flex flex-col gap-3">
        <div className="self-center w-9 h-[5px] rounded bg-line" />
        <div className="flex items-baseline gap-2.5">
          <span className="font-serif text-[26px] font-semibold break-all">{def.word}</span>
          {def.dict?.[0]?.phonetic && <span className="text-[13px] text-mute">{def.dict[0].phonetic}</span>}
          <button onClick={onClose} className="ml-auto w-11 h-11 -mr-2 text-mute text-xl" aria-label={t('m.close')}>×</button>
        </div>
        {def.loading && <p className="text-sm text-mute">{t('definition.asking')}</p>}
        {def.dict?.map((e, ei) => (
          <div key={ei} className="flex flex-col gap-2.5">
            {(ei > 0 || e.note) && <p className="text-[13px] text-mute">{e.word}{e.note ? ` · ${e.note}` : ''}</p>}
            {e.senses.map((s, si) => {
              const id = `${ei}.${si}`;
              return (
                <div key={id} className="flex gap-2.5 items-start">
                  <span className="text-[13px] text-mute w-4 pt-0.5">{++n}</span>
                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <span className="text-[15px] leading-snug">{s.pos && <i className="text-mute mr-1">{s.pos}</i>}{s.phrase && <b className="mr-1">{s.phrase}</b>}<SegText line={s.text} /></span>
                    {s.examples[0] && <span className="font-serif text-sm text-mute"><SegText line={s.examples[0]} /></span>}
                  </div>
                  {plus(id, senseFields(e, s, def.ai))}
                </div>
              );
            })}
          </div>
        ))}
        {!def.loading && !def.dict && def.error && !def.ai && !def.aiBusy && (
          <p className="text-sm text-mute">{t(def.error === 'offline' ? 'definition.dictOffline' : def.error === 'noDict' ? 'definition.noDictLang' : 'definition.notFound')}</p>
        )}
        {def.ai && (
          <div className="rounded-xl bg-accent-soft px-3.5 py-3 flex gap-2.5 items-start">
            <div className="flex-1 min-w-0 text-[15px] leading-relaxed whitespace-pre-line">
              <span className="text-xs text-accent font-medium block mb-0.5">AI · {def.ai.partOfSpeech}</span>
              {def.ai.definition}{def.ai.culture ? `\n${def.ai.culture}` : ''}
            </div>
            {!def.dict && plus('ai', aiFields(def.ai))}
          </div>
        )}
        {def.aiBusy && <p className="text-sm text-mute">{t('m.aiAsking')}</p>}
        {def.aiError && <p className="text-sm text-accent">{t('m.aiFail')}</p>}
        {def.dict && <p className="text-xs text-mute">{t(onExplain ? 'm.fromWiki' : 'm.fromWikiNoAi')}</p>}
        {onExplain && def.dict && !def.ai && (
          <button className="h-12 rounded-xl border border-line bg-page text-[15px] font-medium disabled:opacity-50" disabled={def.aiBusy} onClick={onExplain}>{t('m.aiExplain')}</button>
        )}
      </div>
    </div>
  );
};
