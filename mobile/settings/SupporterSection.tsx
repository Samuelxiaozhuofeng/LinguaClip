// Settings → Supporter section (docs/android-roadmap.md M2.5, docs/private/activation.md):
// Android native only (hidden on PWA). Delegates ALL supporter status, verification, activation,
// and device management to pro/license.ts — never computes supporter state anywhere else,
// and never gates any feature (every feature is free for everyone).
import React, { useEffect, useRef, useState } from 'react';
import type * as LicenseMod from '../../pro/license';
import type { ActivateFail, Device } from '../../pro/license';
import { useLang, useT, type DictKey } from '../../utils/i18n';
import { isAndroidNative } from '../platform/androidBridge';
import { getLicenseRuntime } from '../review/nativeRuntime';
import { btnPrimary, btnSmall, btnSoft, sheet } from '../ui';

const QQ = '488324265';
const MAIL = 'support@linguaclipapp.com';

const ERR_KEY: Record<Exclude<ActivateFail, 'limit'>, DictKey> = {
  invalid: 'pro.errInvalid',
  revoked: 'pro.errRevoked',
  busy: 'pro.errBusy',
  offline: 'pro.errOffline',
  device: 'pro.errDevice',
  save: 'pro.errSave',
  test: 'pro.errTest',
  verify: 'pro.errVerify',
};

const fmtDate = (at: number) => (at ? new Date(at).toLocaleDateString() : '');

