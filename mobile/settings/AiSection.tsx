// Phone Settings → AI tab (docs/ai-providers.md): pick OpenAI / Claude / Gemini / a custom
// OpenAI-compatible address, paste a key, fetch the provider's model list, then choose a
// default model and, optionally, a different one per AI job (look-up, Break it down, …).
import React, { useRef, useState } from 'react';
import {
  AI_FEATURES, AI_PRESETS, getAIConfig, getCachedModels, isBadKey, listModels, normalizeBaseUrl,
  providerOf, saveAIConfig, setCachedModels, switchProvider, type AiFeature, type AiProvider,
} from '../../utils/aiConfig';
import { useT } from '../../utils/i18n';
import type { AIConfig } from '../../types';
import { btnSmall, sheet } from '../ui';
import { Chips } from './Chips';
import { field, keyField } from './TranscribeSection';

const DEEPSEEK_KEYS_URL = 'https://platform.deepseek.com/api_keys';
const noAuto = { autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false } as const;

// A <select> over the fetched list; a saved id the list lacks still shows.
const ModelSelect: React.FC<{ value: string; models: string[]; empty: string; onChange: (v: string) => void; label: string }> = ({ value, models, empty, onChange, label }) => (
  <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className={`${field} min-w-0`}>
    <option value="">{empty}</option>
    {(value && !models.includes(value) ? [value, ...models] : models).map(m => <option key={m} value={m}>{m}</option>)}
  </select>
);

