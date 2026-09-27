import React, { useEffect, useState } from 'react';
import { FileText, FileVideo } from 'lucide-react';
import { VideoRecord } from '../types';
import { fileNameFromPath, needsConvert, pickSubtitlePath, pickVideoPath, probeVideo, readSubtitleFile, type SubTrack } from '../utils/desktop';
import { downloadConvertTool, loadConvertTool, useConvertTool } from '../utils/convertTool';
import {
  IMPORT_QUALITIES,
  ImportQuality,
  ImportTools,
  importTools,
  isYouTubeUrl,
  probeImportSizes,
  startLocalImport,
  startUrlImport,
} from '../utils/importJob';
import { parseSRT } from '../utils/srtParser';
import { CLOUD, cloudKeyMissing, getTranscribeConfig } from '../utils/transcribeConfig';
import * as VideoStorage from '../utils/videoStorage';
import { getLang, useT } from '../utils/i18n';
import { dialog } from './Dialog';
import { Btn, Card, inputCls } from './ui';

// The one way in: a local video (picked or dropped), optionally with its own .srt,
// or a YouTube link. With a .srt it goes straight to practice. Otherwise starting
// hands off to the import job (which first downloads the transcription parts on a
// Mac that lacks them); the new video shows up in the list with its own progress.
// The link box only shows where yt-dlp is installed by hand.

const LANGS = [
  { value: 'en', key: 'import.langEn' },
  { value: 'es', key: 'import.langEs' },
  { value: 'ja', key: 'import.langJa' },
  { value: 'zh', key: 'import.langZh' },
  { value: 'auto', key: 'import.langAuto' },
] as const;

const QUALITY_KEYS = {
  1080: 'import.quality1080',
  720: 'import.quality720',
  480: 'import.quality480',
} as const;

const LANG_KEY = 'import_lang';
const loadLang = () => { try { return localStorage.getItem(LANG_KEY) || 'en'; } catch { return 'en'; } };
const TRASH_KEY = 'import_trash_original';
const loadTrash = () => { try { return localStorage.getItem(TRASH_KEY) === '1'; } catch { return false; } };

// A track's language tag (ISO 639-2, sometimes -1) against the dialog's language.
const TRACK_LANGS: Record<string, string[]> = {
  en: ['eng', 'en'], es: ['spa', 'es'], ja: ['jpn', 'ja'], zh: ['chi', 'zho', 'zh'],
};
// "jpn" → "日语" / "Japanese"; the raw tag when the system does not know it.
const langName = (code: string) => {
  try { return new Intl.DisplayNames([getLang() === 'zh' ? 'zh-CN' : 'en'], { type: 'language' }).of(code) ?? code; } catch { return code; }
};
const matchesLang = (track: SubTrack, lang: string) => !!track.lang && (TRACK_LANGS[lang] ?? []).includes(track.lang.toLowerCase());

function formatMb(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000));
}

type Props = {
  initialPath: string | null;
  initialSrt: string | null;
  onClose: () => void;
  onPractice: (record: VideoRecord) => void | Promise<void>;
};

