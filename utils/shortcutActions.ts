import type { DictKey } from './i18n';

// Every keyboard shortcut in the app, by page (docs/shortcuts.md「全部快捷键可改」).
// Defaults are the keys the app always had; Settings lets each one be rebound.

export type Combo = { code: string; mod?: boolean; shift?: boolean };

// Settings tabs. 'dict' also shows the blank's keys ('blank' scope).
export type Page = 'dict' | 'watch' | 'review' | 'reader';
// Which actions can't share a key: they are live at the same moment. A blank
// (DictationLine) sees its own keys plus the dictation page's; outside it the
// page's own handler runs. Review's typing keys are only its ⌘ ones and Esc.
type Zone = 'dictOut' | 'dictBlank' | 'reviewOut' | 'reviewBlank' | 'watch' | 'reader';

type Def = { id: string; def: Combo; label: DictKey; group: DictKey; zones: Zone[]; single: boolean };

const k = (code: string, mod = false, shift = false): Combo => ({ code, mod, shift });

// single: may be a plain letter / digit (no typing happens on that page).
const dict = (name: string, def: Combo, label: DictKey, group: DictKey, zones: Zone[] = ['dictOut', 'dictBlank']): Def =>
  ({ id: `dict.${name}`, def, label, group, zones, single: false });
const blank = (name: string, def: Combo, label: DictKey): Def =>
  ({ id: `blank.${name}`, def, label, group: 'shortcuts.gBlank', zones: ['dictBlank', 'reviewBlank'], single: false });
const watch = (name: string, def: Combo, label: DictKey, group: DictKey, zones: Zone[] = ['watch']): Def =>
  ({ id: `watch.${name}`, def, label, group, zones, single: true });
const review = (name: string, def: Combo, label: DictKey, zones: Zone[] = ['reviewOut']): Def =>
  ({ id: `review.${name}`, def, label, group: 'shortcuts.gReview', zones, single: true });
const reader = (name: string, def: Combo, label: DictKey): Def =>
  ({ id: `reader.${name}`, def, label, group: 'shortcuts.gReader', zones: ['reader'], single: true });

