// OPML podcast subscription import, local subscription storage, Wi-Fi-only preference,
// and Android cellular-download confirmation. Safe on both PWA and Android (no @tauri-apps/* imports).
import { t } from '../utils/i18n';
import { callAndroid, isAndroidNative, type NetworkState } from './platform/androidBridge';

export interface PodcastSub {
  feed: string;
  title: string;
  image?: string;
  lang?: string;
  addedAt: number;
}

export const PODCAST_SUBS_KEY = 'linguaclip_podcast_subs';
export const PODCAST_WIFI_ONLY_KEY = 'linguaclip_podcast_wifi_only';

// Clean untrusted feed titles / labels into plain text (strip tags & control chars).
export function cleanPlainText(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

// Accepts only http(s) URLs; rejects javascript:, data:, file:, relative links, etc.
export function normalizeFeedUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s || !/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

// Canonical key for deduplication (case-insensitive scheme/host, ignores trailing slash on non-root paths).
export function feedDedupKey(raw: string): string {
  const norm = normalizeFeedUrl(raw);
  if (!norm) return raw.trim().toLowerCase();
  const u = new URL(norm);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return `${u.protocol}//${u.host}${path}${u.search}`;
}

export function parseOpml(xml: string, now = Date.now()): PodcastSub[] {
  if (!xml || !xml.trim()) return [];
  if (typeof DOMParser === 'undefined') throw new Error('DOMParser unavailable');
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('invalid XML');
  }
  const outlines = doc.getElementsByTagName('outline');
  const seen = new Set<string>();
  const out: PodcastSub[] = [];
  for (let i = 0; i < outlines.length; i++) {
    const el = outlines[i];
    const rawUrl = el.getAttribute('xmlUrl') ?? el.getAttribute('xmlurl');
    const feed = normalizeFeedUrl(rawUrl);
    if (!feed) continue;
    const key = feedDedupKey(feed);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = cleanPlainText(el.getAttribute('title'))
      || cleanPlainText(el.getAttribute('text'))
      || feed;
    const rawImg = el.getAttribute('imageUrl') ?? el.getAttribute('image');
    const image = normalizeFeedUrl(rawImg) ?? undefined;
    const rawLang = cleanPlainText(el.getAttribute('language') ?? el.getAttribute('lang'));
    out.push({
      feed,
      title,
      ...(image ? { image } : {}),
      ...(rawLang ? { lang: rawLang } : {}),
      addedAt: now,
    });
  }
  return out;
}

export function getPodcastSubs(): PodcastSub[] {
  try {
    const raw = localStorage.getItem(PODCAST_SUBS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: PodcastSub[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const feed = normalizeFeedUrl((item as Record<string, unknown>).feed as string | undefined);
      if (!feed) continue;
      const key = feedDedupKey(feed);
      if (seen.has(key)) continue;
      seen.add(key);
      const title = cleanPlainText((item as Record<string, unknown>).title as string | undefined) || feed;
      const image = normalizeFeedUrl((item as Record<string, unknown>).image as string | undefined) ?? undefined;
      const lang = cleanPlainText((item as Record<string, unknown>).lang as string | undefined) || undefined;
      const addedAt = typeof (item as Record<string, unknown>).addedAt === 'number'
        ? ((item as Record<string, unknown>).addedAt as number)
        : Date.now();
      out.push({ feed, title, ...(image ? { image } : {}), ...(lang ? { lang } : {}), addedAt });
    }
    return out;
  } catch {
    return [];
  }
}

function savePodcastSubs(subs: PodcastSub[]): void {
  try {
    localStorage.setItem(PODCAST_SUBS_KEY, JSON.stringify(subs));
  } catch { /* localStorage unavailable */ }
}

export function isPodcastSubscribed(feed: string, subs: PodcastSub[] = getPodcastSubs()): boolean {
  const key = feedDedupKey(feed);
  return subs.some(s => feedDedupKey(s.feed) === key);
}

export function addPodcastSub(
  sub: Omit<PodcastSub, 'addedAt'> & { addedAt?: number },
): PodcastSub[] {
  const feed = normalizeFeedUrl(sub.feed);
  const current = getPodcastSubs();
  if (!feed) return current;
  const key = feedDedupKey(feed);
  const title = cleanPlainText(sub.title) || feed;
  const image = normalizeFeedUrl(sub.image) ?? undefined;
  const lang = cleanPlainText(sub.lang) || undefined;
  const existingIdx = current.findIndex(s => feedDedupKey(s.feed) === key);
  const next = [...current];
  if (existingIdx >= 0) {
    const prev = next[existingIdx];
    next[existingIdx] = {
      ...prev,
      title: title || prev.title,
      ...(image ? { image } : prev.image ? { image: prev.image } : {}),
      ...(lang ? { lang } : prev.lang ? { lang: prev.lang } : {}),
    };
  } else {
    next.unshift({
      feed,
      title,
      ...(image ? { image } : {}),
      ...(lang ? { lang } : {}),
      addedAt: sub.addedAt ?? Date.now(),
    });
  }
  savePodcastSubs(next);
  return next;
}

export function mergePodcastSubs(subs: PodcastSub[]): { added: number; total: number; list: PodcastSub[] } {
  const current = getPodcastSubs();
  const seen = new Set(current.map(s => feedDedupKey(s.feed)));
  const addedItems: PodcastSub[] = [];
  for (const raw of subs) {
    const feed = normalizeFeedUrl(raw.feed);
    if (!feed) continue;
    const key = feedDedupKey(feed);
    if (seen.has(key)) continue;
    seen.add(key);
    const title = cleanPlainText(raw.title) || feed;
    const image = normalizeFeedUrl(raw.image) ?? undefined;
    const lang = cleanPlainText(raw.lang) || undefined;
    addedItems.push({
      feed,
      title,
      ...(image ? { image } : {}),
      ...(lang ? { lang } : {}),
      addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
    });
  }
  const list = [...current, ...addedItems];
  if (addedItems.length > 0) savePodcastSubs(list);
  return { added: addedItems.length, total: list.length, list };
}

export function removePodcastSub(feed: string): PodcastSub[] {
  const key = feedDedupKey(feed);
  const next = getPodcastSubs().filter(s => feedDedupKey(s.feed) !== key);
  savePodcastSubs(next);
  return next;
}

export function getPodcastWifiOnly(): boolean {
  try {
    return localStorage.getItem(PODCAST_WIFI_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function setPodcastWifiOnly(on: boolean): void {
  try {
    localStorage.setItem(PODCAST_WIFI_ONLY_KEY, on ? '1' : '0');
  } catch { /* localStorage unavailable */ }
}

export async function confirmPodcastDownloadNetwork(): Promise<boolean> {
  if (!isAndroidNative() || !getPodcastWifiOnly()) return true;
  try {
    const net = await callAndroid<NetworkState>('system.networkState');
    if (!net.wifi) {
      return typeof confirm === 'function' ? confirm(t('m.cellularConfirm')) : true;
    }
    return true;
  } catch (e) {
    console.error('[podcast] networkState check failed', e);
    return true;
  }
}
