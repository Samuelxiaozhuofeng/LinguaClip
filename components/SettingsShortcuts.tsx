import React, { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Btn, Seg } from './ui';
import { useT, type DictKey } from '../utils/i18n';
import {
  ACTIONS, PAGES, ActionId, Page, checkNewCombo, formatCombo, isCustom, resetCombo, resetCombos, resetPage, setCombo, useShortcuts,
} from '../utils/shortcuts';
import { pageOf } from '../utils/shortcutActions';

// Every shortcut, one tab per page (docs/shortcuts.md「全部快捷键可改」). Click a key,
// press the new one; click again to cancel. A key another live action holds, or one
// the page can't take, is refused on the spot.
const HINT: Record<Page, DictKey> = { dict: 'shortcuts.hintDict', watch: 'shortcuts.hintWatch', review: 'shortcuts.hintReview', reader: 'shortcuts.hintReader' };

const SettingsShortcuts: React.FC<{ onSaved: () => void }> = ({ onSaved }) => {
  const t = useT();
  const combos = useShortcuts();
  const [page, setPage] = useState<Page>('dict');
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stop = () => { setRecording(null); setError(null); };

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      const r = checkNewCombo(e, recording);
      if (!r) return;
      if ('combo' in r) {
        setCombo(recording, r.combo);
        stop();
        onSaved();
      } else if ('taken' in r) {
        setError(t('shortcuts.taken', { name: t(ACTIONS.find(a => a.id === r.taken)!.label) }));
      } else {
        setError(t(r.error === 'needMod' ? 'shortcuts.needMod' : 'shortcuts.reserved'));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onSaved, t]);
  useEffect(() => () => setRecording(null), []); // leaving Settings cancels

  const mine = ACTIONS.filter(a => pageOf(a.id) === page);
  const groups = [...new Set(mine.map(a => a.group))];
  const done = (fn: () => void) => { fn(); stop(); onSaved(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Seg options={PAGES.map(p => ({ value: p.id, label: t(p.label) }))} value={page} onChange={p => { setPage(p); stop(); }} />
        <Btn size="sm" flat onClick={() => done(resetCombos)}>{t('shortcuts.resetAll')}</Btn>
      </div>
      <p className="text-xs text-mute">{t(HINT[page])}</p>
      {groups.map(g => (
        <div key={g}>
          {groups.length > 1 && <div className="text-xs font-medium text-mute pt-1 pb-1">{t(g)}</div>}
          <div className="grid sm:grid-cols-2 gap-x-8 gap-y-1">
            {mine.filter(a => a.group === g).map(a => {
              const changed = isCustom(a.id);
              const on = recording === a.id;
              return (
                <div key={a.id} className="flex items-center justify-between gap-3 min-h-9 text-sm">
                  <span className="text-ink/80">{t(a.label)}</span>
                  <span className="flex items-center gap-1 shrink-0">
                    {changed && !on && (
                      <Btn square size="sm" flat onClick={() => { const other = resetCombo(a.id); if (other) setError(t('shortcuts.taken', { name: t(ACTIONS.find(x => x.id === other)!.label) })); else { stop(); onSaved(); } }}
                        title={t('shortcuts.resetOne', { key: formatCombo(a.def) })} aria-label={t('shortcuts.resetOne', { key: formatCombo(a.def) })}>
                        <RotateCcw size={13} />
                      </Btn>
                    )}
                    <Btn size="sm" flat onClick={() => { setRecording(on ? null : a.id); setError(null); }}
                      className={`min-w-16 ${on ? '!bg-accent-soft !text-accent' : changed ? '!text-ink ring-1 ring-accent' : '!text-ink'}`}>
                      {on ? t('shortcuts.recording') : formatCombo(combos[a.id])}
                    </Btn>
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {error && <p className="text-xs text-accent">{error}</p>}
      <div className="flex justify-end border-t border-line pt-3">
        <Btn size="sm" flat onClick={() => done(() => resetPage(page))}>{t('shortcuts.resetPage')}</Btn>
      </div>
    </div>
  );
};

export default SettingsShortcuts;
