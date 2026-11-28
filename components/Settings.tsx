import React, { useEffect, useRef, useState } from 'react';
import { Languages, SunMoon } from 'lucide-react';
import { AnkiConfig, AIConfig, AnkiCardTemplateConfig } from '../types';
import * as Anki from '../utils/anki';
import * as AI from '../utils/ai';
import * as Storage from '../utils/storage';
import { useAnkiConnection } from '../hooks/useAnkiConnection';
import { useT, useLang, setLang, Lang } from '../utils/i18n';
import { useThemePref, ThemePref } from '../utils/theme';
import { Seg, Stamp } from './ui';
import SettingsPractice from './SettingsPractice';
import SettingsLookup from './SettingsLookup';
import SettingsCards from './SettingsCards';
import SettingsTranscribe from './SettingsTranscribe';
import SettingsAI, { AiAfterImport, AiPrompt } from './SettingsAI';
import SettingsAnki from './SettingsAnki';
import SettingsData from './SettingsData';

type DeckByLang = NonNullable<AnkiCardTemplateConfig['deckByLang']>;

// Always shown as "中文" / "English" in their own language, regardless of the current UI language.
const LANG_OPTS: { value: Lang; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
];

type Layer = 'practice' | 'importAi' | 'data';

type AnkiPatch = {
  url?: string;
  deckName?: string;
  modelName?: string;
  fieldMapping?: Record<string, string>;
  deckByLang?: DeckByLang;
};