const DeviceRow: React.FC<{
  d: Device;
  mine: boolean;
  keyStr: string;
  lic: typeof LicenseMod;
  onGone: () => void;
}> = ({ d, mine, keyStr, lic, onGone }) => {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  const run = async () => {
    setBusy(true);
    setErr(false);
    try {
      if (await lic.removeDevice(keyStr, d.instance)) {
        setConfirming(false);
        onGone();
      } else {
        setErr(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="py-3 flex flex-col gap-2 border-b border-shade last:border-0">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[15px] text-ink truncate">
            {d.name}
            {mine && <span className="ml-2 text-xs text-accent font-medium">{t('pro.thisComputer')}</span>}
          </div>
          <div className="text-xs text-mute">
            {err ? <span className="text-accent">{t('pro.removeFail')}</span> : t('pro.activatedAt', { date: fmtDate(d.at) })}
          </div>
        </div>
        {!confirming && (
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={btnSoft}>
            {mine ? t('pro.deactivate') : t('pro.remove')}
          </button>
        )}
      </div>
      {confirming && (
        <div className="rounded-xl bg-shade px-3 py-2.5 flex flex-col gap-2">
          <p className="text-xs text-ink leading-relaxed">
            {mine ? t('m.supporterConfirmDeactivate') : t('m.supporterConfirmRemove', { name: d.name })}
          </p>
          <div className="flex gap-2 justify-end">
            <button type="button" disabled={busy} onClick={() => setConfirming(false)} className={btnSoft}>
              {t('m.cancel')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run()}
              className="min-h-[44px] px-4 rounded-[10px] bg-accent text-white text-sm font-medium disabled:opacity-50"
            >
              {busy ? t('pro.removing') : t('m.supporterConfirmOk')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
};

const ActivateSheet: React.FC<{
  lic: typeof LicenseMod;
  onClose: () => void;
  onActivated: () => void;
}> = ({ lic, onClose, onActivated }) => {
  const t = useT();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [full, setFull] = useState<Device[] | null>(null);

  const submit = async () => {
    if (busy || !key.trim()) return;
    setBusy(true);
    setErr('');
    try {
      const r = await lic.activate(key);
      if (r.ok) {
        onActivated();
        onClose();
      } else if (r.why === 'limit') {
        setFull(r.devices ?? []);
      } else {
        setFull(null);
        setErr(t(ERR_KEY[r.why ?? 'offline']));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-end" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pro.keyTitle')}
        className="w-full max-h-[85vh] supports-[height:1dvh]:max-h-[85dvh] overflow-y-auto bg-page rounded-t-3xl px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-3.5"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold text-ink">{t('pro.keyTitle')}</h2>
        <p className="text-[13px] text-mute leading-relaxed">{t('pro.keyHint')}</p>
        <input
          value={key}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
          onChange={e => { setKey(e.target.value); setErr(''); setFull(null); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          className="h-12 rounded-xl border border-line px-3.5 text-[15px] font-mono bg-page outline-none focus:border-ink"
        />
        {err && <p role="alert" className="text-[13px] text-accent leading-relaxed">{err}</p>}
        {full && (
          <div className="flex flex-col gap-1">
            <p className="text-[13px] text-ink leading-relaxed">{t('pro.limitTitle')}</p>
            <ul>
              {full.map(d => (
                <DeviceRow
                  key={d.instance}
                  d={d}
                  mine={false}
                  keyStr={key.replace(/\s+/g, '')}
                  lic={lic}
                  onGone={() => void submit()}
                />
              ))}
            </ul>
            {full.length < 3 && <p className="text-xs text-mute">{t('pro.limitMissing')}</p>}
          </div>
        )}
        <div className="flex gap-2.5 pt-1">
          <button type="button" onClick={onClose} className={`${btnSoft} flex-1 min-h-[48px]`}>
            {t('m.cancel')}
          </button>
          <button
            type="button"
            disabled={busy || !key.trim()}
            onClick={() => void submit()}
            className={`${btnPrimary} flex-1`}
          >
            {busy ? t('pro.activating') : t('pro.activate')}
          </button>
        </div>
      </div>
    </div>
  );
};

const ManageSheet: React.FC<{
  lic: typeof LicenseMod;
  onClose: () => void;
  onDeactivated: () => void;
}> = ({ lic, onClose, onDeactivated }) => {
  const t = useT();
  const key = lic.activeKey();
  const mine = lic.thisInstance();
  const [list, setList] = useState<Device[] | null | 'fail'>(null);

  const load = () => {
    setList(null);
    if (!key) { setList([]); return; }
    void lic.devices(key).then(l => setList(l ?? 'fail'));
  };
  useEffect(load, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const gone = (d: Device) => {
    if (d.instance === mine) {
      onDeactivated();
      onClose();
    } else {
      load();
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-end" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('pro.manageTitle')}
        className="w-full max-h-[85vh] supports-[height:1dvh]:max-h-[85dvh] overflow-y-auto bg-page rounded-t-3xl px-5 pt-5 pb-[max(20px,env(safe-area-inset-bottom))] flex flex-col gap-3"
        onClick={e => e.stopPropagation()}
      >
        <h2 className="text-[18px] font-semibold text-ink">{t('pro.manageTitle')}</h2>
        <p className="text-[13px] text-mute">{t('pro.manageHint')}</p>
        <div className="min-h-[3rem]">
          {list === null && <p className="text-sm text-mute py-2">{t('pro.loading')}</p>}
          {list === 'fail' && (
            <div className="flex flex-col gap-2 py-1">
              <p className="text-sm text-accent">{t('pro.loadFail')}</p>
              <button type="button" onClick={load} className={`${btnSoft} self-start`}>{t('m.retry')}</button>
            </div>
          )}
          {Array.isArray(list) && key && (
            <ul>
              {list.map(d => (
                <DeviceRow key={d.instance} d={d} mine={d.instance === mine} keyStr={key} lic={lic} onGone={() => gone(d)} />
              ))}
            </ul>
          )}
        </div>
        <button type="button" onClick={onClose} className={`${btnSoft} w-full min-h-[48px]`}>
          {t('pro.close')}
        </button>
      </div>
    </div>
  );
};

export const SupporterSection: React.FC = () => {
  const android = isAndroidNative();
  const t = useT();
  const lang = useLang();
  const [lic, setLic] = useState<typeof LicenseMod | null>(null);
  const [pro, setPro] = useState(false);
  const [modal, setModal] = useState<'activate' | 'manage' | null>(null);
  const [banner, setBanner] = useState('');
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    if (!android) return () => { mounted.current = false; };
    let unsub: (() => void) | null = null;
    void getLicenseRuntime().then(mod => {
      if (!mod || !mounted.current) return;
      setLic(mod);
      setPro(mod.isPro());
      unsub = mod.subscribe(() => { if (mounted.current) setPro(mod.isPro()); });
      void mod.initLicense();
    });
    return () => {
      mounted.current = false;
      unsub?.();
    };
  }, [android]);

  if (!android) return null;

  const contact = () => {
    if (lang === 'zh') {
      navigator.clipboard?.writeText(QQ).then(
        () => { setCopied(true); window.setTimeout(() => setCopied(false), 2000); },
        () => {},
      );
    } else if (lic) {
      window.open(`mailto:${MAIL}`, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <>
      <section className="flex flex-col gap-2">
        <p className="text-[13px] text-mute">{t('m.supporterTitle')}</p>
        <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
          {pro ? (
            <>
              <p className="text-[15px] font-medium text-ink">{t('pro.active')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!lic} onClick={() => { setBanner(''); setModal('manage'); }} className={btnSoft}>
                  {t('pro.manage')}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-xs text-mute leading-relaxed">{t('m.supporterFreeNote')}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={!lic} onClick={() => { setBanner(''); setModal('activate'); }} className={btnSmall}>
                  {t('pro.enterKey')}
                </button>
                <button type="button" disabled={!lic} onClick={() => lic?.openBuy()} className={btnSoft}>
                  {t('pro.support')}
                </button>
              </div>
            </>
          )}
          {banner && <p role="status" className="text-[13px] text-ink">{banner}</p>}
          <button
            type="button"
            onClick={contact}
            className="self-start min-h-[44px] text-xs text-mute underline underline-offset-4"
          >
            {copied ? t('pro.copied') : t('pro.contact')}
          </button>
        </div>
      </section>

      {lic && modal === 'activate' && (
        <ActivateSheet
          lic={lic}
          onClose={() => setModal(null)}
          onActivated={() => setBanner(`${t('pro.activated')} · ${t('pro.activatedBody')}`)}
        />
      )}
      {lic && modal === 'manage' && (
        <ManageSheet
          lic={lic}
          onClose={() => setModal(null)}
          onDeactivated={() => setBanner(t('pro.deactivated'))}
        />
      )}
    </>
  );
};
