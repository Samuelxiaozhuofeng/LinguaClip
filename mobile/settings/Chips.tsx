// A row of pill buttons picking one value (settings tabs' provider / theme pickers).
import React from 'react';

export function Chips<V extends string>({ value, options, onChange, label }: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {options.map(o => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`min-h-[40px] px-3.5 rounded-full text-[13px] ${value === o.value ? 'bg-ink text-inverse font-medium' : 'bg-page text-mute shadow-card'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
