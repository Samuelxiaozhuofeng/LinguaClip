import React, { useCallback, useEffect, useRef, useState } from 'react';

// Shared primitives for the "cinema" look: light ground, white sheets, one vermilion accent.
// Btn (pressable), Card (a raised surface), Stamp (small label), Seg (segmented switch),
// Menu (the "…" popover), useToast (a note at the top that fades by itself).

export type Tone = 'white' | 'accent' | 'accent-soft' | 'shade' | 'paper' | 'ink';

export const toneBg: Record<Tone, string> = {
  white: 'bg-page text-ink',
  paper: 'bg-paper text-ink',
  shade: 'bg-shade text-ink',
  accent: 'bg-accent text-white',
  'accent-soft': 'bg-accent-soft text-accent',
  ink: 'bg-ink text-white',
};

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  flat?: boolean; // ghost: no border, just a hover tint
  square?: boolean; // icon-only square
};

const btnSize = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[15px]',
};
const sqSize = { sm: 'h-8 w-8', md: 'h-10 w-10', lg: 'h-12 w-12' };

// Three weights: solid (accent / ink), soft fill (tone="white"), ghost (flat). Pills; icon buttons are rounded squares.
export const Btn: React.FC<BtnProps> = ({
  tone = 'white', size = 'md', flat = false, square = false, className = '', children, onClick, ...rest
}) => {
  const skin = flat
    ? 'bg-transparent text-mute hover:text-ink hover:bg-shade border border-transparent'
    : tone === 'white'
      ? 'bg-shade text-ink border border-transparent hover:bg-line'
      : `${toneBg[tone]} border border-transparent disabled:!bg-shade disabled:!text-mute disabled:!opacity-100`;
  return (
    <button
      {...rest}
      // Drop focus after a mouse click so Space/Enter shortcuts don't re-fire this button.
      onClick={e => { onClick?.(e); e.currentTarget.blur(); }}
      className={`press ${square ? 'rounded-lg' : 'rounded-full'} ${skin} ${square ? sqSize[size] : btnSize[size]}
        inline-flex items-center justify-center gap-2 font-medium whitespace-nowrap select-none
        disabled:cursor-not-allowed ${className}`}
    >
      {children}
    </button>
  );
};

type CardProps = React.HTMLAttributes<HTMLDivElement> & { tone?: Tone; flat?: boolean };

export const Card: React.FC<CardProps> = ({ tone = 'white', flat = false, className = '', children, ...rest }) => (
  <div {...rest} className={`${flat ? 'border border-line rounded-xl' : 'card'} ${toneBg[tone]} ${className}`}>
    {children}
  </div>
);

export const Stamp: React.FC<React.HTMLAttributes<HTMLSpanElement> & { tone?: Tone }> = ({
  tone = 'white', className = '', children, ...rest
}) => (
  <span
    {...rest}
    className={`${tone === 'white' ? 'text-mute' : toneBg[tone]} inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs leading-tight ${className}`}
  >
    {children}
  </span>
);

export function Seg<T extends string | number>({
  options, value, onChange, size = 'md', className = '',
}: {
  options: { value: T; label: React.ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={`inline-flex p-[3px] gap-0.5 bg-shade rounded-[10px] ${className}`} role="radiogroup">
      {options.map(o => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={e => { onChange(o.value); e.currentTarget.blur(); }}
          className={`${size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm'} rounded-[7px] font-medium transition-colors
            ${o.value === value ? 'bg-page text-ink shadow-card' : 'text-mute hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// Section heading used across settings / library pages.
export const H: React.FC<{ children: React.ReactNode; sub?: React.ReactNode; badge?: React.ReactNode; className?: string }> = ({ children, sub, badge, className = '' }) => (
  <div className={`mb-5 ${className}`}>
    <h2 className="text-[30px] font-semibold tracking-[-0.02em] leading-tight flex items-center gap-3">{children}{badge}</h2>
    {sub && <p className="mt-1 text-sm text-mute">{sub}</p>}
  </div>
);

// A titled group of settings fields.
export const Group: React.FC<{ title: React.ReactNode; children: React.ReactNode }> = ({ title, children }) => (
  <section className="space-y-6">
    <h3 className="text-xs font-semibold tracking-wider text-mute uppercase">{title}</h3>
    {children}
  </section>
);

export const Field: React.FC<{ label: React.ReactNode; hint?: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({
  label, hint, right, children, className = '',
}) => (
  // A click on the label's text or hint "clicks" its first control; when that is a
  // Seg button it would silently switch the setting to the first option.
  <label
    className={`block ${className}`}
    onClick={e => { if (e.currentTarget.control instanceof HTMLButtonElement && !(e.target as Element).closest('button, input, select, textarea')) e.preventDefault(); }}
  >
    <span className="flex items-baseline justify-between mb-1.5">
      <span className="text-sm font-medium">{label}</span>
      {right && <span className="text-xs text-mute">{right}</span>}
    </span>
    {children}
    {hint && <span className="block mt-1.5 text-xs text-mute leading-relaxed">{hint}</span>}
  </label>
);

export const inputCls = 'flat w-full h-10 px-3 text-sm text-ink placeholder:text-mute focus:border-accent';

// "…" popover. Items close it on click; Esc and a click outside close it too.
export type MenuItem = { label: React.ReactNode; onClick: () => void; disabled?: boolean; title?: string } | 'divider';

export const Menu: React.FC<{
  items: MenuItem[];
  trigger: (open: boolean, toggle: () => void) => React.ReactNode;
  align?: 'left' | 'right';
  up?: boolean;
  children?: React.ReactNode; // extra panel content above the items (e.g. a Seg)
  footer?: React.ReactNode; // quiet content below the items (e.g. a key legend)
  className?: string; // the panel's width etc.
}> = ({ items, trigger, align = 'right', up = false, children, footer, className = '' }) => {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open]);
  return (
    <div ref={box} className="relative">
      {trigger(open, () => setOpen(o => !o))}
      {open && (
        <div className={`absolute z-30 ${up ? 'bottom-full mb-2' : 'top-full mt-2'} ${align === 'right' ? 'right-0' : 'left-0'} card min-w-[220px] p-1.5 fade-in ${className}`} role="menu">
          {children}
          {items.map((it, i) => it === 'divider' ? (
            <div key={i} className="my-1.5 mx-1 border-t border-line" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              title={it.title}
              onClick={e => { e.currentTarget.blur(); setOpen(false); it.onClick(); }}
              className="w-full h-9 px-2.5 rounded-lg flex items-center gap-2.5 text-sm text-ink text-left hover:bg-shade disabled:text-mute disabled:hover:bg-transparent disabled:cursor-not-allowed"
            >
              {it.label}
            </button>
          ))}
          {footer}
        </div>
      )}
    </div>
  );
};

// A short note at the top of a page ("saved", a switch flipped) that goes by itself after
// 1.6 s; saying something again restarts it. `view` goes inside a relatively placed box.
export function useToast() {
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1600);
    return () => window.clearTimeout(id);
  }, [toast]);
  const say = useCallback((text: string) => setToast(s => ({ text, n: (s?.n ?? 0) + 1 })), []);
  const view = toast && (
    <div key={toast.n} className="absolute left-1/2 -translate-x-1/2 top-5 z-20 fade-in pointer-events-none">
      <Stamp tone="ink" className="!px-3 !py-1.5 !text-sm shadow-card">{toast.text}</Stamp>
    </div>
  );
  return { say, view };
}