export const AiSection: React.FC = () => {
  const t = useT();
  const [cfg, setCfg] = useState<AIConfig>(getAIConfig);
  const [models, setModels] = useState<string[]>(getCachedModels);
  const [fetching, setFetching] = useState(false);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [manual, setManual] = useState(false);
  const provider = providerOf(cfg);
  // Bumped on every provider switch: a model list that comes back for the old one is dropped.
  const gen = useRef(0);

  // Every edit is saved at once (trimmed); the field keeps what was typed.
  const patch = (p: Partial<AIConfig>) => {
    setCfg(prev => ({ ...prev, ...p }));
    const clean = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    saveAIConfig({ ...getAIConfig(), ...clean });
  };

  const pickProvider = (next: AiProvider) => {
    if (next === provider) return;
    gen.current += 1;
    setFetching(false);
    const res = switchProvider(getAIConfig(), next, models);
    saveAIConfig(res.config);
    setCachedModels(res.models);
    setCfg(res.config);
    setModels(res.models);
    setFetchMsg(null);
    setManual(false);
  };

  const key = cfg.apiKey ?? '';
  const badKey = !!key && isBadKey(key.trim());
  const canFetch = !!key.trim() && !badKey && !!normalizeBaseUrl(cfg.baseUrl) && !fetching;

  const fetchModels = async () => {
    const mine = gen.current;
    setFetching(true);
    setFetchMsg(null);
    try {
      const list = await listModels(cfg.baseUrl ?? '', key.trim(), false);
      if (mine !== gen.current) return;
      setCachedModels(list);
      setModels(list);
      setFetchMsg({ ok: true, text: t('m.aiFetched', { n: list.length }) });
    } catch (e) {
      if (mine !== gen.current) return;
      setFetchMsg({ ok: false, text: t('m.aiFetchFailed', { err: e instanceof Error ? e.message : String(e) }) });
    } finally {
      if (mine === gen.current) setFetching(false);
    }
  };

  const setFeature = (f: AiFeature, v: string) => {
    // '' = the user picked "use default" here (aiConfig.modelFor), not "never set".
    patch({ featureModels: { ...cfg.featureModels, [f]: v } });
  };

  const missing = [
    !key.trim() || badKey ? t('m.aiNeedKey') : '',
    !normalizeBaseUrl(cfg.baseUrl) ? t('m.aiNeedUrl') : '',
    !cfg.model?.trim() ? t('m.aiNeedModel') : '',
  ].filter(Boolean);
  const preset = provider === 'custom' ? null : AI_PRESETS[provider];

  return (
    <section className="flex flex-col gap-2" data-testid="settings-ai">
      <p className="text-[13px] text-mute">{t('m.aiTitle')}</p>
      <p className="text-[13px] text-mute px-1">{t('m.aiHelp')}</p>

      <p className="text-[13px] text-mute pt-2">{t('m.aiProvider')}</p>
      <Chips label={t('m.aiProvider')} value={provider} onChange={pickProvider} options={[
        { value: 'openai', label: AI_PRESETS.openai.label },
        { value: 'claude', label: AI_PRESETS.claude.label },
        { value: 'gemini', label: AI_PRESETS.gemini.label },
        { value: 'custom', label: t('m.aiProviderCustom') },
      ]} />

      <div className={`${sheet} flex flex-col`}>
        {!preset && (
          <label className="px-4 py-3 flex flex-col gap-1.5 border-b border-shade">
            <span className="text-[15px]">{t('m.aiUrl')}</span>
            <input type="url" className={field} placeholder="https://api.deepseek.com/v1" value={cfg.baseUrl ?? ''} {...noAuto}
              onChange={e => patch({ baseUrl: e.target.value })} />
          </label>
        )}
        <label className="px-4 py-3 flex flex-col gap-1.5">
          <span className="text-[15px]">{t('m.aiKey')}</span>
          <input type="text" autoComplete="off" className={keyField} placeholder={preset?.placeholder ?? 'sk-...'} value={key} {...noAuto}
            onChange={e => patch({ apiKey: e.target.value })} />
          {badKey && <span className="text-[13px] text-accent">{t('settingsAI.apiKeyBad')}</span>}
          {preset ? (
            <span className="text-[13px] text-mute">
              {t('m.aiKeysAt')}{' '}
              <a className="text-accent break-all" href={preset.keysUrl} target="_blank" rel="noreferrer">{preset.keysUrl.replace(/^https:\/\//, '')}</a>
            </span>
          ) : (
            <span className="text-[13px] text-mute leading-relaxed">
              {t('m.aiCustomHelp')} {t('m.w3AiRecommend')}{' '}
              <a className="text-accent break-all" href={DEEPSEEK_KEYS_URL} target="_blank" rel="noreferrer">platform.deepseek.com/api_keys</a>
            </span>
          )}
        </label>
      </div>

      <div className={`${sheet} px-4 py-3.5 flex flex-col gap-2.5`}>
        <div className="flex items-center justify-between gap-3">
          <span className="text-[15px] font-medium">{t('m.aiDefaultModel')}</span>
          <button type="button" className={btnSmall} disabled={!canFetch} onClick={() => void fetchModels()}>
            {fetching ? t('m.aiFetching') : t('m.aiFetch')}
          </button>
        </div>
        {manual ? (
          <input type="text" aria-label={t('m.aiDefaultModel')} className={field} value={cfg.model ?? ''} {...noAuto}
            onChange={e => patch({ model: e.target.value })} />
        ) : (
          <ModelSelect label={t('m.aiDefaultModel')} value={cfg.model ?? ''} models={models}
            empty={models.length ? t('m.aiPickModel') : t('m.aiFetchFirst')} onChange={v => patch({ model: v })} />
        )}
        <div className="flex items-start justify-between gap-3">
          <p role="status" className={`text-[13px] leading-relaxed ${fetchMsg && !fetchMsg.ok ? 'text-accent' : 'text-mute'}`}>
            {fetchMsg ? fetchMsg.text : t('m.aiDefaultModelHelp')}
          </p>
          <button type="button" className="shrink-0 text-[13px] text-accent min-h-[32px]" onClick={() => setManual(m => !m)}>
            {manual ? t('m.aiManualOff') : t('m.aiManual')}
          </button>
        </div>
      </div>

      <p className="text-[13px] text-mute pt-2">{t('m.aiPerFeature')}</p>
      <div className={`${sheet} flex flex-col`}>
        {AI_FEATURES.map(f => (
          <label key={f} className="px-4 py-2.5 flex items-center justify-between gap-3 border-b border-shade last:border-0">
            <span className="text-[15px] shrink-0">{t(`m.aiFeat_${f}`)}</span>
            <span className="w-[58%]">
              <ModelSelect label={t(`m.aiFeat_${f}`)} value={cfg.featureModels?.[f] ?? ''} models={models}
                empty={t('m.aiUseDefault')} onChange={v => setFeature(f, v)} />
            </span>
          </label>
        ))}
      </div>
      <p className="text-[13px] text-mute px-1">{t('m.aiPerFeatureHelp')}</p>

      <p data-testid="ai-status" className={`text-[13px] px-1 ${missing.length ? 'text-mute' : 'text-ink'}`}>
        {missing.length ? t('m.aiNotReady', { what: missing.join(' / ') }) : `✓ ${t('m.aiReady')}`}
      </p>
    </section>
  );
};
