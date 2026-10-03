import React, { useState } from 'react';
import * as AI from '../utils/ai';
import { Btn, Field, Group, inputCls } from './ui';
import { useT } from '../utils/i18n';
import { AIConfig } from '../types';
import { AiKind, LIMIT_DEFAULTS, LIMIT_MAX } from '../utils/aiLimit';

type Limits = NonNullable<AIConfig['limits']>;
const LIMIT_KINDS: AiKind[] = ['segment', 'breakdown', 'cloze'];

const Check: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }> = ({ checked, onChange, label, disabled }) => (
  <label className={`flex items-center gap-2.5 text-sm ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
    <input type="checkbox" checked={checked && !disabled} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="w-4 h-4 accent-accent" />
    {label}
  </label>
);


// Models are picked from the provider's own list ("Fetch models"), never typed.
// A plain <select>: the app's WKWebView does not pop a datalist open. A saved
// model the list does not have (or before any fetch) still shows as an option.
const ModelPicker: React.FC<{
  value: string;
  onChange: (value: string) => void;
  models: string[];
  emptyLabel: string;
}> = ({ value, onChange, models, emptyLabel }) => (
  <select value={value} onChange={(e) => onChange(e.target.value)} className={`${inputCls} font-mono`}>
    <option value="">{emptyLabel}</option>
    {(value && !models.includes(value) ? [value, ...models] : models).map((m) => <option key={m} value={m}>{m}</option>)}
  </select>
);

const NeedAi: React.FC<{ goAI: () => void }> = ({ goAI }) => {
  const t = useT();
  return (
    <span className="flex items-center gap-2 mt-1.5 text-xs text-mute leading-relaxed">
      {t('settingsAI.afterImportNeedAi')}
      <Btn type="button" size="sm" flat onClick={goAI}>{t('settings.goAi')}</Btn>
    </span>
  );
};

// Settings → Import & transcribe: what the AI does with a fresh transcript.
export const AiAfterImport: React.FC<{
  aiReady: boolean;
  goAI: () => void;
  segmentModel: string;
  setSegmentModel: (v: string) => void;
  autoBreakdown: boolean;
  setAutoBreakdown: (v: boolean) => void;
  breakdownSounds: boolean;
  setBreakdownSounds: (v: boolean) => void;
  autoCloze: boolean;
  setAutoCloze: (v: boolean) => void;
  autoKeywords: boolean;
  setAutoKeywords: (v: boolean) => void;
  jaCheck: boolean;
  setJaCheck: (v: boolean) => void;
}> = ({ aiReady, goAI, segmentModel, setSegmentModel, autoBreakdown, setAutoBreakdown, breakdownSounds, setBreakdownSounds, autoCloze, setAutoCloze, autoKeywords, setAutoKeywords, jaCheck, setJaCheck }) => {
  const t = useT();
  return (
    <Group title={t('settings.group.aiTidy')}>
      <Field label={t('settingsAI.segmentModel')} hint={t('settingsAI.segmentModelHint')}>
        <ModelPicker value={segmentModel} onChange={setSegmentModel} models={AI.getCachedModels()} emptyLabel={t('settingsAI.segmentModelPlaceholder')} />
      </Field>

      <div>
        <span className="block text-sm font-medium mb-2.5">{t('settingsAI.afterImport')}</span>
        <div className="space-y-2">
          <Check checked={autoBreakdown} onChange={setAutoBreakdown} disabled={!aiReady} label={t('settingsAI.autoBreakdown')} />
          <Check checked={autoCloze} onChange={setAutoCloze} disabled={!aiReady} label={t('settingsAI.autoCloze')} />
          <Check checked={autoKeywords} onChange={setAutoKeywords} disabled={!aiReady} label={t('settingsAI.autoKeywords')} />
        </div>
        {aiReady ? <span className="block mt-1.5 text-xs text-mute leading-relaxed">{t('settingsAI.afterImportHint')}</span> : <NeedAi goAI={goAI} />}
      </div>

      <div>
        <Check checked={breakdownSounds} onChange={setBreakdownSounds} disabled={!aiReady} label={t('settingsAI.breakdownSounds')} />
        {aiReady ? <span className="block mt-1.5 text-xs text-mute leading-relaxed">{t('settingsAI.breakdownSoundsHint')}</span> : <NeedAi goAI={goAI} />}
      </div>

      <div>
        <Check checked={jaCheck} onChange={setJaCheck} disabled={!aiReady} label={t('settingsAI.jaCheck')} />
        {aiReady ? <span className="block mt-1.5 text-xs text-mute leading-relaxed">{t('settingsAI.jaCheckHint')}</span> : <NeedAi goAI={goAI} />}
      </div>
    </Group>
  );
};

// Settings → Look up: the prompt used when the dictionary has no entry.
// Settings → Look up → ③ AI: the prompt stays folded — most never change it.
export const AiPrompt: React.FC<{ aiReady: boolean; goAI: () => void; prompt: string; setPrompt: (v: string) => void }> = ({ aiReady, goAI, prompt, setPrompt }) => {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      {!aiReady && (
        <span className="flex items-center gap-2 text-xs text-mute">
          {t('settings.promptNeedAi')}
          <Btn type="button" size="sm" flat onClick={goAI}>{t('settings.goAi')}</Btn>
        </span>
      )}
      {open ? (
        <Field
          label={t('settingsAI.promptTemplate')}
          right={<Btn type="button" size="sm" flat onClick={() => setPrompt(AI.DEFAULT_PROMPT)}>{t('settingsAI.reset')}</Btn>}
          hint={t('settingsAI.promptHint')}
        >
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} className={`${inputCls} min-h-32 font-mono`} placeholder={t('settingsAI.promptPlaceholder')} />
        </Field>
      ) : (
        <Btn type="button" size="sm" flat onClick={() => setOpen(true)}>{t('settingsAI.editPrompt')}</Btn>
      )}
    </>
  );
};

interface SettingsAIProps {
  aiModel: string;
  setAiModel: (value: string) => void;
  aiTemperature: number;
  setAiTemperature: (value: number) => void;
  aiApiKey: string;
  setAiApiKey: (value: string) => void;
  aiBaseUrl: string;
  setAiBaseUrl: (value: string) => void;
  aiLimits: Limits;
  setAiLimits: (value: Limits) => void;
  goTab: (tab: 'lookup' | 'import') => void;
}

// Settings → AI: only "connect to an AI"; the features that use it live on their own tabs.
const SettingsAI: React.FC<SettingsAIProps> = ({
  aiModel, setAiModel, aiTemperature, setAiTemperature, aiApiKey, setAiApiKey, aiBaseUrl, setAiBaseUrl, aiLimits, setAiLimits, goTab,
}) => {
  const t = useT();
  const [models, setModels] = useState<string[]>(() => AI.getCachedModels());
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const badKey = AI.isBadKey(aiApiKey);

  const fetchModels = async () => {
    setFetching(true);
    setFetchError('');
    try {
      setModels(await AI.listModels(aiBaseUrl, aiApiKey));
    } catch (e) {
      setModels([]);
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  };

  return (
    <div className="space-y-10">
      <Group title={t('settings.group.aiConnect')}>
        <Field
          label={t('settingsAI.apiKey')}
          hint={badKey ? <span className="text-ink">{t('settingsAI.apiKeyBad')}</span> : t('settingsAI.apiKeyHint')}
        >
          <input
            type="password"
            value={aiApiKey}
            onChange={(e) => setAiApiKey(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder={t('settingsAI.apiKeyPlaceholder')}
          />
        </Field>

        <Field label={t('settingsAI.baseUrl')} hint={t('settingsAI.baseUrlHint')}>
          <input
            type="text"
            value={aiBaseUrl}
            onChange={(e) => setAiBaseUrl(e.target.value)}
            className={`${inputCls} font-mono`}
            placeholder="https://api.openai.com/v1"
          />
        </Field>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Field
            label={t('settingsAI.model')}
            right={
              <Btn type="button" size="sm" flat disabled={!aiApiKey || badKey || !aiBaseUrl.trim() || fetching} onClick={() => void fetchModels()}>
                {fetching ? t('settingsAI.fetching') : t('settingsAI.fetchModels')}
              </Btn>
            }
            hint={
              fetchError
                ? `${t('settingsAI.fetchFailed')} ${fetchError}`
                : models.length > 0
                  ? t('settingsAI.fetchedCount').replace('{n}', String(models.length))
                  : t('settingsAI.modelHint')
            }
          >
            <ModelPicker
              value={aiModel}
              onChange={setAiModel}
              models={models}
              emptyLabel={models.length > 0 ? t('settingsAI.pickModel') : t('settingsAI.fetchFirst')}
            />
          </Field>

          <Field
            label={t('settingsAI.temperature')}
            right={String(aiTemperature)}
            hint={t('settingsAI.temperatureHint')}
          >
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={aiTemperature}
              onChange={(e) => setAiTemperature(parseFloat(e.target.value))}
            />
          </Field>
        </div>
      </Group>

      <Group title={t('settings.group.aiSpeed')}>
        <div>
          <span className="block text-sm font-medium mb-2.5">{t('settingsAI.limits')}</span>
          <div className="grid grid-cols-3 gap-3">
            {LIMIT_KINDS.map(kind => (
              <label key={kind} className="block">
                <span className="block text-xs text-mute mb-1">{t(`settingsAI.limit_${kind}`)}</span>
                <input
                  type="number"
                  min={1}
                  max={LIMIT_MAX}
                  step={1}
                  value={aiLimits[kind] ?? ''}
                  placeholder={String(LIMIT_DEFAULTS[kind])}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    setAiLimits({ ...aiLimits, [kind]: Number.isFinite(n) ? Math.min(Math.max(n, 1), LIMIT_MAX) : undefined });
                  }}
                  className={`${inputCls} font-mono`}
                />
              </label>
            ))}
          </div>
          <span className="block mt-1.5 text-xs text-mute leading-relaxed">{t('settingsAI.limitsHint', { max: LIMIT_MAX })}</span>
        </div>
      </Group>

      <Group title={t('settings.group.aiUsedBy')}>
        <div className="space-y-2 text-sm">
          {([['lookup', 'settings.aiUsedByLookup', 'settings.lookup'], ['import', 'settings.aiUsedByImport', 'settings.import']] as const).map(([tab, what, where]) => (
            <p key={tab} className="flex items-center justify-between gap-3">
              <span>{t(what)}</span>
              <Btn type="button" size="sm" flat onClick={() => goTab(tab)}>{t(where)} →</Btn>
            </p>
          ))}
          <p className="text-mute">{t('settings.aiUsedByPractice')}</p>
        </div>
      </Group>
    </div>
  );
};


export default SettingsAI;