const AddVideo: React.FC<Props> = ({ initialPath, initialSrt, onClose, onPractice }) => {
  const t = useT();
  const [path, setPath] = useState<string | null>(initialPath);
  const [srt, setSrt] = useState<string | null>(initialSrt);
  const [tools, setTools] = useState<ImportTools | null>(null);
  const [url, setUrl] = useState('');
  const [lang, setLangState] = useState(loadLang);
  const [quality, setQuality] = useState<ImportQuality>(1080);
  const [busy, setBusy] = useState(false);
  const [sizes, setSizes] = useState<Partial<Record<ImportQuality, number>>>({});
  const [sizesState, setSizesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  // A video the player cannot open: converted on import. Its subtitle tracks are
  // read here (which needs the converter, downloaded on the spot the first time).
  const convert = !!path && needsConvert(path);
  const tool = useConvertTool();
  const [tracks, setTracks] = useState<{ path: string; list: SubTrack[] | null; failed?: boolean }>({ path: '', list: null });
  // undefined = not touched: the track in the chosen language, if there is one.
  const [pickedTrack, setPickedTrack] = useState<number | null | undefined>(undefined);
  const [trash, setTrashState] = useState(loadTrash);
  const trimmed = url.trim();
  const valid = isYouTubeUrl(trimmed);
  const trackList = convert && tracks.path === path ? tracks.list : null;
  const track = srt || !trackList ? null
    : pickedTrack !== undefined ? pickedTrack
    : trackList.find(tr => tr.text && matchesLang(tr, lang))?.index ?? null;
  const ownSubtitles = !!path && (!!srt || track !== null);
  const [engine] = useState(getTranscribeConfig);
  const cloud = engine.mode === 'local' ? null : CLOUD[engine.mode];
  const noKey = !ownSubtitles && cloudKeyMissing(engine);
  const ready = (!!path || (valid && !!tools?.youtube)) && !noKey;
  const needsSetup = !ownSubtitles && ready && !cloud && tools?.whisper === false;

  useEffect(() => setPath(initialPath), [initialPath]);

  // Converter first (downloaded right here if missing), then the video's tracks.
  // A newer pick supersedes this one; a failure just leaves the list out.
  useEffect(() => {
    setPickedTrack(undefined);
    if (!convert || !path) return;
    let cancelled = false;
    setTracks({ path, list: null });
    (async () => {
      const status = tool.status ?? await loadConvertTool();
      if (!status?.path && !(await downloadConvertTool())) return;
      const probe = await probeVideo(path);
      if (!cancelled) setTracks({ path, list: probe.subtitles });
    })().catch(err => {
      console.error(err);
      if (!cancelled) setTracks({ path, list: [], failed: true });
    });
    return () => { cancelled = true; };
  }, [path, convert]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setSrt(initialSrt), [initialSrt]);
  useEffect(() => {
    importTools().then(setTools).catch(err => console.error(err));
  }, []);

  useEffect(() => {
    if (!valid) {
      setSizes({});
      setSizesState('idle');
      return;
    }
    setSizes({});
    setSizesState('loading');
    let cancelled = false;
    const handle = window.setTimeout(() => {
      probeImportSizes(trimmed)
        .then(result => {
          if (cancelled) return;
          const next: Partial<Record<ImportQuality, number>> = {};
          for (const q of IMPORT_QUALITIES) {
            const n = result[q];
            if (typeof n === 'number' && n > 0) next[q] = n;
          }
          setSizes(next);
          setSizesState('ready');
        })
        .catch(() => {
          if (cancelled) return;
          setSizes({});
          setSizesState('error');
        });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [trimmed, valid]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const qualityLabel = (q: ImportQuality): string => {
    const label = t(QUALITY_KEYS[q]);
    if (sizesState === 'loading') return `${label} · ${t('import.qualityQuerying')}`;
    const bytes = sizes[q];
    if (bytes) return t('import.qualityWithSize', { label, size: formatMb(bytes) });
    return label;
  };

  const setTrash = (v: boolean) => {
    setTrashState(v);
    try { localStorage.setItem(TRASH_KEY, v ? '1' : '0'); } catch { /* localStorage unavailable */ }
  };

  const setLang = (v: string) => {
    setLangState(v);
    try { localStorage.setItem(LANG_KEY, v); } catch { /* localStorage unavailable */ }
  };

  const browse = async () => {
    const p = await pickVideoPath(true);
    if (p) { setPath(p); setUrl(''); }
  };

  const browseSrt = async () => {
    const p = await pickSubtitlePath();
    if (p) setSrt(p);
  };

  // Video + own .srt: a finished record right away, then into practice. One that
  // has to be converted first becomes an import card carrying the subtitles.
  const practiceWithSubtitles = async (video: string, srtPath: string) => {
    const file = await readSubtitleFile(srtPath);
    const text = await file.text();
    const count = parseSRT(text).length;
    if (!count) {
      dialog.alert(t('app.noSubtitlesTitle'), t('app.noSubtitlesBody', { name: file.name }));
      return;
    }
    if (convert) {
      await startLocalImport(video, lang, { subs: { text, fileName: file.name, count }, trashOriginal: trash });
      onClose();
      return;
    }
    const record = await VideoStorage.createVideoRecord(fileNameFromPath(video), file, text, count, { videoPath: video });
    onClose();
    await onPractice(record);
  };

  const start = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      if (path && srt) await practiceWithSubtitles(path, srt);
      else if (path) await startLocalImport(path, lang, convert ? { subs: track ?? undefined, trashOriginal: trash } : {});
      else await startUrlImport(trimmed, lang, quality);
      if (!(path && srt)) onClose();
    } catch (err) {
      console.error(err);
      dialog.alert(t('import.startFailTitle'), t('import.startFailBody'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={onClose}>
      <Card className="w-full max-w-lg" role="dialog" aria-modal="true" aria-label={t('add.title')} onClick={e => e.stopPropagation()}>
        <div className="px-7 pt-7 pb-6 space-y-6">
          <div>
            <h3 className="text-2xl font-semibold tracking-[-0.01em] leading-tight">{t('add.title')}</h3>
            <p className="mt-1 text-sm text-mute">{t('home.dropHint')}</p>
          </div>

          <div className="flex items-center gap-3 min-w-0">
            <Btn onClick={browse} className="shrink-0 !bg-page !border-line hover:!bg-shade"><FileVideo size={16} /> {path ? t('add.change') : t('add.pickLocal')}</Btn>
            <span className={`min-w-0 truncate text-sm ${path ? 'text-ink' : 'text-mute'}`}>{path ? fileNameFromPath(path) : t('add.dragHint')}</span>
          </div>

          {!trimmed && (
            <div className="flex items-center gap-3 min-w-0">
              <Btn onClick={browseSrt} className="shrink-0 !bg-page !border-line hover:!bg-shade"><FileText size={16} /> {srt ? t('add.change') : t('add.pickSubtitle')}</Btn>
              <span className={`min-w-0 truncate text-sm ${srt ? 'text-ink' : 'text-mute'}`}>{srt ? fileNameFromPath(srt) : t('add.subtitleHint')}</span>
              {srt && <button type="button" onClick={() => setSrt(null)} className="shrink-0 text-sm text-mute hover:text-ink">{t('add.clearSubtitle')}</button>}
            </div>
          )}

          {tools?.youtube && <div className="space-y-2">
            <input
              type="url"
              value={url}
              onChange={e => { setUrl(e.target.value); if (e.target.value.trim()) { setPath(null); setSrt(null); } }}
              placeholder={t('import.placeholder')}
              className={inputCls}
            />
            {trimmed && !valid && <p className="text-xs text-mute">{t('import.invalidUrl')}</p>}
            {valid && (
              <select value={quality} onChange={e => setQuality(Number(e.target.value) as ImportQuality)} className={inputCls} aria-label={t('add.quality')}>
                {IMPORT_QUALITIES.map(q => <option key={q} value={q}>{qualityLabel(q)}</option>)}
              </select>
            )}
            {valid && sizesState === 'error' && <p className="text-xs text-mute">{t('import.qualitySizeFail')}</p>}
          </div>}

          {convert && !srt && (
            <label className="flex items-center justify-between gap-4">
              <span className="text-sm text-mute">{t('add.embedded')}</span>
              {trackList?.length ? (
                <select value={track ?? ''} onChange={e => setPickedTrack(e.target.value === '' ? null : Number(e.target.value))} className={`${inputCls} !w-56`}>
                  <option value="">{t('add.embeddedNone')}</option>
                  {trackList.map(tr => (
                    <option key={tr.index} value={tr.index} disabled={!tr.text}>
                      {[tr.lang ? langName(tr.lang) : t('add.embeddedUnknown'), tr.title].filter(Boolean).join(' · ')}{tr.text ? '' : ` · ${t('add.embeddedPicture')}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-mute text-right">
                  {tool.running ? t('add.converterDownloading', { pct: tool.pct })
                    : tool.failed ? t('add.converterFailed')
                    : tracks.failed ? t('add.embeddedFailed')
                    : trackList ? t('add.embeddedEmpty')
                    : t('add.embeddedReading')}
                </span>
              )}
            </label>
          )}

          {!ownSubtitles && <label className="flex items-center justify-between gap-4">
            <span className="text-sm text-mute">{t('add.lang')}</span>
            <select value={lang} onChange={e => setLang(e.target.value)} className={`${inputCls} !w-40`}>
              {LANGS.map(opt => <option key={opt.value} value={opt.value}>{t(opt.key)}</option>)}
            </select>
          </label>}

          {convert && (
            <div className="space-y-2">
              <p className="text-sm text-mute">{t('add.convertNote')}</p>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={trash} onChange={e => setTrash(e.target.checked)} className="w-4 h-4 accent-accent" />
                {t('add.trashOriginal')}
              </label>
            </div>
          )}

          {needsSetup && <p className="text-sm text-mute">{t('add.setupNote', { size: engine.localModel === 'light' ? 190 : 580 })}</p>}
          {!ownSubtitles && cloud && <p className={`text-sm ${noKey ? 'text-ink' : 'text-mute'}`}>{t(noKey ? 'add.cloudNoKey' : 'add.cloudNote', { name: t(cloud.name) })}</p>}
        </div>

        <div className="px-7 pt-2 pb-7 flex items-center justify-end gap-3">
          <div className="flex gap-2">
            <Btn flat onClick={onClose}>{t('dialog.cancel')}</Btn>
            <Btn tone="accent" disabled={!ready || busy} onClick={start}>{t(ownSubtitles ? (convert ? 'add.startImport' : 'add.startPractice') : needsSetup ? 'add.startSetup' : 'add.start')}</Btn>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default AddVideo;
