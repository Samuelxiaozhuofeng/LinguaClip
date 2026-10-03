import React from 'react';
import { BreakdownPoint, spaceWords } from '../utils/aiDrills';
import { useT } from '../utils/i18n';

// "Why it's hard to hear": the linking / weak forms the AI found in the line,
// shown under the grammar notes on the last step of Break it down. Plain text.
const SoundNotes: React.FC<{ lineText: string; sounds?: BreakdownPoint[] }> = ({ lineText, sounds }) => {
  const t = useT();
  if (!sounds?.length) return null;
  const words = spaceWords(lineText);
  return (
    <div className="max-w-2xl w-full px-4 py-3 rounded-xl bg-shade text-left text-[15px] leading-relaxed fade-in">
      <p className="text-xs text-mute mb-1.5">{t('studio.soundsTitle')}</p>
      {sounds.map(s => (
        <p key={s.from}><span className="font-medium">{words.slice(s.from, s.to + 1).join(' ')}</span> · {s.note}</p>
      ))}
    </div>
  );
};

export default SoundNotes;
