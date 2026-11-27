import type { VideoRecord } from '../types';
import type { t as tr } from '../utils/i18n';
import { getSyncConfig } from '../utils/syncConfig';
import { formatAudioMB, sendVideoAudioToPhone, type SyncAudioSnapshot } from '../utils/syncAudio';
import type { MenuItem } from './ui';
import { dialog } from './Dialog';
import { formatSyncError } from './SyncHost';

function triggerSend(videoId: string, t: typeof tr): void {
  sendVideoAudioToPhone(videoId)
    .then(res => {
      if ('reason' in res) void dialog.alert(t('sync.title'), formatSyncError(res.reason, t));
    })
    .catch(err => {
      void dialog.alert(t('sync.title'), formatSyncError(err instanceof Error ? err.message : String(err), t));
    });
}

export function audioSyncMenuItem(v: VideoRecord, snap: SyncAudioSnapshot, t: typeof tr): MenuItem | null {
  if (!getSyncConfig().enabled || v.importJob || v.podcast || !v.videoPath) return null;
  if (snap.sendingIds.includes(v.id)) {
    return { label: t('sync.sendingAudio'), onClick: () => {}, disabled: true };
  }
  const offer = snap.audioOffers[v.id];
  if (offer) {
    return { label: t('sync.audioWaitingPhone', { size: formatAudioMB(offer.bytes) }), onClick: () => {}, disabled: true };
  }
  if (snap.deliveredAudioIds.includes(v.id)) {
    return { label: t('sync.audioDeliveredResend'), onClick: () => triggerSend(v.id, t) };
  }
  return { label: t('sync.sendAudio'), onClick: () => triggerSend(v.id, t) };
}

export function audioSyncBadgeText(v: VideoRecord, snap: SyncAudioSnapshot, t: typeof tr): string | null {
  if (!getSyncConfig().enabled || v.importJob || v.podcast) return null;
  if (snap.sendingIds.includes(v.id)) return t('sync.sendingAudio');
  if (snap.audioOffers[v.id]) return t('sync.audioSentNote');
  return null;
}
