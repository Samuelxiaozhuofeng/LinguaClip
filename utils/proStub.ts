import type React from 'react';
import type { VideoRecord } from '../types';
import type { ReadBy } from './storage';

// What `@pro` gives when the pro/ folder isn't there (the open-source build): no
// reader, nothing to cancel. pro/index.ts exports the same names.
export type ProReader = React.FC<{ record: VideoRecord; by: ReadBy; onExit: (looked: number) => void }>;

export const Reader: ProReader | null = null;
export const cancelTrans = async (_id: string): Promise<void> => {};
// Podcasts (docs/private/podcast.md): the add dialog / empty page, the listening page for
// records with no picture. null = no podcast tab, "watch" as before.
export type ProPodcastPicker = React.FC<{ onClose?: () => void; onOpen: (r: VideoRecord) => void }>;
export const PodcastPicker: ProPodcastPicker | null = null;
export type ProListen = React.FC<{ record: VideoRecord; onExit: () => void; onPractice: () => void; onOpen?: (r: VideoRecord) => void }>;
export const Listen: ProListen | null = null;
export const podcastRate = (_r: VideoRecord): string | null => null; // an episode card's speaking rate
// Bottom line of Settings; null = the sponsor link stays.
export const ProFooter: React.FC | null = null;
// Activation / manage dialogs + license check at launch, mounted once at the root.
export const ProHost: React.FC | null = null;
// No self-update: it would swap a self-built copy for the official build.
export const UPDATES = false;
