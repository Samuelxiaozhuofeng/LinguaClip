import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { APP_DATA_FIELDS, AnkiCardTemplateConfig } from '../types';
import { AnkiConnectionStatus } from '../hooks/useAnkiConnection';
import { Btn, Card, Field, inputCls } from './ui';
import { useT, DictKey, getLang } from '../utils/i18n';
import { invokeAnki } from '../utils/anki';
import { getAllVideosFromDB } from '../utils/fileSystemAccess';
import { DECK_LANGS, langName, videoLang } from '../utils/deckLang';
import type { DictLang } from '../utils/dictionary';

// APP_DATA_FIELDS lives in types.ts (out of i18n scope) and can't carry translated
// labels directly; map each field's key to its own dictionary entry instead.
const FIELD_LABEL_KEYS: Record<(typeof APP_DATA_FIELDS)[number]['key'], DictKey> = {
  sentence: 'settingsAnki.fieldSentence',
  videoName: 'settingsAnki.fieldVideoName',
  timestamp: 'settingsAnki.fieldTimestamp',
  screenshot: 'settingsAnki.fieldScreenshot',
  audio: 'settingsAnki.fieldAudio',
  word: 'settingsAnki.fieldWord',
  definition: 'settingsAnki.fieldDefinition',
  example: 'settingsAnki.fieldExample',
  context: 'settingsAnki.fieldContext',
};

type Mapping = Record<string, string>;

interface SettingsAnkiProps {
  url: string;
  setUrl: (value: string) => void;
  status: AnkiConnectionStatus;
  error: string;
  onConnect: () => void;
  decks: string[];
  models: string[];
  deckName: string;
  setDeckName: (value: string) => void;
  modelName: string;
  setModelName: (value: string) => void;
  fieldMapping: Mapping;
  setFieldMapping: React.Dispatch<React.SetStateAction<Mapping>>;
  fetchModelFields: (modelName: string) => Promise<string[]>;
  saveAnki: (patch?: { fieldMapping?: Mapping }) => void;
  createLinguaClip: () => Promise<AnkiCardTemplateConfig>;
  deckByLang: DeckByLang;
  setDeckByLang: (value: DeckByLang) => void;
  refreshDecks: () => void;
}

type DeckByLang = NonNullable<AnkiCardTemplateConfig['deckByLang']>;

