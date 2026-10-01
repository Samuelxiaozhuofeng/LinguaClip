// The recommended shows on the podcast page, every feed
// checked by hand on 2026-09-30; every language has all three levels (the easier / harder hint needs them). A show's language is written here, not read from the
// feed: feeds get it wrong (Coffee Break Spanish and Talk To Me In Korean say "en").
// `asr` = what the transcription is told: 'auto' for shows taught in English.

export type ShowLang = 'en' | 'ja' | 'es' | 'fr' | 'de' | 'ko';
export type Level = 'beginner' | 'intermediate' | 'advanced';
export type Style = 'dialog' | 'solo' | 'news' | 'story';
export type Pick = {
  id: string;
  lang: ShowLang;
  name: string;
  feed: string;
  level: Level;
  slow: boolean;
  style: Style;
  english?: boolean; // explained in English: the transcript mixes two languages
};

export const SHOW_LANGS: ShowLang[] = ['en', 'ja', 'es', 'fr', 'de', 'ko'];

export const SHOWS: Pick[] = [
  { id: 'bbc6', lang: 'en', name: '6 Minute English', feed: 'https://podcasts.files.bbci.co.uk/p02pc9tn.rss', level: 'beginner', slow: true, style: 'dialog' },
  { id: 'aee', lang: 'en', name: 'All Ears English', feed: 'https://feeds.megaphone.fm/allearsenglish', level: 'intermediate', slow: false, style: 'dialog' },
  { id: 'lep', lang: 'en', name: "Luke's English Podcast", feed: 'https://feeds.acast.com/public/shows/62b0ada25c7ea10012f541cb', level: 'advanced', slow: false, style: 'solo' },
  { id: 'shun', lang: 'ja', name: 'Japanese with Shun', feed: 'https://feeds.redcircle.com/e8ab057c-683d-4375-a197-2dcc42d4f851', level: 'intermediate', slow: true, style: 'solo' },
  { id: 'nhk', lang: 'ja', name: 'NHK Easy Japanese', feed: 'https://www3.nhk.or.jp/nhkworld/lesson/en/rss/podcast.xml', level: 'beginner', slow: true, style: 'dialog', english: true },
  { id: 'teppei', lang: 'ja', name: 'Nihongo con Teppei for Beginners', feed: 'https://nihongoconteppei.com/feed/podcast', level: 'beginner', slow: true, style: 'solo' },
  { id: 'haru', lang: 'ja', name: 'N2~N1日本語！Haru no Nihongo', feed: 'https://anchor.fm/s/26aec4fc/podcast/rss', level: 'advanced', slow: false, style: 'solo' },
  { id: 'nami', lang: 'ja', name: 'なみとパッツーの日本語ラジオ', feed: 'https://anchor.fm/s/1fbc1f00/podcast/rss', level: 'intermediate', slow: false, style: 'dialog' },
  { id: 'ambulante', lang: 'es', name: 'Radio Ambulante', feed: 'https://www.omnycontent.com/d/playlist/e73c998e-6e60-432f-8610-ae210140c5b1/b3c9b6e7-72ba-45c4-aff9-b1e7012d213b/092b66a8-4329-4183-bb12-b1e7012d216f/podcast.rss', level: 'advanced', slow: false, style: 'story' },
  { id: 'easyes', lang: 'es', name: 'Easy Spanish', feed: 'https://feeds.fireside.fm/easyspanish/rss', level: 'intermediate', slow: false, style: 'dialog' },
  { id: 'cbs', lang: 'es', name: 'Coffee Break Spanish', feed: 'https://feeds.acast.com/public/shows/985e7c00-8945-4e0d-a4da-b93049180ce1', level: 'beginner', slow: true, style: 'dialog', english: true },
  { id: 'cbf', lang: 'fr', name: 'Coffee Break French', feed: 'https://feeds.acast.com/public/shows/47990e88-454b-4e3b-bf78-75a172c33184', level: 'beginner', slow: true, style: 'dialog', english: true },
  { id: 'choses', lang: 'fr', name: 'Choses à Savoir', feed: 'https://feeds.acast.com/public/shows/66057de88268a800162cadf2', level: 'advanced', slow: false, style: 'solo' },
  { id: 'inner', lang: 'fr', name: 'InnerFrench', feed: 'https://podcast.innerfrench.com/feed.xml', level: 'intermediate', slow: true, style: 'solo' },
  { id: 'easyfr', lang: 'fr', name: 'Easy French', feed: 'https://feeds.fireside.fm/easyfrench/rss', level: 'intermediate', slow: false, style: 'dialog' },
  { id: 'rfi', lang: 'fr', name: 'Journal en français facile', feed: 'https://apis.fle.rfi.fr/products/get_product/fle_getpodcast_by_nid_author_rfi?token_application=applepodcast_fle&program.entrepriseId=WBMZ39-FLE-FR-20220627', level: 'intermediate', slow: true, style: 'news' },
  { id: 'slowde', lang: 'de', name: 'Slow German', feed: 'https://slowgerman.com/feed/podcast/?redirect=no', level: 'beginner', slow: true, style: 'solo' },
  { id: 'nleicht', lang: 'de', name: 'Nachrichtenleicht', feed: 'https://www.deutschlandfunk.de/podcast-nachrichtenleicht-der-wochenrueckblick-in-einfacher-sprache-100.xml', level: 'beginner', slow: true, style: 'news' },
  { id: 'sozusagen', lang: 'de', name: 'Sozusagen!', feed: 'https://feeds.br.de/sozusagen/feed.xml', level: 'advanced', slow: false, style: 'dialog' },
  { id: 'easyde', lang: 'de', name: 'Easy German', feed: 'https://proxyfeed.svmaudio.com/feeds/easygerman/feed.xml', level: 'intermediate', slow: false, style: 'dialog' },
  { id: 'ttmik', lang: 'ko', name: 'Talk To Me In Korean', feed: 'https://rss.libsyn.com/shows/18454/destinations/12619.xml', level: 'beginner', slow: true, style: 'dialog', english: true },
  { id: 'heeya', lang: 'ko', name: 'Heeya Korean 희야한국어', feed: 'https://anchor.fm/s/7d8cc06c/podcast/rss', level: 'intermediate', slow: true, style: 'solo' },
  { id: 'didi', lang: 'ko', name: 'Didi의 한국문화 Podcast', feed: 'https://anchor.fm/s/e3a4142c/podcast/rss', level: 'advanced', slow: false, style: 'solo' },
];

// What the transcription is told for a recommended show.
export const asrOf = (p: Pick) => (p.english ? 'auto' : p.lang);
