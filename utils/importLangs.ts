// Languages a video can be transcribed in, for the add-video dialog and the YouTube
// window's pill (src-tauri/src/youtube_window.rs LANGS must list the same codes), and
// the one remembered choice both share: localStorage `import_lang` (no prefix).
export const IMPORT_LANGS = [
  { value: 'en', key: 'import.langEn' },
  { value: 'es', key: 'import.langEs' },
  { value: 'ja', key: 'import.langJa' },
  { value: 'zh', key: 'import.langZh' },
  { value: 'fr', key: 'import.langFr' },
  { value: 'de', key: 'import.langDe' },
  { value: 'ko', key: 'import.langKo' },
  { value: 'no', key: 'import.langNo' },
  { value: 'auto', key: 'import.langAuto' },
] as const;

const LANG_KEY = 'import_lang';

// Not a language the dropdown offers (an older or newer version wrote it): back to English.
export const loadImportLang = (): string => {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return IMPORT_LANGS.some(l => l.value === v) ? v! : 'en';
  } catch { return 'en'; }
};

export const saveImportLang = (v: string) => {
  if (!IMPORT_LANGS.some(l => l.value === v)) return;
  try { localStorage.setItem(LANG_KEY, v); } catch { /* localStorage unavailable */ }
};
