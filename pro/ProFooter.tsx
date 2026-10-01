import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { openExternal } from '../utils/desktop';
import { useLang, useT } from '../utils/i18n';
import { initLicense, isPro, openBuy, subscribe } from './license';
import { openActivate, openManage } from './LicenseDialogs';

const link = 'underline-offset-4 hover:text-ink hover:underline';
const QQ = '488324265';
const MAIL = 'support@linguaclipapp.com';

// The last lines of Settings in the official app: "Become a
// supporter" + "Enter license key", or thanks + "Manage" once activated; then, for
// everyone, the user group (QQ, click copies) or the email in English.
const ProFooter: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const pro = useSyncExternalStore(subscribe, isPro);
  const [copied, setCopied] = useState(false);
  useEffect(() => { initLicense(); }, []); // re-validates if the last check is a day old
  const contact = () => {
    if (lang === 'zh') navigator.clipboard.writeText(QQ).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }, () => {}); // refused: the number is on screen anyway
    else openExternal(`mailto:${MAIL}`).catch(err => console.error(err));
  };
  return <>
    {pro ? <>
      {t('pro.active')}
      {' · '}
      <button type="button" className={link} onClick={openManage}>{t('pro.manage')}</button>
    </> : <>
      <button type="button" className={link} onClick={openBuy}>{t('pro.support')}</button>
      {' · '}
      <button type="button" className={link} onClick={() => openActivate()}>{t('pro.enterKey')}</button>
    </>}
    <br />
    <button type="button" className={`mt-2 ${link}`} onClick={contact}>{copied ? t('pro.copied') : t('pro.contact')}</button>
  </>;
};

export default ProFooter;
