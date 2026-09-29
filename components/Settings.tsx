import React, { useEffect, useRef, useState } from 'react';
import { AnkiConfig, AIConfig, AudioPaddingConfig, AnkiCardTemplateConfig } from '../types';
import * as Anki from '../utils/anki';
import * as AI from '../utils/ai';
import * as Storage from '../utils/storage';
import { useAnkiConnection } from '../hooks/useAnkiConnection';
import { Seg, Stamp } from './ui';
import SettingsGeneral from './SettingsGeneral';
import SettingsAI from './SettingsAI';
import SettingsAnki from './SettingsAnki';
import SettingsShortcuts from './SettingsShortcuts';
import SettingsTranscribe from './SettingsTranscribe';
import { useT, useLang, setLang, Lang } from '../utils/i18n';
import { openExternal } from '../utils/desktop';
import { ProFooter } from '@pro';

type DeckByLang = NonNullable<AnkiCardTemplateConfig['deckByLang']>;

const SPONSOR_URL = 'https://afdian.com/a/SamuelXiao';

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
  const [aiAutoCloze, setAiAutoCloze] = useState(false);
  const [aiJaCheck, setAiJaCheck] = useState(false);
  const [aiLimits, setAiLimits] = useState<NonNullable<AIConfig['limits']>>({});

  const [sectionLength, setSectionLength] = useState(Storage.DEFAULT_SECTION_LENGTH);
  const [audioPadding, setAudioPadding] = useState<AudioPaddingConfig>({ startPadding: 100, endPadding: 200 });

  const [tab, setTab] = useState<'practice' | 'transcribe' | 'ai' | 'shortcuts' | 'anki'>('practice');
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
    setAiAutoCloze(!!savedAI.autoCloze);
    setAiJaCheck(!!savedAI.jaSegmentAi);
    setAiLimits(savedAI.limits || {});

    const savedPractice = Storage.getPracticeConfig();
    setSectionLength(savedPractice.sectionLength);

    const savedAudioPadding = Storage.getAudioPaddingConfig();
    setAudioPadding(savedAudioPadding);
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
      model: next.model ?? aiModel,
      temperature: next.temperature ?? aiTemperature,
      promptTemplate: next.promptTemplate ?? next.prompt ?? aiPrompt,
      apiKey: next.apiKey ?? aiApiKey,
      baseUrl: next.baseUrl ?? aiBaseUrl,
      segmentModel: next.segmentModel ?? aiSegmentModel,
      autoBreakdown: next.autoBreakdown ?? aiAutoBreakdown,
      autoCloze: next.autoCloze ?? aiAutoCloze,
      jaSegmentAi: next.jaSegmentAi ?? aiJaCheck,
      limits: next.limits ?? aiLimits,
    });
    flashSaved();
  };

  return (
    <div>
      <Seg<typeof tab> className="mb-8" value={tab} onChange={setTab} options={[
        { value: 'practice', label: t('settings.practice') },
        { value: 'transcribe', label: t('settings.transcribe') },
        { value: 'ai', label: 'AI' },
        { value: 'shortcuts', label: t('shortcuts.title') },
        { value: 'anki', label: 'Anki' },
      ]} />

      {tab === 'practice' && (
        <SettingsGeneral
          lang={lang}
          setLang={(v: Lang) => {
            setLang(v);
            flashSaved();
          }}
          sectionLength={sectionLength}
          setSectionLength={(v) => {
            setSectionLength(v);
            Storage.savePracticeConfig({ ...Storage.getPracticeConfig(), sectionLength: v });
            flashSaved();
          }}
          audioPadding={audioPadding}
          setAudioPadding={(v) => {
            setAudioPadding(v);
            Storage.saveAudioPaddingConfig(v);
            flashSaved();
          }}
          onSaved={flashSaved}
        />
      )}

      {tab === 'transcribe' && <SettingsTranscribe onSaved={flashSaved} />}

      {tab === 'shortcuts' && <SettingsShortcuts onSaved={flashSaved} />}

      {tab === 'ai' && (
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
          aiPrompt={aiPrompt}
          setAiPrompt={(v) => {
            setAiPrompt(v);
            saveAI({ promptTemplate: v });
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
          aiSegmentModel={aiSegmentModel}
          setAiSegmentModel={(v) => {
            setAiSegmentModel(v);
            saveAI({ segmentModel: v });
          }}
          aiAutoBreakdown={aiAutoBreakdown}
          setAiAutoBreakdown={(v) => {
            setAiAutoBreakdown(v);
            saveAI({ autoBreakdown: v });
          }}
          aiAutoCloze={aiAutoCloze}
          setAiAutoCloze={(v) => {
            setAiAutoCloze(v);
            saveAI({ autoCloze: v });
          }}
          aiJaCheck={aiJaCheck}
          setAiJaCheck={(v) => {
            setAiJaCheck(v);
            saveAI({ jaSegmentAi: v });
          }}
          aiLimits={aiLimits}
          setAiLimits={(v) => {
            setAiLimits(v);
            saveAI({ limits: v });
          }}
        />
      )}

      {tab === 'anki' && (
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
      )}

      <p className="mt-12 text-center text-xs text-mute">
        {ProFooter ? <ProFooter /> : (
          <button type="button" className="underline-offset-4 hover:text-ink hover:underline" onClick={() => openExternal(SPONSOR_URL).catch(err => console.error(err))}>
            {t('settings.sponsor')}
          </button>
        )}
      </p>

      {savedFlash && (
        <div className="fixed bottom-6 right-6 z-50">
          <Stamp tone="accent-soft" className="shadow-card">{t('settings.savedFlash')}</Stamp>
        </div>
      )}
    </div>
  );
};

export default Settings;
