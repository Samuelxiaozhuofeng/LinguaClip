// Way → component, for Study.tsx. Each way lives in its own file so parallel work never shares one.
import type React from 'react';
import type { PhoneWay, WayProps } from './types';
import { ListenWay } from './ListenWay';
import { DictationWay } from './Dictation';
import { BlurWay } from './Blur';
import { ClozeWay } from './Cloze';
import { CustomWay } from './Custom';
import { ReadWay } from './Read';

export const WAY_VIEWS: Record<PhoneWay, React.FC<WayProps>> = {
  listen: ListenWay,
  dict: DictationWay,
  blur: BlurWay,
  cloze: ClozeWay,
  custom: CustomWay,
  read: ReadWay,
};
