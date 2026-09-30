import React, { useEffect } from 'react';
import { ChevronDown, ChevronUp, Download, FileUp, Loader2, Trash2 } from 'lucide-react';
import { Btn } from './ui';
import { useLang, useT, type DictKey } from '../utils/i18n';
import type { DictLang } from '../utils/dictionary';
import {
  dictLabel, downloadDict, importDictFile, isInstalled, loadLocalDicts, moveDict, recommendedFor, removeDict,
  setDictEnabled, setDictLang, useLocalDicts,
} from '../utils/localDict';

// Settings → Look up → local dictionaries (docs/yomitan.md): the installed ones
// (on/off, language, order, remove), import a zip, or download a recommended one.

const LANGS: DictLang[] = ['en', 'es', 'fr', 'de', 'ja'];
const mb = (b: number) => `${Math.max(1, Math.round(b / 1e6))} MB`;
const ERRORS = ['badZip', 'nested', 'badIndex', 'badRow', 'tooBig', 'noTerms', 'busy', 'already', 'sameName', 'net', 'disk', 'gone'];

const SettingsLocalDict: React.FC = () => {
  const t = useT();
  const ui = useLang();
  const { list, job, error, fresh } = useLocalDicts();
  useEffect(() => { loadLocalDicts(); }, []);
  const code = error?.replace(/^Error:\s*/, '').split(':')[0] ?? '';
  const errorText = error && (ERRORS.includes(code) ? t(`localDict.err.${code}` as DictKey) : t('localDict.err.other', { msg: error }));

  return (
    // Not a <Field>: that is a <label>, and a click on its hint would flip the
    // first dictionary's switch. Same look, plain box.
    <section aria-label={t('localDict.label')}>
      <p className="text-sm font-medium mb-1.5">{t('localDict.label')}</p>
      <div className="space-y-4 text-sm">
        {list.length === 0 && !job && <p className="text-mute">{t('localDict.empty')}</p>}
        {list.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {list.map((d, i) => (
              <li key={d.id} className={`px-3 py-2.5 space-y-1.5 ${fresh === d.id ? 'bg-accent-soft' : ''}`}>
                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer" title={t('localDict.enabled')}>
                    <input type="checkbox" checked={d.enabled} disabled={d.broken} onChange={e => setDictEnabled(d.id, e.target.checked)} />
                    <span className="truncate font-medium">{dictLabel(d.title)}</span>
                    <span className="shrink-0 text-xs text-mute">{mb(d.bytes)}</span>
                  </label>
                  <select
                    className="flat h-8 px-2 text-sm" value={d.lang ?? ''} disabled={d.broken}
                    onChange={e => e.target.value && setDictLang(d.id, e.target.value as DictLang)}
                    aria-label={t('localDict.pickLang')}
                  >
                    {!d.lang && <option value="">{t('localDict.pickLang')}</option>}
                    {LANGS.map(l => <option key={l} value={l}>{t(`dict.${l}`)}</option>)}
                  </select>
                  <Btn square size="sm" flat disabled={i === 0} onClick={() => moveDict(d.id, -1)} title={t('localDict.up')} aria-label={t('localDict.up')}><ChevronUp size={14} /></Btn>
                  <Btn square size="sm" flat disabled={i === list.length - 1} onClick={() => moveDict(d.id, 1)} title={t('localDict.down')} aria-label={t('localDict.down')}><ChevronDown size={14} /></Btn>
                  <Btn square size="sm" flat onClick={() => removeDict(d)} title={t('localDict.remove')} aria-label={t('localDict.remove')}><Trash2 size={14} /></Btn>
                </div>
                {fresh === d.id && !d.lang && <p className="text-accent">{t('localDict.whichLang')}</p>}
                {d.broken && <p className="text-accent">{t('localDict.broken')}</p>}
                {d.needsReimport && <p className="text-accent">{t('localDict.needsReimport')}</p>}
                {d.attribution && <p className="text-xs text-mute line-clamp-1 break-all" title={d.attribution}>{d.attribution}</p>}
              </li>
            ))}
          </ul>
        )}

        {job ? (
          <p className="flex items-center gap-2 text-mute">
            <Loader2 size={14} className="animate-spin" />
            {t(job.stage === 'download' ? 'localDict.downloading' : 'localDict.importing', { title: job.title, pct: job.pct })}
          </p>
        ) : (
          <Btn size="sm" onClick={() => { importDictFile(); }}><FileUp size={14} />{t('localDict.import')}</Btn>
        )}
        {errorText && !job && <p className="text-accent">{errorText}</p>}

        <div className="space-y-2">
          <p className="text-mute">{t('localDict.recommended')}</p>
          {LANGS.map(lang => (
            <div key={lang} className="flex items-center gap-3 flex-wrap">
              <span className="w-20 text-mute">{t(`dict.${lang}`)}</span>
              {recommendedFor(ui, lang).map(r => {
                const gloss = t(r.gloss === 'zh' ? 'localDict.glossZh' : 'localDict.glossEn');
                const label = `${r.title} · ${gloss}${r.gloss === 'zh' ? `（${t('localDict.fewer')}）` : ''} · ${r.mb} MB`;
                return isInstalled(r, list) ? (
                  <span key={r.title} className="text-mute">{r.title} · {t('localDict.installed')}</span>
                ) : (
                  <Btn key={r.title} size="sm" disabled={!!job} onClick={() => { downloadDict(r); }}><Download size={14} />{label}</Btn>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <p className="mt-1.5 text-xs text-mute leading-relaxed">{t('localDict.hint')}</p>
    </section>
  );
};

export default SettingsLocalDict;