export const ACTIONS: Def[] = [
  dict('play', k('Space'), 'keys.play', 'shortcuts.gPlay'),
  // replay / from here / just this word also fire inside a review sentence card's blank.
  dict('replay', k('Space', false, true), 'keys.replay', 'shortcuts.gPlay', ['dictOut', 'dictBlank', 'reviewBlank']),
  dict('loop', k('KeyL', true), 'keys.loop', 'shortcuts.gPlay'),
  dict('playTyping', k('KeyE', true), 'keys.playTyping', 'shortcuts.gPlay'),
  dict('playFrom', k('KeyJ', true), 'keys.playFrom', 'shortcuts.gPlay', ['dictOut', 'dictBlank', 'reviewBlank']),
  dict('playWord', k('KeyK', true), 'keys.playWord', 'shortcuts.gPlay', ['dictOut', 'dictBlank', 'reviewBlank']),
  dict('prev', k('ArrowUp', true), 'keys.prev', 'shortcuts.gTools'),
  dict('next', k('ArrowDown', true), 'keys.next', 'shortcuts.gTools'),
  dict('skipLine', k('KeyT', true), 'keys.skipLine', 'shortcuts.gTools'),
  dict('continue', k('Enter'), 'keys.continue', 'shortcuts.gTools', ['dictOut']), // never inside a blank
  dict('breakdown', k('KeyB', true), 'keys.breakdown', 'shortcuts.gTools'),
  dict('anki', k('KeyN', true, true), 'keys.anki', 'shortcuts.gTools'),
  dict('close', k('Escape'), 'keys.closeDict', 'shortcuts.gTools'),
  blank('jump', k('Space'), 'keys.blankJump'),
  blank('skip', k('ArrowRight'), 'keys.skipWord'),
  blank('submit', k('Enter'), 'keys.blankSubmit'),
  blank('back', k('Backspace'), 'keys.blankBack'),
  blank('backLeft', k('ArrowLeft'), 'keys.blankBackLeft'),
  blank('peek', k('KeyX', true), 'keys.peek'),
  blank('reveal', k('Enter', true), 'keys.reveal'),

  watch('play', k('Space'), 'keys.play', 'shortcuts.gPlayLines'),
  watch('replay', k('Space', false, true), 'keys.replay', 'shortcuts.gPlayLines'),
  watch('prev', k('ArrowLeft'), 'keys.prev', 'shortcuts.gPlayLines'),
  watch('next', k('ArrowRight'), 'keys.next', 'shortcuts.gPlayLines'),
  watch('loop', k('KeyL', true), 'keys.loopListen', 'shortcuts.gPlayLines'),
  watch('autoPause', k('KeyP'), 'keys.autoPause', 'shortcuts.gPlayLines'),
  watch('save', k('KeyS'), 'keys.save', 'shortcuts.gSubs'),
  watch('markPrev', k('KeyA'), 'keys.markPrev', 'shortcuts.gSubs'),
  watch('subs', k('KeyC'), 'keys.subs', 'shortcuts.gSubs'),
  watch('peek', k('KeyV'), 'keys.showLine', 'shortcuts.gSubs'),
  watch('full', k('KeyF'), 'keys.full', 'shortcuts.gSubs'),
  watch('anki', k('KeyN', true, true), 'keys.ankiWatch', 'shortcuts.gSubs'),
  watch('close', k('Escape'), 'keys.closeWatch', 'shortcuts.gSubs'),
  // In a drill these run before the page's keys (show answer may share V with 只看这一句).
  watch('drillNext', k('Enter'), 'keys.drillNext', 'shortcuts.gDrill'),
  watch('drillShow', k('KeyV'), 'keys.drillShow', 'shortcuts.gDrill'),

  review('flip', k('Space'), 'keys.flip'),
  review('g1', k('Digit1'), 'keys.g1'),
  review('g2', k('Digit2'), 'keys.g2'),
  review('g3', k('Digit3'), 'keys.g3'),
  review('g4', k('Digit4'), 'keys.g4'),
  review('master', k('Digit5'), 'keys.master'),
  review('suggest', k('Enter'), 'keys.suggest'),
  review('remove', k('Backspace', true), 'keys.remove'),
  review('loop', k('KeyL', true), 'keys.loop', ['reviewOut', 'reviewBlank']),
  review('replay', k('Space', false, true), 'keys.replay'),
  review('playWord', k('KeyK', true), 'keys.playWord'),
  review('close', k('Escape'), 'keys.closeReview', ['reviewOut', 'reviewBlank']),

  reader('play', k('Space'), 'keys.readerPlay'),
  reader('close', k('Escape'), 'keys.closeReader'),
];

export type ActionId = string;
export const ACTION = new Map(ACTIONS.map(a => [a.id, a]));
export const pageOf = (id: string): Page => (id.startsWith('blank.') ? 'dict' : id.split('.')[0]) as Page;
export const PAGES: { id: Page; label: DictKey }[] = [
  { id: 'dict', label: 'shortcuts.pDict' }, { id: 'watch', label: 'shortcuts.pWatch' },
  { id: 'review', label: 'shortcuts.pReview' }, { id: 'reader', label: 'shortcuts.pReader' },
];
// Space is both: play/pause in an empty blank and next blank once it has text (docs/shortcuts.md).
// V is 只看这一句 on the page and 显示答案 in a drill.
const MAY_SHARE = [['dict.play', 'blank.jump'], ['watch.peek', 'watch.drillShow']];
export const maySharePair = (a: string, b: string) => MAY_SHARE.some(p => p.includes(a) && p.includes(b));
export const zonesShare = (a: string, b: string) => {
  if (maySharePair(a, b)) return false;
  const za = ACTION.get(a)?.zones ?? [];
  return (ACTION.get(b)?.zones ?? []).some(z => za.includes(z));
};
