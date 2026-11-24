// Bottom sheet for Android local audio/video import (M1.2):
// lets the user pick audio language, select an audio track when >=2 supported tracks exist,
// and optionally attach a local .srt subtitle file to skip cloud transcription.
import React, { useMemo, useRef, useState } from 'react';
import { useLang, useT } from '../utils/i18n';
import type { AudioTrackInfo, ProbeTracksResult } from './platform/androidBridge';
import { btnPlain, btnPrimary, btnSoft, langName, sheet } from './ui';

const IMPORT_LANGS = ['auto', 'en', 'ja', 'es', 'fr', 'de', 'ko', 'no', 'zh'] as const;
const LANG_STORAGE_KEY = 'import_lang';

export interface ImportSheetConfirm {
  uri: string;
  displayName: string;
  trackIndex: number;
  lang: string;
  srtText?: string;
  srtName?: string;
}

export interface ImportSheetProps {
  uri: string;
  probe: ProbeTracksResult;
  defaultLang?: string;
  onCancel: () => void;
  onConfirm: (opts: ImportSheetConfirm) => void;
  onPickSrt?: () => Promise<{ name: string; text: string; count: number } | null>;
}

function shortCodec(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('mp4a')) return 'AAC';
  if (m.includes('mpeg')) return 'MP3';
  if (m.includes('opus')) return 'Opus';
  if (m.includes('vorbis')) return 'Vorbis';
  if (m.includes('flac')) return 'FLAC';
  if (m.includes('raw')) return 'WAV';
  if (m.includes('eac3')) return 'E-AC-3';
  if (m.includes('ac3')) return 'AC-3';
  if (m.includes('dts')) return 'DTS';
  return mime.replace(/^audio\//i, '').toUpperCase() || 'AUDIO';
}

function defaultTrackFrom(probe: ProbeTracksResult): number {
  if (probe.defaultTrackIndex >= 0) return probe.defaultTrackIndex;
  const firstSupported = probe.tracks.find(tr => tr.supported !== false);
  return firstSupported ? firstSupported.index : -1;
}

function initialLang(propLang?: string): string {
  if (propLang) return propLang;
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved && (IMPORT_LANGS as readonly string[]).includes(saved)) return saved;
  } catch { /* ignore */ }
  return 'auto';
}

