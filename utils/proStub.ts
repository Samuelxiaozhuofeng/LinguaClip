import type React from 'react';
import type { VideoRecord } from '../types';
import type { ReadBy } from './storage';

// What `@pro` gives when the pro/ folder isn't there (the open-source build): no
// reader, nothing to cancel. pro/index.ts exports the same names.
export type ProReader = React.FC<{ record: VideoRecord; by: ReadBy; onExit: (looked: number) => void }>;

export const Reader: ProReader | null = null;
export const cancelTrans = async (_id: string): Promise<void> => {};
