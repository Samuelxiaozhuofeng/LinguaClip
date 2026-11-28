// Android-only local Yomitan dictionary management + kuromoji Japanese splitting dictionary row
// (docs/android-roadmap.md M2.4, docs/yomitan.md). Only mounted when isAndroidNative() is true.
import React, { useEffect, useState } from 'react';
import type { DictLang } from '../../utils/dictionary';
import type { LocalDict } from '../../utils/desktop';
import {
  DICT_ERRORS, DICT_LANGS, dictLabel, formatMb, isInstalled, recommendedFor,
} from '../../utils/dictRecommend';
import { deleteJa, downloadJa, useJaState } from '../../utils/japanese';
import { jaDictStatus } from '../platform/desktop';
import { useLang, useT, type DictKey } from '../../utils/i18n';
import {
  clearPhoneDictError, downloadPhoneDict, importPhoneDict, movePhoneDict,
  pickAndCheckPhoneDict, refreshPhoneLocalDicts, removePhoneDict, retryPhoneDictJob,
  setPhoneDictEnabled, setPhoneDictLang, usePhoneLocalDicts,
} from '../platform/wordPlatform';
import { btnSmall, btnSoft, sheet } from '../ui';

const ERRORS: readonly string[] = DICT_ERRORS;

type ConfirmState = {
  title: string;
  body?: string;
  okLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

const ConfirmModal: React.FC<{ state: ConfirmState; onClose: () => void }> = ({ state, onClose }) => {
  const t = useT();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-5" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={state.title}
        className="w-full max-w-sm bg-page rounded-2xl shadow-lift p-5 flex flex-col gap-3"
        onClick={e => e.stopPropagation()}
      >
        <h3 className="text-[17px] font-semibold leading-snug">{state.title}</h3>
        {state.body && <p className="text-[14px] text-mute leading-relaxed whitespace-pre-line">{state.body}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={btnSoft} onClick={onClose}>{t('m.cancel')}</button>
          <button
            type="button"
            className={state.danger ? 'min-h-[44px] px-4 rounded-[10px] bg-accent text-white text-sm font-medium' : btnSmall}
            onClick={() => { onClose(); state.onConfirm(); }}
          >
            {state.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export const LocalDictPanel: React.FC = () => {
  const t = useT();
  const ui = useLang();
  const { list, job, error, fresh, retryable } = usePhoneLocalDicts();
  const ja = useJaState();
  const [jaDiskInstalled, setJaDiskInstalled] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('');
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  useEffect(() => {
    void refreshPhoneLocalDicts();
    let alive = true;
    jaDictStatus().then(st => { if (alive) setJaDiskInstalled(st.installed); }, () => { if (alive) setJaDiskInstalled(false); });
    return () => { alive = false; };
  }, []);

  const jaInstalled = ja.installed !== null ? ja.installed : jaDiskInstalled;

  const code = error?.replace(/^Error:\s*/, '').split(':')[0] ?? '';
  const errorText = error
    ? (ERRORS.includes(code) ? t(`localDict.err.${code}` as DictKey) : t('localDict.err.other', { msg: error }))
    : '';

  const handlePickImport = async () => {
    setNotice('');
    clearPhoneDictError();
    const res = await pickAndCheckPhoneDict();
    if (!res) return;
    const { path, check } = res;
    const label = dictLabel(check.title);
    if (check.same) {
      if (check.same.revision === check.revision) {
        setNotice(t('localDict.already', { title: label }));
        return;
      }
      const replaceId = check.same.id;
      setConfirmState({
        title: t('localDict.replaceTitle', { title: label }),
        body: t('localDict.replaceBody', { old: check.same.revision, next: check.revision }),
        okLabel: t('localDict.replace'),
        onConfirm: () => { void importPhoneDict(path, label, replaceId); },
      });
      return;
    }
    void importPhoneDict(path, label);
  };

  const askRemoveDict = (d: LocalDict) => {
    setConfirmState({
      title: t('localDict.removeTitle', { title: dictLabel(d.title) }),
      okLabel: t('localDict.remove'),
      danger: true,
      onConfirm: () => { void removePhoneDict(d.id); },
    });
  };

  const askRemoveJa = () => {
    setConfirmState({
      title: t('ja.settingLabel'),
      body: t('m.jaRemoveConfirm'),
      okLabel: t('ja.remove'),
      danger: true,
      onConfirm: () => { void deleteJa().then(() => setJaDiskInstalled(false), console.error); },
    });
  };

  return (
    <>
      <section className="flex flex-col gap-2" aria-label={t('localDict.label')}>
        <p className="text-[13px] text-mute">{t('localDict.label')}</p>
        <div className={`${sheet} flex flex-col`}>
          {list.length === 0 && !job && (
            <p className="px-4 py-3.5 text-[14px] text-mute border-b border-shade">{t('localDict.empty')}</p>
          )}
          {list.map((d, i) => (
            <div key={d.id} className={`px-4 py-3 flex flex-col gap-2 border-b border-shade ${fresh === d.id ? 'bg-accent-soft/60' : ''}`}>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2.5 flex-1 min-w-0">
                  <input
                    type="checkbox"
                    checked={d.enabled}
                    disabled={d.broken}
                    className="w-5 h-5 shrink-0 accent-accent"
                    aria-label={t('localDict.enabled')}
                    onChange={e => { void setPhoneDictEnabled(d.id, e.target.checked); }}
                  />
                  <span className="text-[15px] font-medium truncate">{dictLabel(d.title)}</span>
                </label>
                <span className="shrink-0 text-xs text-mute">{formatMb(d.bytes)}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap pl-7">
                <select
                  value={d.lang ?? ''}
                  disabled={d.broken}
                  aria-label={t('localDict.pickLang')}
                  className="min-h-[38px] rounded-[8px] border border-line bg-paper px-2.5 text-[13px] text-ink"
                  onChange={e => { if (e.target.value) void setPhoneDictLang(d.id, e.target.value as DictLang); }}
                >
                  {!d.lang && <option value="">{t('localDict.pickLang')}</option>}
                  {DICT_LANGS.map(l => <option key={l} value={l}>{t(`dict.${l}`)}</option>)}
                </select>
                <div className="flex items-center gap-1.5 ml-auto">
                  <button
                    type="button"
                    disabled={i === 0 || d.broken}
                    aria-label={t('localDict.up')}
                    onClick={() => { void movePhoneDict(d.id, -1); }}
                    className="min-w-[38px] min-h-[38px] px-2 rounded-[8px] bg-shade text-[13px] text-ink disabled:opacity-35"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    disabled={i === list.length - 1 || d.broken}
                    aria-label={t('localDict.down')}
                    onClick={() => { void movePhoneDict(d.id, 1); }}
                    className="min-w-[38px] min-h-[38px] px-2 rounded-[8px] bg-shade text-[13px] text-ink disabled:opacity-35"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    aria-label={t('localDict.remove')}
                    onClick={() => askRemoveDict(d)}
                    className="min-h-[38px] px-3 rounded-[8px] bg-shade text-[13px] text-accent font-medium"
                  >
                    {t('localDict.remove')}
                  </button>
                </div>
              </div>
              {!d.lang && !d.broken && <p className="pl-7 text-xs text-accent">{t('localDict.whichLang')}</p>}
              {d.broken && <p className="pl-7 text-xs text-accent">{t('localDict.broken')}</p>}
              {d.needsReimport && <p className="pl-7 text-xs text-accent">{t('localDict.needsReimport')}</p>}
              {d.attribution && <p className="pl-7 text-[11px] text-mute line-clamp-2 break-all">{d.attribution}</p>}
            </div>
          ))}

          {job && (
            <div className="px-4 py-3.5 flex flex-col gap-2 border-b border-shade" role="status">
              <p className="text-[13px] text-ink">
                {t(job.stage === 'download' ? 'localDict.downloading' : 'localDict.importing', { title: job.title, pct: job.pct })}
              </p>
              <div className="h-2 rounded-full bg-shade overflow-hidden">
                <div
                  className="h-full rounded-full bg-accent transition-all duration-150"
                  style={{ width: `${Math.max(4, Math.min(100, job.pct))}%` }}
                />
              </div>
            </div>
          )}

          {notice && !job && (
            <p role="status" className="px-4 py-2.5 text-[13px] text-mute border-b border-shade">{notice}</p>
          )}

          {errorText && !job && (
            <div role="alert" className="px-4 py-3 flex items-center justify-between gap-3 border-b border-shade bg-accent-soft/50">
              <p className="text-[13px] text-accent flex-1">{errorText}</p>
              {retryable && (
                <button type="button" className={btnSmall} onClick={() => { void retryPhoneDictJob(); }}>
                  {t('m.localDictRetry')}
                </button>
              )}
            </div>
          )}

          <div className="px-4 py-3">
            <button
              type="button"
              disabled={!!job}
              onClick={() => { void handlePickImport(); }}
              className={`${btnSmall} w-full`}
            >
              {t('m.localDictPick')}
            </button>
          </div>
        </div>
        <p className="text-xs text-mute px-1 leading-relaxed">{t('localDict.hint')}</p>
      </section>

      <section className="flex flex-col gap-2" aria-label={t('localDict.recommended')}>
        <p className="text-[13px] text-mute">{t('localDict.recommended')}</p>
        <div className={`${sheet} flex flex-col`}>
          {DICT_LANGS.map(lang => (
            <div key={lang} className="px-4 py-3 flex flex-col gap-2 border-b border-shade last:border-0">
              <span className="text-[13px] font-medium text-mute">{t(`dict.${lang}`)}</span>
              <div className="flex flex-col gap-2">
                {recommendedFor(ui, lang).map(r => {
                  const installed = isInstalled(r, list);
                  const gloss = t(r.gloss === 'zh' ? 'localDict.glossZh' : 'localDict.glossEn');
                  const desc = `${gloss}${r.gloss === 'zh' ? `（${t('localDict.fewer')}）` : ''} · ${r.mb} MB`;
                  return (
                    <div key={r.title} className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-[15px] font-medium truncate">{r.title}</p>
                        <p className="text-xs text-mute">{desc}</p>
                      </div>
                      {installed ? (
                        <span className="shrink-0 text-xs text-mute px-2.5 py-1.5 rounded-lg bg-shade">
                          {t('localDict.installed')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={!!job}
                          onClick={() => { setNotice(''); void downloadPhoneDict(r); }}
                          className="shrink-0 min-h-[38px] px-3.5 rounded-[10px] bg-ink text-inverse text-[13px] font-medium disabled:opacity-45"
                        >
                          {t('ja.download')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2" aria-label={t('ja.settingLabel')}>
        <p className="text-[13px] text-mute">{t('ja.settingLabel')}</p>
        <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] font-medium">{t('ja.settingLabel')}</span>
            {jaInstalled === null ? (
              <span className="text-xs text-mute">{t('m.loading')}</span>
            ) : ja.running ? (
              <span className="text-xs text-mute">{ja.pct}%</span>
            ) : jaInstalled ? (
              <div className="flex items-center gap-2">
                <span className="text-xs text-mute">{t('ja.installed')}</span>
                <button type="button" onClick={askRemoveJa} className="min-h-[38px] px-3 rounded-[8px] bg-shade text-[13px] text-accent font-medium">
                  {t('ja.remove')}
                </button>
              </div>
            ) : (
              <button type="button" onClick={() => { void downloadJa().then(ok => { if (ok) setJaDiskInstalled(true); }); }} className={btnSmall}>
                {t(ja.failed ? 'ja.retry' : 'ja.download')}
              </button>
            )}
          </div>
          {ja.running && (
            <div className="flex flex-col gap-1.5" role="status">
              <p className="text-xs text-mute">{t('ja.downloading', { pct: ja.pct })}</p>
              <div className="h-2 rounded-full bg-shade overflow-hidden">
                <div className="h-full rounded-full bg-accent transition-all duration-150" style={{ width: `${Math.max(4, Math.min(100, ja.pct))}%` }} />
              </div>
            </div>
          )}
          {ja.failed && !ja.running && !jaInstalled && <p role="alert" className="text-xs text-accent">{t('ja.failedShort')}</p>}
          <p className="text-xs text-mute leading-relaxed">{t('ja.settingHint')}</p>
        </div>
      </section>

      {confirmState && <ConfirmModal state={confirmState} onClose={() => setConfirmState(null)} />}
    </>
  );
};
