// Stands in for utils/localDict.ts in the mobile build (vite.mobile.config.ts): the
// phone has no local dictionaries, so there are none to list and nothing is found.
import type { DictLang } from '../../utils/dictionary';
import type { lookupLocal as desktopLookup } from '../../utils/localDict';

export const localDictsReady = (): Promise<void> => Promise.resolve();
export const localDictsFor = (_lang: DictLang): never[] => [];
export const lookupLocal: typeof desktopLookup = async () => null;
