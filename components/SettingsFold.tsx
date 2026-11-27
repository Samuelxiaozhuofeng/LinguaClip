import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Btn } from './ui';
import { useT } from '../utils/i18n';

export interface SettingsFoldProps {
  title: React.ReactNode;
  summary?: React.ReactNode;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  children: React.ReactNode;
}

// Collapsible settings card matching the cinema sheet look.
// Unmounts children while collapsed so child listeners (e.g. shortcut recorder) are torn down cleanly.
const SettingsFold: React.FC<SettingsFoldProps> = ({
  title,
  summary,
  action,
  defaultOpen = false,
  open,
  onOpenChange,
  id,
  children,
}) => {
  const t = useT();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const isOpen = open ?? innerOpen;

  const setOpen = (next: boolean) => {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div id={id} className="bg-page border border-line rounded-2xl">
      <div className="flex items-center justify-between gap-3 px-5 py-4">
        <button
          type="button"
          aria-expanded={isOpen}
          className="flex-1 min-w-0 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-left cursor-pointer select-none"
          onClick={() => setOpen(!isOpen)}
        >
          <span className="text-sm font-semibold text-ink">{title}</span>
          {summary && <span className="text-xs text-mute">{summary}</span>}
        </button>
        <div className="flex items-center gap-2 shrink-0">
          {action}
          <Btn
            type="button"
            size="sm"
            flat
            aria-expanded={isOpen}
            onClick={() => setOpen(!isOpen)}
          >
            {t(isOpen ? 'settings.collapse' : 'settings.expand')}
            <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </Btn>
        </div>
      </div>
      {isOpen && (
        <div className="px-5 pb-5 pt-4 border-t border-line">
          {children}
        </div>
      )}
    </div>
  );
};

export default SettingsFold;
