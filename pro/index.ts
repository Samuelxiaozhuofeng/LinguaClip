// Pro features. This folder is only in the private repo (linguaclip-pro); the public
// repo is the same code without it, and `@pro` then resolves to utils/proStub.ts
// (vite.config.ts / tsconfig.json). Keep the exports in step with the stub.
import ReaderPage from './ReaderPage';
import ListenPage from './ListenPage';
import PodcastPickerView from './PodcastPicker';
import type { ProListen, ProPodcastPicker, ProReader } from '../utils/proStub';
import type React from 'react';

export const Reader: ProReader | null = ReaderPage;
export { cancelTrans } from './transPrep';
export const PodcastPicker: ProPodcastPicker | null = PodcastPickerView;
export const Listen: ProListen | null = ListenPage;
export { podcastRate } from './ListenCoach';
export { default as ProFooter } from './ProFooter';
export { ProHost } from './LicenseDialogs';
// The official build updates itself from linguaclipapp.com (docs/update.md).
export const UPDATES = true;
