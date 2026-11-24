// The phone's "listen" way: embeds mobile/Listen.tsx inside the unified Study page (M2.1).
import React from 'react';
import { Listen } from '../Listen';
import type { WayProps } from './types';

export const ListenWay: React.FC<WayProps> = ({ record, startSec, onPos, onLine, onExit }) => (
  <Listen record={record} onBack={onExit} embedded startSec={startSec} onPos={onPos} onLine={onLine} />
);