const Settings: React.FC = () => {
  const t = useT();
  const lang = useLang();
  const [themePref, setThemePref] = useThemePref();
  const [deckName, setDeckName] = useState('');
  const [modelName, setModelName] = useState('');
  const [fieldMapping, setFieldMapping] = useState<Record<string, string>>({});
  const [deckByLang, setDeckByLang] = useState<DeckByLang>({});

  const [aiModel, setAiModel] = useState('');
  const [aiTemperature, setAiTemperature] = useState(0.7);
  const [aiPrompt, setAiPrompt] = useState(AI.DEFAULT_PROMPT);
  const [aiApiKey, setAiApiKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiSegmentModel, setAiSegmentModel] = useState('');
  const [aiAutoBreakdown, setAiAutoBreakdown] = useState(false);
  const [aiBreakdownSounds, setAiBreakdownSounds] = useState(true);
  const [aiAutoCloze, setAiAutoCloze] = useState(false);
  const [aiAutoKeywords, setAiAutoKeywords] = useState(false);
  const [aiAutoPhrases, setAiAutoPhrases] = useState(false);
  const [aiJaCheck, setAiJaCheck] = useState(false);
  const [aiLimits, setAiLimits] = useState<NonNullable<AIConfig['limits']>>({});
  const [cachedModels, setCachedModels] = useState<string[]>(() => AI.getCachedModels());

  const [sectionLength, setSectionLength] = useState(Storage.DEFAULT_SECTION_LENGTH);
  const [clipsVer, setClipsVer] = useState(0);

  const [layer, setLayer] = useState<Layer>('practice');
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<number>(0);
  const ankiConnection = useAnkiConnection();

  const flashSaved = () => {
    setSavedFlash(true);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setSavedFlash(false), 1500);
  };

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  useEffect(() => {
    const savedAnki = Anki.getAnkiConfig();
    if (savedAnki) {
      ankiConnection.setUrl(savedAnki.url);
      if (savedAnki.card) {
        setDeckName(savedAnki.card.deckName);
        setModelName(savedAnki.card.modelName);
        setFieldMapping(savedAnki.card.fieldMapping || {});
        setDeckByLang(savedAnki.card.deckByLang || {});
      }
      ankiConnection.connect(savedAnki.url);
    }

    const savedAI = AI.getAIConfig();
    setAiModel(savedAI.model);
    setAiTemperature(savedAI.temperature);
    setAiPrompt(savedAI.promptTemplate || AI.DEFAULT_PROMPT);
    setAiApiKey(savedAI.apiKey || '');
    setAiBaseUrl(savedAI.baseUrl || '');
    setAiSegmentModel(savedAI.segmentModel || '');
    setAiAutoBreakdown(!!savedAI.autoBreakdown);
    setAiBreakdownSounds(savedAI.breakdownSounds !== false);
    setAiAutoCloze(!!savedAI.autoCloze);
    setAiAutoKeywords(!!savedAI.autoKeywords);
    setAiAutoPhrases(!!savedAI.autoPhrases);
    setAiJaCheck(!!savedAI.jaSegmentAi);
    setAiLimits(savedAI.limits || {});

    const savedPractice = Storage.getPracticeConfig();
    setSectionLength(savedPractice.sectionLength);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const buildAnkiConfig = (patch: AnkiPatch = {}): AnkiConfig => {
    const url = patch.url ?? ankiConnection.url;
    const d = patch.deckName ?? deckName;
    const m = patch.modelName ?? modelName;
    const map = patch.fieldMapping ?? fieldMapping;
    const byLang = patch.deckByLang ?? deckByLang;
    return { url, card: d && m ? { deckName: d, modelName: m, fieldMapping: map, deckByLang: byLang } : null };
  };

  const saveAnki = (patch: AnkiPatch = {}) => {
    Anki.saveAnkiConfig(buildAnkiConfig(patch));
    flashSaved();
  };

  // Throws on failure; SettingsAnki shows the message next to the button.
  const createLinguaClip = async () => {
    const card = await Anki.setupLinguaClipCard(ankiConnection.url);
    setDeckName(card.deckName);
    setModelName(card.modelName);
    setFieldMapping(card.fieldMapping);
    saveAnki(card);
    ankiConnection.connect(); // pick up the new deck / note type in the dropdowns
    return card;
  };

  const saveAI = (next: Partial<AIConfig> & { prompt?: string } = {}) => {
    AI.saveAIConfig({
      ...AI.getAIConfig(), // keep fields this page does not show (phone's provider / per-feature models)
      model: next.model ?? aiModel,
      temperature: next.temperature ?? aiTemperature,
      promptTemplate: next.promptTemplate ?? next.prompt ?? aiPrompt,
      apiKey: next.apiKey ?? aiApiKey,
      baseUrl: next.baseUrl ?? aiBaseUrl,
      segmentModel: next.segmentModel ?? aiSegmentModel,
      autoBreakdown: next.autoBreakdown ?? aiAutoBreakdown,
      breakdownSounds: next.breakdownSounds ?? aiBreakdownSounds,
      autoCloze: next.autoCloze ?? aiAutoCloze,
      autoKeywords: next.autoKeywords ?? aiAutoKeywords,
      autoPhrases: next.autoPhrases ?? aiAutoPhrases,
      jaSegmentAi: next.jaSegmentAi ?? aiJaCheck,
      limits: next.limits ?? aiLimits,
    });
    flashSaved();
  };

  const badAiKey = AI.isBadKey(aiApiKey);
  const aiReady = !!(aiApiKey && !badAiKey && aiBaseUrl.trim() && (aiModel.trim() || aiSegmentModel.trim()));

  const jumpTo = (target: Layer, anchorId: string) => {
    setLayer(target);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.getElementById(anchorId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  };
  const goAI = () => jumpTo('importAi', 'settings-ai-connect');
  const goLookup = () => jumpTo('practice', 'settings-lookup');
  const goImport = () => jumpTo('importAi', 'settings-ai-tidy');

  return (
    <div>
      <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
        <Seg<Layer> className="flex-wrap" value={layer} onChange={setLayer} options={[
          { value: 'practice', label: t('settings.layerPractice') },
          { value: 'importAi', label: t('settings.layerImportAi') },
          { value: 'data', label: t('settings.layerData') },
        ]} />
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-mute">
          <div className="flex items-center gap-2" title={t('settings.language')}>
            <Languages size={16} aria-hidden />
            <Seg<Lang> size="sm" value={lang} onChange={v => { setLang(v); flashSaved(); }} options={LANG_OPTS} />
          </div>
          <div className="flex items-center gap-2" title={`${t('theme.title')}：${t('theme.hint')}`}>
            <SunMoon size={16} aria-hidden />
            <Seg<ThemePref> size="sm" value={themePref} onChange={v => { setThemePref(v); flashSaved(); }} options={[
              { value: 'system', label: t('theme.system') },
              { value: 'light', label: t('theme.light') },
              { value: 'dark', label: t('theme.dark') },
            ]} />
          </div>
        </div>
      </div>

      {layer === 'practice' && (
        <div className="space-y-10">
          <SettingsPractice
            sectionLength={sectionLength}
            setSectionLength={(v) => {
              setSectionLength(v);
              Storage.savePracticeConfig({ ...Storage.getPracticeConfig(), sectionLength: v });
              flashSaved();
            }}
            onSaved={flashSaved}
          />
          <SettingsLookup onSaved={flashSaved} aiReady={AI.aiReady()} goAI={goAI}>
            <AiPrompt
              aiReady={AI.aiReady() /* the same check word lookup makes: needs the main model */}
              goAI={goAI}
              prompt={aiPrompt}
              setPrompt={(v) => {
                setAiPrompt(v);
                saveAI({ promptTemplate: v });
              }}
            />
          </SettingsLookup>
          <SettingsCards onSaved={flashSaved} />
        </div>
      )}

      {layer === 'importAi' && (
        <div className="space-y-10">
          <SettingsTranscribe onSaved={flashSaved}>
            <AiAfterImport
              aiReady={aiReady}
              goAI={goAI}
              cachedModels={cachedModels}
              segmentModel={aiSegmentModel}
              setSegmentModel={(v) => {
                setAiSegmentModel(v);
                saveAI({ segmentModel: v });
              }}
              autoBreakdown={aiAutoBreakdown}
              setAutoBreakdown={(v) => {
                setAiAutoBreakdown(v);
                saveAI({ autoBreakdown: v });
              }}
              breakdownSounds={aiBreakdownSounds}
              setBreakdownSounds={(v) => {
                setAiBreakdownSounds(v);
                saveAI({ breakdownSounds: v });
              }}
              autoCloze={aiAutoCloze}
              setAutoCloze={(v) => {
                setAiAutoCloze(v);
                saveAI({ autoCloze: v });
              }}
              autoKeywords={aiAutoKeywords}
              setAutoKeywords={(v) => {
                setAiAutoKeywords(v);
                saveAI({ autoKeywords: v });
              }}
              autoPhrases={aiAutoPhrases}
              setAutoPhrases={(v) => {
                setAiAutoPhrases(v);
                saveAI({ autoPhrases: v });
              }}
              jaCheck={aiJaCheck}
              setJaCheck={(v) => {
                setAiJaCheck(v);
                saveAI({ jaSegmentAi: v });
              }}
            />
          </SettingsTranscribe>
          <SettingsAI
            aiModel={aiModel}
            setAiModel={(v) => {
              setAiModel(v);
              saveAI({ model: v });
            }}
            aiTemperature={aiTemperature}
            setAiTemperature={(v) => {
              setAiTemperature(v);
              saveAI({ temperature: v });
            }}
            aiApiKey={aiApiKey}
            setAiApiKey={(v) => {
              setAiApiKey(v);
              saveAI({ apiKey: v });
            }}
            aiBaseUrl={aiBaseUrl}
            setAiBaseUrl={(v) => {
              setAiBaseUrl(v);
              saveAI({ baseUrl: v });
            }}
            aiLimits={aiLimits}
            setAiLimits={(v) => {
              setAiLimits(v);
              saveAI({ limits: v });
            }}
            goLookup={goLookup}
            goImport={goImport}
            onModelsFetched={setCachedModels}
          />
        </div>
      )}

      {layer === 'data' && (
        <SettingsData
          onSaved={flashSaved}
          clipsVer={clipsVer}
          onClipsChanged={() => setClipsVer(v => v + 1)}
          anki={
            <SettingsAnki
              url={ankiConnection.url}
              setUrl={(v) => {
                ankiConnection.setUrl(v);
                saveAnki({ url: v });
              }}
              status={ankiConnection.status}
              error={ankiConnection.error}
              onConnect={() => ankiConnection.connect()}
              decks={ankiConnection.decks}
              models={ankiConnection.models}
              deckName={deckName}
              setDeckName={(v) => {
                setDeckName(v);
                saveAnki({ deckName: v });
              }}
              modelName={modelName}
              setModelName={(v) => {
                setModelName(v);
                saveAnki({ modelName: v });
              }}
              fieldMapping={fieldMapping}
              setFieldMapping={setFieldMapping}
              fetchModelFields={ankiConnection.fetchModelFields}
              saveAnki={saveAnki}
              createLinguaClip={createLinguaClip}
              deckByLang={deckByLang}
              setDeckByLang={(v) => {
                setDeckByLang(v);
                saveAnki({ deckByLang: v });
              }}
              refreshDecks={() => ankiConnection.connect()}
            />
          }
        />
      )}

      {savedFlash && (
        <div className="fixed bottom-6 right-6 z-50">
          <Stamp tone="accent-soft" className="shadow-card">{t('settings.savedFlash')}</Stamp>
        </div>
      )}
    </div>
  );
};

export default Settings;
