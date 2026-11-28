/**
 * Checks AI provider presets, per-feature models and provider switching in
 * utils/aiConfig.ts (docs/ai-providers.md), plus that a real AI job sends the
 * feature's model with the provider's headers.
 * Run with: node test-ai-providers.mjs
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = {};
globalThis.localStorage = {
  getItem: k => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const setCfg = c => { store.linguaclip_ai_config = JSON.stringify(c); };

const calls = [];
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  if (String(url).endsWith('/models')) {
    return new Response(JSON.stringify({ data: [
      { id: 'models/gemini-2.5-flash' }, { id: 'models/text-embedding-004' }, { id: 'models/gemini-2.5-pro' },
    ] }), { status: 200 });
  }
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"word":"x","definition":"d","partOfSpeech":"n"}' } }] }), { status: 200 });
};

const out = join(tmpdir(), `ai-providers-${process.pid}.mjs`);
await build({
  stdin: { contents: "export * from './utils/aiConfig.ts'; export { getWordDefinition } from './utils/ai.ts';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  outfile: out,
  plugins: [{
    name: 'stub-tauri-http',
    setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, a => ({ path: a.path, namespace: 'stub' }));
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const fetch = (...a) => globalThis.fetch(...a);' }));
    },
  }],
});
const A = await import(out);

// modelFor: own pick → (batch jobs) desktop line-splitting model → main model.
setCfg({ model: 'main', segmentModel: 'seg', featureModels: { translate: 'cheap' } });
assert.equal(A.modelFor('translate'), 'cheap');
assert.equal(A.modelFor('breakdown'), 'seg', 'batch jobs keep the old segmentModel fallback');
assert.equal(A.modelFor('lookup'), 'main', 'look-up never used segmentModel');
setCfg({ model: 'main', segmentModel: 'seg', featureModels: { translate: '' } });
assert.equal(A.modelFor('translate'), 'main', 'phone "use default" means the main model, not segmentModel');
assert.equal(A.modelFor('cloze'), 'seg', 'never-set jobs keep the old fallback');
setCfg({ model: 'main' });
assert.equal(A.modelFor('cloze'), 'main');
assert.equal(A.aiRouter('cloze'), null, 'no key / url → AI off');

// providerOf: a preset is recognised by its address; anything else is custom.
assert.equal(A.providerOf({ baseUrl: 'https://api.anthropic.com/v1/' }), 'claude');
assert.equal(A.providerOf({ baseUrl: 'https://api.deepseek.com/v1' }), 'custom');
assert.equal(A.providerOf({ baseUrl: '' }), 'custom');
assert.equal(A.providerOf({ baseUrl: '', provider: 'gemini' }), 'gemini');
assert.equal(A.providerOf({ baseUrl: 'https://api.openai.com/v1', provider: 'custom' }), 'custom', 'explicit custom wins over an official address');
assert.equal(A.providerOf({ baseUrl: 'https://proxy.example/v1', provider: 'openai' }), 'custom', 'preset whose address was edited elsewhere');

// Temperature: never for Claude, nor OpenAI reasoning models.
assert.equal(A.sendsTemperature('https://api.openai.com/v1', 'gpt-4o'), true);
assert.equal(A.sendsTemperature('https://api.openai.com/v1', 'gpt-5-mini'), false);
assert.equal(A.sendsTemperature('https://openrouter.ai/api/v1', 'openai/o3-mini'), false);
assert.equal(A.sendsTemperature('https://api.anthropic.com/v1', 'claude-x'), false);

// Headers: Anthropic gets its version + browser-CORS opt-in; others only Bearer.
const h = A.aiHeaders('https://api.anthropic.com/v1', 'k');
assert.equal(h.Authorization, 'Bearer k');
assert.equal(h['anthropic-version'], '2023-06-01');
assert.equal(h['anthropic-dangerous-direct-browser-access'], 'true');
assert.deepEqual(Object.keys(A.aiHeaders('https://api.openai.com/v1', 'k', false)), ['Authorization']);

// Model list: Gemini's "models/" prefix dropped, embeddings filtered out.
assert.deepEqual(A.tidyModelIds(['models/gemini-2.5-pro', 'text-embedding-3-small', 'gpt-4o', 'whisper-1']), ['gemini-2.5-pro', 'gpt-4o']);
assert.deepEqual(A.tidyModelIds(['text-embedding-3-small']), ['text-embedding-3-small'], 'all filtered → keep the raw list');
const listed = await A.listModels(A.AI_PRESETS.gemini.baseUrl, 'g');
assert.deepEqual(listed, ['gemini-2.5-flash', 'gemini-2.5-pro']);
assert.deepEqual(A.getCachedModels(), listed);
A.setCachedModels(['keep']);
await A.listModels(A.AI_PRESETS.gemini.baseUrl, 'g', false);
assert.deepEqual(A.getCachedModels(), ['keep'], 'remember=false leaves the cache alone');

// Switching provider parks the old one's key / models / picks and brings them back.
const start = { model: 'gpt-4o', temperature: 0.7, apiKey: 'sk-o', baseUrl: A.AI_PRESETS.openai.baseUrl, featureModels: { translate: 'gpt-4o-mini' }, autoCloze: true };
const toClaude = A.switchProvider(start, 'claude', ['gpt-4o', 'gpt-4o-mini']);
assert.equal(toClaude.config.baseUrl, 'https://api.anthropic.com/v1');
assert.equal(toClaude.config.apiKey, '');
assert.equal(toClaude.config.model, '');
assert.deepEqual(toClaude.config.featureModels, {});
assert.deepEqual(toClaude.models, []);
assert.equal(toClaude.config.autoCloze, true, 'non-provider settings untouched');
const withKey = { ...toClaude.config, apiKey: 'sk-ant', model: 'claude-x' };
const back = A.switchProvider(withKey, 'openai', ['claude-x']);
assert.equal(back.config.apiKey, 'sk-o');
assert.equal(back.config.model, 'gpt-4o');
assert.deepEqual(back.config.featureModels, { translate: 'gpt-4o-mini' });
assert.deepEqual(back.models, ['gpt-4o', 'gpt-4o-mini']);
assert.equal(back.config.profiles.claude.apiKey, 'sk-ant');
const toCustom = A.switchProvider(back.config, 'custom', []);
assert.equal(toCustom.config.baseUrl, '');
assert.equal(A.providerOf(toCustom.config), 'custom');

// A real look-up call: the look-up model, Claude headers, no temperature, a max_tokens.
calls.length = 0;
setCfg({ provider: 'claude', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant', model: 'claude-main', temperature: 0.7, featureModels: { lookup: 'claude-small' } });
await A.getWordDefinition('x', 'a x b');
const sent = JSON.parse(calls[0].init.body);
assert.equal(calls[0].url, 'https://api.anthropic.com/v1/chat/completions');
assert.equal(sent.model, 'claude-small');
assert.equal('temperature' in sent, false, 'Claude: temperature never sent');
assert.equal(sent.max_tokens, 8192);
assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');

// Same call against OpenAI keeps temperature and has no Claude-only fields.
calls.length = 0;
setCfg({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-o', model: 'gpt-4o', temperature: 0.3 });
await A.getWordDefinition('x', 'a x b');
const sent2 = JSON.parse(calls[0].init.body);
assert.equal(sent2.temperature, 0.3);
assert.equal('max_tokens' in sent2, false);

console.log('test-ai-providers: all passed');
