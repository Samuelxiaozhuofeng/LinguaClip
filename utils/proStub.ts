import type React from 'react';
import type { VideoRecord } from '../types';
import type { ReadBy } from './storage';

// What `@pro` gives when the pro/ folder isn't there (the open-source build): no
// reader, nothing to cancel. pro/index.ts exports the same names.
export type ProReader = React.FC<{ record: VideoRecord; by: ReadBy; onExit: (looked: number) => void }>;

export const Reader: ProReader | null = null;
export const cancelTrans = async (_id: string): Promise<void> => {};
export type ReaderTrial = { pro: boolean; used: number; limit: number; mine: boolean };
export const readerGate = async (_id: string): Promise<boolean> => false;
export const readerTrial = (_id: string): ReaderTrial => ({ pro: false, used: 0, limit: 0, mine: false });
// Bottom line of Settings; null = the sponsor link stays.
export const ProFooter: React.FC | null = null;
