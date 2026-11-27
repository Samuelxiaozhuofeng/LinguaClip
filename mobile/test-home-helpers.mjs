/**
 * Pure helper tests for W3 (mobile/homeHelpers.ts & mobile/pendingImportStore.ts):
 * - Chinese/English language display names & ISO-639-2/BCP-47 normalization
 * - Audio track language auto-matching (bilingual videos, skipping unsupported tracks)
 * - Today review completion detection, empty week card hiding, first-practice gate
 * - Desktop vs phone missing audio classification
 * - In-memory pending import preservation across Settings round-trip
 * Run with: node mobile/test-home-helpers.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-home-helpers-${process.pid}.mjs`);
await build({
  stdin: {
    contents: [
      "export * from './mobile/homeHelpers';",
      "export * from './mobile/pendingImportStore';",
    ].join('\n'),
    resolveDir: '.',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});

const store = new Map();
globalThis.localStorage = {
  getItem: k => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

const {
  normalizeLangCode,
  phoneLangName,
  matchTrackForLang,
  isSameLocalDay,
  reviewedToday,
  isWeekEmpty,
  hasEverPracticed,
  isDesktopPath,
  isWebAudioMissing,
  getPendingImport,
  setPendingImportStore,
  savePendingAndroidImport,
  clearPendingImport,
} = await import(out);

// 1. Language code normalization & Chinese/English names
assert.equal(normalizeLangCode('en'), 'en');
assert.equal(normalizeLangCode('eng'), 'en');
assert.equal(normalizeLangCode('en-US'), 'en');
assert.equal(normalizeLangCode('jpn'), 'ja');
assert.equal(normalizeLangCode('ja_JP'), 'ja');
assert.equal(normalizeLangCode('fre'), 'fr');
assert.equal(normalizeLangCode('ger'), 'de');
assert.equal(normalizeLangCode('zho'), 'zh');
assert.equal(normalizeLangCode('und'), '');

assert.equal(phoneLangName('en', 'zh'), '英语');
assert.equal(phoneLangName('ja', 'zh'), '日语');
assert.equal(phoneLangName('es', 'zh'), '西班牙语');
assert.equal(phoneLangName('fr', 'zh'), '法语');
assert.equal(phoneLangName('de', 'zh'), '德语');
assert.equal(phoneLangName('ko', 'zh'), '韩语');
assert.equal(phoneLangName('jpn', 'zh'), '日语');
assert.equal(phoneLangName('en', 'en'), 'English');
assert.equal(phoneLangName('ja', 'en'), 'Japanese');
assert.equal(phoneLangName('ko', 'en'), 'Korean');

// 2. Bilingual video track matching
const bilingualTracks = [
  { index: 0, mime: 'audio/mp4a-latm', language: 'zho', sampleRate: 48000, channels: 2, isDefault: true, supported: true },
  { index: 1, mime: 'audio/ac3', language: 'jpn', sampleRate: 48000, channels: 6, isDefault: true, supported: false },
  { index: 2, mime: 'audio/mp4a-latm', language: 'jpn', sampleRate: 48000, channels: 2, isDefault: false, supported: true },
  { index: 3, mime: 'audio/mp4a-latm', language: 'en-US', sampleRate: 48000, channels: 2, isDefault: false, supported: true },
];
assert.equal(matchTrackForLang(bilingualTracks, 'ja'), 2, 'skips unsupported AC-3 Japanese track and picks supported AAC track');
assert.equal(matchTrackForLang(bilingualTracks, 'en'), 3, 'matches en-US for en');
assert.equal(matchTrackForLang(bilingualTracks, 'zh'), 0, 'matches zho for zh');
assert.equal(matchTrackForLang(bilingualTracks, 'de'), null, 'returns null when language is not in tracks');
assert.equal(matchTrackForLang(bilingualTracks, 'auto'), null, 'auto does not override default track');

// 3. Reviewed today check
const noon = new Date(2026, 10, 24, 12, 0, 0).getTime();
const morning = new Date(2026, 10, 24, 8, 30, 0).getTime();
const yesterday = new Date(2026, 10, 23, 23, 59, 0).getTime();
assert.equal(isSameLocalDay(morning, noon), true);
assert.equal(isSameLocalDay(yesterday, noon), false);
assert.equal(isSameLocalDay(undefined, noon), false);
assert.equal(reviewedToday([], noon), false);
assert.equal(reviewedToday([{ fsrs: { last_review: yesterday } }], noon), false);
assert.equal(reviewedToday([{ fsrs: { last_review: morning } }], noon), true);
assert.equal(reviewedToday([{ fsrs: {}, mastered: morning }], noon), true);

// 4. Empty week check & hasEverPracticed gate
const zeroDays = Array.from({ length: 7 }, () => ({ sec: 0, lines: 0 }));
assert.equal(isWeekEmpty(zeroDays, 0), true);
assert.equal(isWeekEmpty(zeroDays, 1), false);
assert.equal(isWeekEmpty([...zeroDays.slice(0, 6), { sec: 5, lines: 0 }], 0), false);
assert.equal(isWeekEmpty([...zeroDays.slice(0, 6), { sec: 0, lines: 1 }], 0), false);

assert.equal(hasEverPracticed(noon), false);
store.set('linguaclip_days', JSON.stringify({ '2026-10-01': { sec: 30, lines: 2 } }));
assert.equal(hasEverPracticed(noon), true);
store.set('linguaclip_days', JSON.stringify({ '2026-10-01': { sec: 0, lines: 0 } }));
assert.equal(hasEverPracticed(noon), false);

// 5. Desktop path & web missing audio detection
assert.equal(isDesktopPath('/Users/alice/Movies/ep1.mp4'), true);
assert.equal(isDesktopPath('C:\\Users\\Alice\\Videos\\ep1.mp4'), true);
assert.equal(isDesktopPath('/home/alice/ep1.mp4'), true);
assert.equal(isDesktopPath('/data/user/0/com.linguaclip.app/files/media/a.m4a'), false);
assert.equal(isDesktopPath('blob:abc'), false);
assert.equal(isDesktopPath('https://example.com/a.mp3'), false);

const have = new Set(['local-ok']);
assert.equal(isWebAudioMissing({ id: '1', videoPath: 'https://x/a.mp3', subtitleText: 'x' }, have), false);
assert.equal(isWebAudioMissing({ id: '2', videoPath: '/starter/en-1.mp3', subtitleText: 'x' }, have), false);
assert.equal(isWebAudioMissing({ id: '3', videoPath: 'blob:local-ok', subtitleText: 'x' }, have), false);
assert.equal(isWebAudioMissing({ id: '4', videoPath: 'blob:missing', subtitleText: 'x' }, have), true);
assert.equal(isWebAudioMissing({ id: '5', videoPath: '/Users/alice/Movies/ep.mp4', subtitleText: 'x' }, have), true);
assert.equal(isWebAudioMissing({ id: '6', videoPath: undefined, subtitleText: 'x' }, have), true);

// 6. Pending import store
assert.equal(getPendingImport(), null);
setPendingImportStore({
  kind: 'android',
  uri: 'content://doc/42',
  probe: { displayName: 'clip.mp4', sizeBytes: 1000, mime: 'video/mp4', tracks: bilingualTracks, defaultTrackIndex: 0 },
  trackIndex: 2,
  lang: 'ja',
  waitingForKey: true,
});
assert.equal(getPendingImport()?.kind, 'android');
assert.equal(getPendingImport()?.trackIndex, 2);
assert.equal(getPendingImport()?.lang, 'ja');
clearPendingImport();
assert.equal(getPendingImport(), null);

// 7. Shared Android pending import helper (used by both Home picker and App ACTION_SEND share intake)
const savedShare = savePendingAndroidImport(
  'content://media/external/video/99',
  { displayName: 'shared-drama.mkv', sizeBytes: 2048, mime: 'video/x-matroska', tracks: bilingualTracks, defaultTrackIndex: 0 },
  { trackIndex: 3, lang: 'en', srtText: '1\n00:00:00,000 --> 00:00:01,000\nhi\n', srtName: 'sub.srt' },
);
assert.equal(savedShare.kind, 'android');
assert.equal(savedShare.waitingForKey, true);
assert.equal(getPendingImport()?.uri, 'content://media/external/video/99');
assert.equal(getPendingImport()?.trackIndex, 3);
assert.equal(getPendingImport()?.lang, 'en');
assert.equal(getPendingImport()?.srt?.name, 'sub.srt');
clearPendingImport();
assert.equal(getPendingImport(), null);

console.log('mobile/test-home-helpers.mjs ok');