// One row per language the user's videos are in: which Anki deck its cards go to.
// "Create sub-decks" makes `<target deck>::日语` etc. in Anki for the unset rows and points them at it.
const LangDecks: React.FC<{ url: string; decks: string[]; deckName: string; value: DeckByLang; onChange: (v: DeckByLang) => void; refreshDecks: () => void }> = ({ url, decks, deckName, value, onChange, refreshDecks }) => {
  const t = useT();
  const [langs, setLangs] = useState<DictLang[]>([]);
  const [making, setMaking] = useState<'idle' | 'busy' | string>('idle');
  useEffect(() => {
    getAllVideosFromDB()
      .then(rs => { const got = new Set(rs.map(videoLang)); setLangs(DECK_LANGS.filter((l): l is DictLang => l !== 'other' && got.has(l))); })
      .catch(console.error); // unreadable: no rows, cards keep going to the target deck
  }, []);
  if (langs.length === 0) return null;
  const make = async () => {
    setMaking('busy');
    try {
      const next = { ...value };
      // Only languages with no deck yet: a second click (maybe in the other interface
      // language) never re-points one that is set, so cards don't split across two decks.
      for (const l of langs.filter(l => !value[l])) {
        const name = `${deckName}::${langName(l, getLang(), '')}`;
        await invokeAnki('createDeck', { deck: name }, url);
        next[l] = name;
      }
      onChange(next);
      refreshDecks();
      setMaking('idle');
    } catch (e) {
      setMaking(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div className="mb-4">
      <div className="flex items-center gap-3 mb-1">
        <h4 className="text-sm font-semibold flex-1">{t('settingsAnki.byLang')}</h4>
        <Btn type="button" size="sm" onClick={() => { make().catch(console.error); }} disabled={!deckName || making === 'busy'}>
          {making === 'busy' && <RefreshCw className="w-4 h-4 animate-spin" />}
          {t('settingsAnki.makeLangDecks')}
        </Btn>
      </div>
      <p className="text-xs text-mute mb-3">{t('settingsAnki.byLangHint')}</p>
      {!['idle', 'busy'].includes(making) && <p className="text-sm mb-3">{t('settingsAnki.makeLangDecksFailed')}<span className="text-xs text-mute break-all">{making}</span></p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {langs.map(l => (
          <Field key={l} label={langName(l, getLang(), '')}>
            <select value={value[l] ?? ''} onChange={(e) => onChange({ ...value, [l]: e.target.value || undefined })} className={inputCls}>
              <option value="">{t('settingsAnki.sameDeck')}</option>
              {/* A deck set earlier but gone from Anki stays listed, so the choice isn't silently lost. */}
              {[...new Set([...decks, ...(value[l] ? [value[l]!] : [])])].map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </Field>
        ))}
      </div>
    </div>
  );
};

function pruneMapping(prev: Mapping, fields: string[]): Mapping {
  const next: Mapping = {};
  fields.forEach((f) => {
    if (prev[f]) next[f] = prev[f];
  });
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length === nextKeys.length && nextKeys.every((k) => prev[k] === next[k])) return prev;
  return next;
}

const FieldMap: React.FC<{
  fields: string[];
  mapping: Mapping;
  onChange: (ankiField: string, appDataKey: string) => void;
}> = ({ fields, mapping, onChange }) => {
  const t = useT();
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('settingsAnki.fieldMapping')}</p>
      {fields.map((field) => (
        <div key={field} className="flex items-center gap-3">
          <span className="w-1/3 font-mono text-sm truncate" title={field}>{field}</span>
          <select
            value={mapping[field] || ''}
            onChange={(e) => onChange(field, e.target.value)}
            className={`flex-1 ${inputCls}`}
          >
            <option value="">{t('settingsAnki.leaveEmpty')}</option>
            {APP_DATA_FIELDS.map((opt) => (
              <option key={opt.key} value={opt.key}>{t(FIELD_LABEL_KEYS[opt.key])}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
};

const SettingsAnki: React.FC<SettingsAnkiProps> = ({
  url,
  setUrl,
  status,
  error,
  onConnect,
  decks,
  models,
  deckName,
  setDeckName,
  modelName,
  setModelName,
  fieldMapping,
  setFieldMapping,
  fetchModelFields,
  saveAnki,
  createLinguaClip,
  deckByLang,
  setDeckByLang,
  refreshDecks,
}) => {
  const t = useT();
  const [modelFields, setModelFields] = useState<string[]>([]);
  const [creating, setCreating] = useState<'idle' | 'busy' | 'done' | string>('idle');

  useEffect(() => {
    if (modelName && status === 'success') {
      fetchModelFields(modelName).then((fields) => {
        setModelFields(fields);
        setFieldMapping((prev) => pruneMapping(prev, fields));
      });
    }
  }, [modelName, status, fetchModelFields, setFieldMapping]);

  const updateMapping = (ankiField: string, appDataKey: string) => {
    const next = { ...fieldMapping, [ankiField]: appDataKey };
    setFieldMapping(next);
    saveAnki({ fieldMapping: next });
  };

  const create = async () => {
    setCreating('busy');
    try {
      const card = await createLinguaClip();
      // An existing LinguaClip note type whose fields the user renamed in Anki
      // may leave the must-have ones unmatched: say so instead of "done".
      const got = Object.values(card.fieldMapping);
      setCreating(got.includes('sentence') && got.includes('audio') ? 'done' : 'partial');
    } catch (e) {
      setCreating(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row gap-4 md:items-end">
        <Field label={t('settingsAnki.url')} className="flex-1">
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={inputCls}
            placeholder="http://127.0.0.1:8765"
          />
        </Field>
        <Btn type="button" tone="accent" onClick={onConnect} disabled={status === 'loading'}>
          {status === 'loading' ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          {status === 'success' ? t('settingsAnki.reconnect') : t('settingsAnki.connect')}
        </Btn>
      </div>

      {status === 'error' && (
        <Card flat tone="shade" className="px-4 py-3 text-sm">
          {t('settingsAnki.connectFailed')}
          {error && <p className="mt-1 text-xs text-mute break-all">{error}</p>}
        </Card>
      )}
      {status === 'success' && (
        <Card flat tone="accent-soft" className="px-4 py-3 text-sm">{t('settingsAnki.connected')}</Card>
      )}

      {status === 'success' && (
        <div>
          <h3 className="text-lg font-semibold mb-4">{t('settingsAnki.card')}</h3>
          <Card flat tone="shade" className="px-4 py-3 mb-4 flex flex-col md:flex-row gap-3 md:items-center">
            <p className="flex-1 text-sm">{t('settingsAnki.createHint')}</p>
            <Btn type="button" tone="accent" onClick={create} disabled={creating === 'busy'}>
              {creating === 'busy' && <RefreshCw className="w-4 h-4 animate-spin" />}
              {t('settingsAnki.create')}
            </Btn>
          </Card>
          {creating === 'done' && <p className="text-sm mb-4">{t('settingsAnki.created')}</p>}
          {creating === 'partial' && <p className="text-sm mb-4">{t('settingsAnki.createdPartial')}</p>}
          {!['idle', 'busy', 'done', 'partial'].includes(creating) && (
            <p className="text-sm mb-4">{t('settingsAnki.createFailed')} <span className="text-xs text-mute break-all">{creating}</span></p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <Field label={t('settingsAnki.targetDeck')}>
              <select value={deckName} onChange={(e) => setDeckName(e.target.value)} className={inputCls}>
                <option value="">{t('settingsAnki.selectDeck')}</option>
                {decks.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
            <Field label={t('settingsAnki.noteType')}>
              <select value={modelName} onChange={(e) => setModelName(e.target.value)} className={inputCls}>
                <option value="">{t('settingsAnki.selectNoteType')}</option>
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </Field>
          </div>
          <LangDecks url={url} decks={decks} deckName={deckName} value={deckByLang} onChange={setDeckByLang} refreshDecks={refreshDecks} />
          {modelName && modelFields.length > 0 && (
            <FieldMap fields={modelFields} mapping={fieldMapping} onChange={updateMapping} />
          )}
        </div>
      )}
    </div>
  );
};

export default SettingsAnki;
