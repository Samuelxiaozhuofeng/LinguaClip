/**
 * Android local import pure logic tests (mobile/platform/importAndroid.ts):
 * - Resumable chunk planning & doneIndices skipping
 * - Android import error parsing & i18n formatting
 * - Attached .srt validation & long-line splitting
 * - Default audio track selection (including AC-3 unsupported fallback)
 * Run with: node mobile/test-import-android.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(tmpdir(), `mobile-import-android-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './mobile/platform/importAndroid';", resolveDir: '.', loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: out,
  logLevel: 'error',
});

const {
  selectDefaultTrack,
  validateAndPrepareSrt,
  computePendingPieces,
  parseAndroidImportError,
  formatAndroidImportError,
} = await import(out);

// 1. Default track selection
assert.equal(selectDefaultTrack([]), -1);
assert.equal(
  selectDefaultTrack([
    { index: 0, mime: 'audio/ac3', language: 'en', sampleRate: 48000, channels: 6, isDefault: true, supported: false },
    { index: 1, mime: 'audio/mp4a-latm', language: 'ja', sampleRate: 48000, channels: 2, isDefault: false, supported: true },
    { index: 2, mime: 'audio/mp4a-latm', language: 'en', sampleRate: 48000, channels: 2, isDefault: true, supported: true },
  ]),
  2,
  'prefers first isDefault && supported track',
);
assert.equal(
  selectDefaultTrack([
    { index: 0, mime: 'audio/ac3', language: 'en', sampleRate: 48000, channels: 6, isDefault: true, supported: false },
    { index: 1, mime: 'audio/mp4a-latm', language: 'ja', sampleRate: 48000, channels: 2, isDefault: false, supported: true },
  ]),
  1,
  'skips unsupported AC-3 track even when marked default',
);
assert.equal(
  selectDefaultTrack([
    { index: 0, mime: 'audio/ac3', language: 'en', sampleRate: 48000, channels: 6, isDefault: true, supported: false },
    { index: 1, mime: 'audio/vnd.dts', language: 'ja', sampleRate: 48000, channels: 6, isDefault: false, supported: false },
  ]),
  -1,
  'returns -1 when every audio track is unsupported',
);

// 2. Resumable chunk plan computation
const samplePlan = {
  planId: 'abc123',
  lang: 'ja',
  pieceSecs: 3600,
  wavSamples: 16000 * 7200,
  pieces: [
    { index: 0, fromSample: 0, toSample: 16000 * 3600, offsetMs: 0 },
    { index: 1, fromSample: 16000 * 3600, toSample: 16000 * 7200, offsetMs: 3600_000 },
    { index: 2, fromSample: 16000 * 7200, toSample: 16000 * 9000, offsetMs: 7200_000 },
  ],
  doneIndices: [2, 0, 99, 0], // unordered, duplicate, and out-of-range indices
};
const planRes = computePendingPieces(samplePlan);
assert.equal(planRes.totalCount, 3);
assert.equal(planRes.doneCount, 2);
assert.deepEqual([...planRes.doneSet].sort(), [0, 2]);
assert.deepEqual(planRes.pending.map(p => p.index), [1]);

const allDoneRes = computePendingPieces({ ...samplePlan, doneIndices: [0, 1, 2] });
assert.equal(allDoneRes.doneCount, 3);
assert.equal(allDoneRes.pending.length, 0);

// 3. Attached .srt validation & splitLongLines integration
assert.throws(() => validateAndPrepareSrt('', true), /srt:empty/);
assert.throws(() => validateAndPrepareSrt('not a valid srt file at all', true), /srt:empty/);

const validSrt = '\uFEFF1\n00:00:00,000 --> 00:00:02,000\nHello world.\n\n2\n00:00:02,500 --> 00:00:04,000\nNice to meet you.\n';
const checked = validateAndPrepareSrt(validSrt, true);
assert.equal(checked.count, 2);
assert.ok(!checked.text.startsWith('\uFEFF'), 'strips UTF-8 BOM');

const longLineSrt = '1\n00:00:00,000 --> 00:00:15,000\n'
  + 'This is a very long subtitle sentence that has far more than sixteen words so it should be split into shorter chunks for listening practice.\n';
const splitOn = validateAndPrepareSrt(longLineSrt, true);
const splitOff = validateAndPrepareSrt(longLineSrt, false);
assert.ok(splitOn.count >= 2, `expected long line to split, got ${splitOn.count}`);
assert.equal(splitOff.count, 1, 'splitLong=false preserves original single cue');

// 4. Error code parsing & user-facing formatting
const ac3Err = parseAndroidImportError(new Error('audio:unsupported_codec:audio/ac3'));
assert.equal(ac3Err.code, 'audio:unsupported_codec:audio/ac3');
assert.equal(ac3Err.codec, 'audio/ac3');
assert.ok(formatAndroidImportError(ac3Err.code).includes('audio/ac3'));

assert.equal(parseAndroidImportError(new Error('audio:no_track')).code, 'audio:no_track');
assert.equal(parseAndroidImportError(new Error('audio:reimport')).code, 'audio:reimport');
assert.equal(parseAndroidImportError(new Error('cloud:missing-url')).code, 'cloud:missing-url');
assert.equal(parseAndroidImportError(new Error('cancelled')).code, 'cancelled');
assert.equal(parseAndroidImportError(new Error('srt:empty')).code, 'srt:empty');

for (const code of ['audio:no_track', 'audio:reimport', 'cloud:missing-url', 'cancelled', 'srt:empty', 'download:timeout', 'cloud:nokey']) {
  const msg = formatAndroidImportError(code);
  assert.ok(typeof msg === 'string' && msg.length > 0, `empty formatted message for ${code}`);
}

console.log('mobile/test-import-android.mjs ok');
