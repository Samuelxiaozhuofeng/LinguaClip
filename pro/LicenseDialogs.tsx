import React, { useEffect, useState } from 'react';
import { Btn, Card, inputCls } from '../components/ui';
import { dialog } from '../components/Dialog';
import { useT, t as tt, type DictKey } from '../utils/i18n';
import { activate, activeKey, devices, initLicense, removeDevice, thisInstance, type ActivateFail, type Device } from './license';

// The activation box (enter a key; on "3 computers already" pick one to remove) and
// the manage box (computers on this key; deactivate this one / remove another).
// Mounted once at the root as <ProHost />; opened through openActivate / openManage.

type Open = { kind: 'activate'; done: (ok: boolean) => void } | { kind: 'manage' } | null;
let show: ((o: Open) => void) | null = null;

export const openActivate = () => new Promise<boolean>(done => show ? show({ kind: 'activate', done }) : done(false));
export const openManage = () => show?.({ kind: 'manage' });

const errText: Record<Exclude<ActivateFail, 'limit'>, DictKey> = {
  invalid: 'pro.errInvalid', revoked: 'pro.errRevoked', busy: 'pro.errBusy', offline: 'pro.errOffline', device: 'pro.errDevice', save: 'pro.errSave', test: 'pro.errTest', verify: 'pro.errVerify',
};

const when = (at: number) => at ? new Date(at).toLocaleDateString() : '';

// One computer on the key, with its Remove / Deactivate button (asks first).
const DeviceRow: React.FC<{ d: Device; mine: boolean; keyStr: string; onGone: () => void }> = ({ d, mine, keyStr, onGone }) => {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const go = async () => {
    const sure = await dialog.confirm(mine ? t('pro.deactivateTitle') : t('pro.removeTitle', { name: d.name }), mine ? t('pro.deactivateBody') : t('pro.removeBody'), {
      ok: mine ? t('pro.deactivate') : t('pro.remove'), danger: true,
    });
    if (sure !== true) return;
    setBusy(true); setErr(false);
    try {
      if (await removeDevice(keyStr, d.instance)) onGone(); else setErr(true);
    } finally { setBusy(false); }
  };
  return (
    <li className="py-3 flex items-center gap-3 border-b border-line last:border-0">
      <div className="flex-1 min-w-0">
        <div className="text-sm text-ink truncate">{d.name}{mine && <span className="ml-2 text-xs text-accent">{t('pro.thisComputer')}</span>}</div>
        <div className="text-xs text-mute">{err ? <span className="text-accent">{t('pro.removeFail')}</span> : t('pro.activatedAt', { date: when(d.at) })}</div>
      </div>
      <Btn size="sm" disabled={busy} onClick={go}>{busy ? t('pro.removing') : mine ? t('pro.deactivate') : t('pro.remove')}</Btn>
    </li>
  );
};

const ActivateBox: React.FC<{ close: (ok: boolean) => void }> = ({ close }) => {
  const t = useT();
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [full, setFull] = useState<Device[] | null>(null);

  const submit = async () => {
    if (busy || !key.trim()) return;
    setBusy(true); setErr('');
    try {
      const r = await activate(key);
      if (r.ok) {
        close(true);
        dialog.alert(tt('pro.activated'), tt('pro.activatedBody'));
      } else if (r.why === 'limit') setFull(r.devices ?? []);
      else { setFull(null); setErr(t(errText[r.why ?? 'offline'])); }
    } finally { setBusy(false); }
  };

  return <>
    <p className="px-6 pb-3 text-sm text-mute leading-relaxed">{t('pro.keyHint')}</p>
    <div className="px-6">
      <input
        autoFocus value={key} spellCheck={false} autoComplete="off" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
        onChange={e => { setKey(e.target.value); setErr(''); setFull(null); }}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        className={`${inputCls} font-mono`}
      />
      {err && <p className="mt-2 text-sm text-accent">{err}</p>}
      {full && <div className="mt-3">
        <p className="text-sm text-ink">{t('pro.limitTitle')}</p>
        <ul className="mt-1">{full.map(d => <DeviceRow key={d.instance} d={d} mine={false} keyStr={key.replace(/\s+/g, '')} onGone={submit} />)}</ul>
        {full.length < 3 && <p className="mt-2 text-xs text-mute">{t('pro.limitMissing')}</p>}
      </div>}
    </div>
    <div className="px-6 pt-5 pb-6 flex justify-end gap-3">
      <Btn onClick={() => close(false)}>{t('dialog.cancel')}</Btn>
      <Btn tone="accent" disabled={busy || !key.trim()} onClick={submit}>{busy ? t('pro.activating') : t('pro.activate')}</Btn>
    </div>
  </>;
};

const ManageBox: React.FC<{ close: () => void }> = ({ close }) => {
  const t = useT();
  const key = activeKey();
  const [list, setList] = useState<Device[] | null | 'fail'>(null);
  const load = () => { setList(null); if (key) devices(key).then(l => setList(l ?? 'fail')); else setList([]); };
  useEffect(load, [key]);
  const mine = thisInstance();

  const gone = (d: Device) => {
    if (d.instance === mine) { close(); dialog.alert(tt('pro.deactivated')); }
    else load();
  };

  return <>
    <p className="px-6 pb-2 text-sm text-mute">{t('pro.manageHint')}</p>
    <div className="px-6 min-h-[3rem]">
      {list === null && <p className="text-sm text-mute">{t('pro.loading')}</p>}
      {list === 'fail' && <p className="text-sm text-accent">{t('pro.loadFail')}</p>}
      {Array.isArray(list) && key && <ul>{list.map(d => <DeviceRow key={d.instance} d={d} mine={d.instance === mine} keyStr={key} onGone={() => gone(d)} />)}</ul>}
    </div>
    <div className="px-6 pt-4 pb-6 flex justify-end gap-3">
      <Btn onClick={close}>{t('pro.close')}</Btn>
    </div>
  </>;
};

export const ProHost: React.FC = () => {
  const t = useT();
  const [open, setOpen] = useState<Open>(null);

  useEffect(() => { show = setOpen; initLicense(); return () => { show = null; }; }, []);

  const close = (ok = false) => {
    if (open?.kind === 'activate') open.done(ok);
    setOpen(null);
  };

  // Bubble phase: while a confirm (components/Dialog) is on top, it stops the key first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!open) return null;
  const title = open.kind === 'activate' ? t('pro.keyTitle') : t('pro.manageTitle');
  return (
    <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4 fade-in" onClick={() => close(false)}>
      <Card className="w-full max-w-md shadow-lift" role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="px-6 pt-6 pb-2"><h3 className="text-xl font-semibold leading-tight">{title}</h3></div>
        {open.kind === 'activate' ? <ActivateBox close={close} /> : <ManageBox close={() => close(false)} />}
      </Card>
    </div>
  );
};
