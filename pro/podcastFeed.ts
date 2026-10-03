import { fetch } from '@tauri-apps/plugin-http';

// Reading a podcast feed: what the paste box was given,
// Apple links turned into their feed, the RSS read into a show and its episodes.
// Everything from a feed is shown as plain text; nothing here is ever HTML.

export type Episode = { guid: string; title: string; date?: number; duration?: number; audio: string };
export type Show = { feed: string; title: string; image?: string; lang: string; episodes: Episode[] };
export type Pasted = { kind: 'apple'; id: string } | { kind: 'closed'; name: string } | { kind: 'feed'; url: string } | { kind: 'bad' };

// The languages the transcription is told by name; anything else is guessed by it.
const ASR = ['en', 'es', 'ja', 'zh', 'fr', 'de', 'ko'];
export const asrLang = (tag: string | null | undefined) => {
  const l = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return ASR.includes(l) ? l : 'auto';
};

export function classifyPaste(text: string): Pasted {
  const s = text.trim();
  const apple = /(?:podcasts|itunes)\.apple\.com\/\S*?\bid(\d+)/i.exec(s);
  if (apple) return { kind: 'apple', id: apple[1] };
  if (/(^|\.|\/\/)spotify\.com\b|^spotify:/i.test(s)) return { kind: 'closed', name: 'Spotify' };
  if (/xiaoyuzhoufm\.com/i.test(s)) return { kind: 'closed', name: '小宇宙' };
  if (/ximalaya\.com/i.test(s)) return { kind: 'closed', name: '喜马拉雅' };
  if (/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s)) return { kind: 'feed', url: s };
  return { kind: 'bad' };
}

// "382", "23:21", "2:06:03" → seconds.
export function parseDuration(s: string | null | undefined): number | undefined {
  const parts = (s ?? '').trim().split(':');
  if (!parts[0] || parts.length > 3 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return undefined;
  return Math.round(parts.reduce((n, p) => n * 60 + Number(p), 0)) || undefined;
}

// One episode across all shows: a guid is only unique inside its own feed.
export const epKey = (feed: string, guid: string) => `${feed}\n${guid}`;

// The downloaded file's name: the title plus a short hash of the episode's key (epKey), so
// two episodes called "Episode 1" don't meet, and the same one always gets the same
// name. The app's Rust side cleans it again before it touches the disk.
export function episodeName(title: string, guid: string): string {
  let h = 0x811c9dc5;
  for (const c of guid) h = Math.imul(h ^ c.codePointAt(0)!, 0x01000193) >>> 0;
  const clean = title.replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);
  return `${clean || 'episode'} [${h.toString(16).padStart(8, '0')}]`;
}

const get = async (url: string) => {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
};

// An Apple Podcasts show / episode link → the show's RSS address.
export async function appleFeed(id: string): Promise<string> {
  const body = await (await get(`https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=podcast`)).json();
  const url = body?.results?.find((r: { feedUrl?: unknown }) => typeof r.feedUrl === 'string')?.feedUrl;
  if (!url) throw new Error('no feed');
  return url;
}

// Only https leaves the app (the http plugin's scope): a plain http feed is asked over https.
export async function loadFeed(url: string): Promise<Show> {
  return parseFeed(await (await get(url.replace(/^http:\/\//i, 'https://'))).text(), url);
}

const kids = (el: Element, name: string) => [...el.children].filter(c => c.localName === name);
// <title> before <itunes:title>; with a prefix, only that one.
const kid = (el: Element | null | undefined, name: string, prefix?: string) => {
  const all = el ? kids(el, name) : [];
  return all.find(c => (prefix ? c.prefix === prefix : !c.prefix)) ?? (prefix ? null : all[0] ?? null);
};
const text = (el: Element | null) => el?.textContent?.trim() ?? '';

export function parseFeed(xml: string, feed: string): Show {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const channel = doc.getElementsByTagName('parsererror').length ? null : doc.querySelector('rss > channel, channel');
  if (!channel) throw new Error('not a feed');
  const image = kid(channel, 'image', 'itunes')?.getAttribute('href') || text(kid(kids(channel, 'image').find(c => !c.prefix), 'url'));
  const episodes: Episode[] = [];
  for (const item of kids(channel, 'item')) {
    const audio = kid(item, 'enclosure')?.getAttribute('url')?.trim();
    if (!audio || !/^https?:\/\//i.test(audio)) continue;
    const date = Date.parse(text(kid(item, 'pubDate')));
    episodes.push({
      guid: text(kid(item, 'guid')) || audio,
      title: text(kid(item, 'title')) || audio,
      date: Number.isNaN(date) ? undefined : date,
      duration: parseDuration(text(kid(item, 'duration', 'itunes'))),
      audio,
    });
  }
  // Newest first; a feed without dates keeps its own order.
  episodes.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
  return { feed, title: text(kid(channel, 'title')) || feed, image: /^https?:\/\//i.test(image) ? image : undefined, lang: asrLang(text(kid(channel, 'language'))), episodes };
}

// The ready-made starter episodes' list (docs/starter.md; shown by Starter.tsx).
export type StarterItem = {
  id: string; version: number; lang: string; level: 1 | 2 | 3;
  title: string; show: string; about: string; seconds: number; bytes: number;
  // srtFor: the same lines written for one UI language (Japanese: kanji for Chinese readers, kana for English ones); else srt.
  audio: string; srt: string; srtFor: { zh?: string; en?: string }; trans: { zh?: string; en?: string }; credit: string;
};

const https = (u: unknown): u is string => typeof u === 'string' && /^https:\/\//.test(u);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

// The list as it came over the network: anything malformed is dropped, item by item.
export function parseStarter(raw: unknown): StarterItem[] {
  const items = (raw as { v?: unknown; items?: unknown })?.v === 1 ? (raw as { items: unknown }).items : null;
  if (!Array.isArray(items)) return [];
  return items.flatMap((it): StarterItem[] => {
    const x = it as Record<string, any>;
    if (!str(x?.id) || !Number.isInteger(x.version) || !str(x.lang) || ![1, 2, 3].includes(x.level)) return [];
    if (!str(x.title) || !str(x.show) || !https(x.audio) || !https(x.srt) || !str(x.credit)) return [];
    const trans: StarterItem['trans'] = {};
    if (https(x.trans?.zh)) trans.zh = x.trans.zh;
    if (https(x.trans?.en)) trans.en = x.trans.en;
    const srtFor: StarterItem['srtFor'] = {};
    if (https(x.srtFor?.zh)) srtFor.zh = x.srtFor.zh;
    if (https(x.srtFor?.en)) srtFor.en = x.srtFor.en;
    return [{
      id: x.id, version: x.version, lang: x.lang, level: x.level, title: x.title, show: x.show,
      about: str(x.about) ? x.about : '', seconds: Number(x.seconds) || 0, bytes: Number(x.bytes) || 0,
      audio: x.audio, srt: x.srt, srtFor, trans, credit: x.credit,
    }];
  });
}