export const ImportSheet: React.FC<ImportSheetProps> = ({
  uri,
  probe,
  defaultLang,
  onCancel,
  onConfirm,
  onPickSrt,
}) => {
  const t = useT();
  const uiLang = useLang();
  const [lang, setLang] = useState<string>(() => initialLang(defaultLang));
  const [trackIndex, setTrackIndex] = useState<number>(() => defaultTrackFrom(probe));
  const [srt, setSrt] = useState<{ name: string; text: string; count: number } | null>(null);
  const [srtErr, setSrtErr] = useState('');
  const [pickingSrt, setPickingSrt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  const supportedCount = useMemo(
    () => probe.tracks.filter(tr => tr.supported !== false).length,
    [probe.tracks],
  );
  const showTracks = supportedCount >= 2;

  const chooseLang = (next: string) => {
    setLang(next);
    try { localStorage.setItem(LANG_STORAGE_KEY, next); } catch { /* ignore */ }
  };

  const handlePickSrt = async () => {
    if (!onPickSrt || pickingSrt) return;
    setSrtErr('');
    setPickingSrt(true);
    try {
      const picked = await onPickSrt();
      if (picked) setSrt(picked);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSrtErr(msg === 'srt:empty' ? t('m.srtEmpty') : msg);
    } finally {
      setPickingSrt(false);
    }
  };

  const formatTrackLabel = (tr: AudioTrackInfo, pos: number) => {
    const langLabel = tr.language && tr.language !== 'und'
      ? langName(tr.language, uiLang)
      : t('add.embeddedUnknown');
    return t('m.trackItem', {
      n: pos + 1,
      lang: langLabel,
      codec: shortCodec(tr.mime),
      ch: tr.channels || 2,
    });
  };

  const canStart = trackIndex >= 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('m.pickMedia')}
      className="fixed inset-0 z-50 bg-black/40 flex items-end justify-center p-3 pb-[max(16px,env(safe-area-inset-bottom))]"
      onClick={onCancel}
    >
      <div
        className={`${sheet} w-full max-w-lg p-5 shadow-xl flex flex-col gap-4 max-h-[85vh] supports-[height:1dvh]:max-h-[85dvh] overflow-y-auto`}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[17px] font-semibold text-ink">{t('m.pickMedia')}</h2>
            <p className="text-[13px] text-mute truncate mt-0.5">{probe.displayName}</p>
          </div>
          <button
            type="button"
            aria-label={t('m.cancel')}
            onClick={onCancel}
            className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full text-xl text-mute"
          >
            ×
          </button>
        </div>

        {/* Audio track picker: shown when >=2 supported audio tracks exist */}
        {showTracks && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-ink">{t('m.trackTitle')}</p>
            <p className="text-xs text-mute">{t('m.trackHint')}</p>
            <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={t('m.trackTitle')}>
              {probe.tracks.map((tr, pos) => {
                const supported = tr.supported !== false;
                const selected = supported && trackIndex === tr.index;
                return (
                  <button
                    key={tr.index}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={!supported}
                    onClick={() => supported && setTrackIndex(tr.index)}
                    className={`min-h-[46px] px-3.5 py-2.5 rounded-xl text-left text-[13px] flex items-center justify-between gap-2 transition ${
                      !supported
                        ? 'bg-shade/60 text-mute opacity-60 cursor-not-allowed'
                        : selected
                          ? 'bg-ink text-white font-medium'
                          : 'bg-shade text-ink'
                    }`}
                  >
                    <span className="truncate">{formatTrackLabel(tr, pos)}</span>
                    <span className="shrink-0 flex items-center gap-1.5 text-[11px]">
                      {tr.isDefault && supported && (
                        <span className={`px-2 py-0.5 rounded-full ${selected ? 'bg-white/20 text-white' : 'bg-page text-mute'}`}>
                          {t('m.trackDefault')}
                        </span>
                      )}
                      {!supported && (
                        <span className="px-2 py-0.5 rounded-full bg-page text-accent">
                          {t('m.trackUnsupported')}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Audio language selector */}
        <div className="flex flex-col gap-2">
          <p className="text-[13px] font-medium text-ink">{t('m.importLang')}</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('m.importLang')}>
            {IMPORT_LANGS.map(code => {
              const active = lang === code;
              const label = code === 'auto' ? t('m.importLangAuto') : langName(code, uiLang);
              return (
                <button
                  key={code}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => chooseLang(code)}
                  className={`min-h-[40px] px-3.5 rounded-full text-[13px] ${
                    active ? 'bg-ink text-white font-medium' : 'bg-shade text-ink'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Optional .srt subtitle attachment */}
        {onPickSrt && (
          <div className="flex flex-col gap-2">
            {srt ? (
              <div className="bg-shade rounded-xl px-3.5 py-2.5 flex items-center justify-between gap-2">
                <span className="text-[13px] text-ink truncate">{t('m.srtPicked', { name: srt.name })}</span>
                <button
                  type="button"
                  className="shrink-0 min-h-[36px] px-2.5 text-xs text-accent font-medium"
                  onClick={() => { setSrt(null); setSrtErr(''); }}
                >
                  {t('m.clearSrt')}
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={pickingSrt}
                className={`${btnSoft} w-full text-left`}
                onClick={handlePickSrt}
              >
                {t('m.pickSrt')}
              </button>
            )}
            {srtErr && <p role="alert" className="text-xs text-accent">{srtErr}</p>}
          </div>
        )}

        {/* Action buttons */}
        <div className="grid grid-cols-2 gap-2.5 pt-1">
          <button type="button" className={btnPlain} onClick={onCancel}>
            {t('m.cancel')}
          </button>
          <button
            type="button"
            disabled={!canStart || submitting}
            className={`${btnPrimary} disabled:opacity-50`}
            onClick={() => {
              if (submittingRef.current || !canStart) return;
              submittingRef.current = true;
              setSubmitting(true);
              onConfirm({
                uri,
                displayName: probe.displayName,
                trackIndex,
                lang,
                ...(srt ? { srtText: srt.text, srtName: srt.name } : {}),
              });
            }}
          >
            {t('m.startImport')}
          </button>
        </div>
      </div>
    </div>
  );
};
