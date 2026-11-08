/* ============================================================
   sources.js — what the radar reads, and the vocabulary it
   uses to decide what a story is about.
   ------------------------------------------------------------
   Tier 1 = a named publisher's own RSS feed. These are the
   backbone and are verified to return items.
   Tier 2 = a keyword search on Bing/Google News. Kept as a
   safety net for stories the publishers miss; the site labels
   them "via search" and the brief ranks them below tier 1.

   Every feed URL here was checked by hand on 2026-11-04. If one
   starts returning nothing, /api/sources reports it.
   ============================================================ */

export const FEED_TABS = [
  { id: 'formation', label: 'Company Formation' },
  { id: 'geo',       label: 'Geospatial & EO' },
  { id: 'defense',   label: 'Drones, Autonomy & Defense' },
  { id: 'risk',      label: 'Climate Risk & Insurance' },
  { id: 'cleantech', label: 'Clean Tech' },
  { id: 'legacy',    label: 'Legacy B2B' },
];

const d = (tab, url, source) => ({ tab, tier: 1, kind: 'rss', url, source });
const g = (tab, query) => ({ tab, tier: 2, kind: 'google', query });
const b = (tab, query) => ({ tab, tier: 2, kind: 'bing', query });

/* Split in two so neither cron stage exceeds the Workers
   free-plan budget of 50 outbound requests per invocation. */
export const SOURCES_A = [
  // Company formation
  d('formation', 'https://techcrunch.com/category/startups/feed/', 'TechCrunch'),
  d('formation', 'https://techcrunch.com/category/venture/feed/',  'TechCrunch'),
  d('formation', 'https://news.crunchbase.com/feed/',              'Crunchbase News'),
  d('formation', 'https://sfstandard.com/feed/',                   'The San Francisco Standard'),

  // Geospatial & earth observation
  d('geo', 'https://www.geoconnexion.com/news/feed.rss', 'GeoConnexion'),
  d('geo', 'https://www.gim-international.com/rss',      'GIM International'),
  d('geo', 'https://spatialsource.com.au/feed/',         'Spatial Source'),
  d('geo', 'https://www.satellitetoday.com/feed/',       'Via Satellite'),
  d('geo', 'https://payloadspace.com/feed/',             'Payload'),
  d('geo', 'https://spacenews.com/feed/',                'SpaceNews'),
  d('geo', 'https://techcrunch.com/category/space/feed/','TechCrunch'),

  // Clean tech
  d('cleantech', 'https://www.canarymedia.com/rss.rss',            'Canary Media'),
  d('cleantech', 'https://www.latitudemedia.com/feed',             'Latitude Media'),
  d('cleantech', 'https://www.ctvc.co/rss/',                       'CTVC'),
  d('cleantech', 'https://www.trellis.net/feed',                   'Trellis'),
  d('cleantech', 'https://techcrunch.com/category/climate/feed/',  'TechCrunch'),

  // Legacy B2B
  d('legacy', 'https://www.constructiondive.com/feeds/news/', 'Construction Dive'),
  d('legacy', 'https://www.utilitydive.com/feeds/news/',      'Utility Dive'),

  // Search safety net
  g('formation', '("emerges from stealth" OR "out of stealth") startup'),
  g('formation', '"seed round" OR "series a" startup "San Francisco"'),
  g('geo',       '("geospatial" OR "earth observation" OR "remote sensing") startup (raises OR funding)'),
  b('geo',       '"geospatial" startup funding'),
  g('cleantech', '("climate tech" OR "clean tech") startup (raises OR seed OR "series a")'),
  g('legacy',    '("vertical saas" OR "construction tech" OR "proptech") startup raises'),
];

export const SOURCES_B = [
  // Drones, autonomy & defense
  d('defense', 'https://dronelife.com/feed/',          'DroneLife'),
  d('defense', 'https://www.suasnews.com/feed/',       'sUAS News'),
  d('defense', 'https://dronexl.co/feed/',             'DroneXL'),
  d('defense', 'https://www.therobotreport.com/feed/', 'The Robot Report'),
  d('defense', 'https://techcrunch.com/category/robotics/feed/', 'TechCrunch'),
  d('defense', 'https://breakingdefense.com/feed/',    'Breaking Defense'),
  d('defense', 'https://www.defenseone.com/rss/all/',  'Defense One'),
  d('defense', 'https://defensescoop.com/feed/',       'DefenseScoop'),
  d('defense', 'https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml', 'Defense News'),

  // Climate risk & insurance
  d('risk', 'https://www.insurancejournal.com/rss/news/', 'Insurance Journal'),
  d('risk', 'https://www.artemis.bm/feed/',               'Artemis'),

  // Search safety net
  g('defense', '("defense tech" OR "dual-use") startup (raises OR funding)'),
  g('defense', '(drone OR UAV OR autonomy) startup raises "Bay Area" OR "San Francisco" OR "Silicon Valley"'),
  b('defense', '"defense tech" startup funding'),
  g('risk',    '(wildfire OR "climate risk" OR "catastrophe model") startup (raises OR funding OR launches)'),
  g('risk',    '("vegetation management" OR "grid inspection" OR "wildfire detection") startup'),
];

/* ---------- vocabulary ---------- */

/* What counts as each of Hayden's three sectors. A story is "in
   sector" when its title or excerpt matches one of these. */
export const SECTORS = {
  geo: {
    label: 'EO & geospatial',
    re: /\b(geospatial|earth[- ]observation|remote[- ]sensing|satellite (imag|data|constellation)|aerial imag|hyperspectral|synthetic[- ]aperture|SAR satellite|lidar|GIS\b|mapping (platform|data|startup|company)|digital twin of|3D map|stratospheric|high[- ]altitude (balloon|platform|pseudo)|HAPS?\b|imagery)/i,
  },
  defense: {
    label: 'Drones, autonomy & defense',
    re: /\b(drones?|UAVs?|UAS\b|unmanned|counter[- ]drone|eVTOL|autonomous (aircraft|flight|vehicle|vessel|boat|system)|autonomy|defen[cs]e tech|dual[- ]use|national security|Pentagon|Department of (Defense|War)|DoD\b|DIU\b|Air Force|Army|Navy|Space Force|military|missile|munitions?)/i,
  },
  risk: {
    label: 'Climate & risk sensing',
    re: /\b(wildfires?|catastrophe (model|risk|bond)|cat bonds?|climate risk|climate resilience|flood (risk|model)|hail|insurtech|reinsur|parametric|property risk|vegetation management|grid (inspection|monitoring|resilience)|utility (wildfire|inspection)|forest(ry)?|carbon (credit|removal) .*satellite|infrastructure (monitoring|inspection)|disaster)/i,
  },
};

/* Money has to actually move: a raise needs an amount, an
   acquisition needs a buyer verb. "Communities raise concerns"
   is not a funding story. */
export const FUNDING = /\b(lands?|nabs?|bags?|gets) \$\s?\d|\b(raise[sd]?|raising|secures?|secured|closes?|closed)\b[^.]{0,50}?(\$\s?\d|€\s?\d|£\s?\d|\d+(\.\d+)?\s?(million|billion|mn|bn|M\b|B\b))|\b(seed round|pre-seed|series [a-e]\b|funding round|emerges? from stealth|out of stealth|acquires|acquired by|to acquire|acquisition of|agrees? to buy|go(es|ing)? public|business combination|IPO\b)/i;

export const BAY_AREA = /\b(San Francisco|SF-based|Bay Area|Silicon Valley|Oakland|Berkeley|Emeryville|Alameda|Palo Alto|Mountain View|Sunnyvale|San Jose|Santa Clara|Menlo Park|Redwood City|San Mateo|South San Francisco|Burlingame|San Bruno|Foster City|San Carlos|Cupertino|Los Altos|Milpitas|Fremont|Hayward|Livermore|Pleasanton|Walnut Creek|Richmond, CA|Stanford)\b/i;

/* Noise that slips into search results: stock-picking sites and
   analyst notes. Carried over from the original front end. */
const NOISE_TERMS   = ['nasdaq','nyse','price target','buy rating','sell rating','analyst','market cap','p/e ratio','wall street','zacks rank','dow jones','shares of'];
const NOISE_STRONG  = /\b(stock price|stock quote|quote (&|and) history|shares (surge|jump|fall|drop|slide|rise|soar|tumble)|gf score|short interest|options activity|price target|earnings call transcript|\(NYSE:|\(NASDAQ:)/i;
const NOISE_SOURCES = ['fool.com','motley fool','zacks','marketbeat','benzinga','tipranks','seeking alpha','seekingalpha','investorplace','nasdaq.com','yahoo finance','simply wall','investing.com','gurufocus','stocktitan','marketscreener','globe and mail'];
export function isNoise(a) {
  const blob = `${a.title} ${a.excerpt}`.toLowerCase();
  const src  = (a.source || '').toLowerCase();
  if (NOISE_SOURCES.some(s => src.includes(s) || a.title.toLowerCase().includes(' by ' + s))) return true;
  if (NOISE_STRONG.test(a.title)) return true;
  return NOISE_TERMS.filter(t => blob.includes(t)).length >= 2;
}

/* ---------- jobs ---------- */

/* GTM roles, with RevOps called out as the core target. */
export const ROLE_CORE = /\b(rev(enue)?[ -]?ops|revenue operations|sales operations|sales ops|gtm operations|go[- ]to[- ]market operations|business operations|bizops|deal desk|sales strategy|salesforce (admin|administrator|architect|developer)|crm (manager|admin|administrator|lead|analyst)|commercial operations|sales enablement|gtm (systems|analyst|strategy))\b/i;
export const ROLE_GTM  = /\b(sales|account executive|account manager|account director|business development|bdr|sdr|partnerships?|partner manager|channel|customer success|customer experience|go[- ]to[- ]market|gtm|revenue|commercial|solutions (engineer|consultant|architect)|sales engineer|marketing operations|growth (lead|manager)|key account|enterprise account|capture manager|government relations)\b/i;

/* Titles that match the GTM words but aren't GTM jobs, plus
   internships (not useful for a lateral move). */
export const ROLE_EXCLUDE = /\b(intern|internship|co-?op|accounting|accountant|fp&a|counsel|legal|paralegal|tax|payroll|recruit(er|ing)|talent|people partner|hr\b)\b/i;

const US_STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming|district of columbia)\b/i;
const US_STATE_CODES = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

/* Locations we keep: anywhere in the Bay Area, or remote in the US.
   "Remote" alone counts as US (these are US companies); remote
   with only a foreign country named does not. */
export function classifyLocation(loc, isRemote) {
  const s = loc || '';
  const bay = BAY_AREA.test(s) || /\b(SF|SFO)\b/.test(s);
  const parts = s.split(/;|\|/).map(p => p.trim()).filter(Boolean);
  const usPart = p => /\b(united states|usa|u\.s\.|us|nationwide|north america|americas)\b/i.test(p) || US_STATE_NAMES.test(p) || US_STATE_CODES.test(p);
  const bare = p => !p.replace(/remote|anywhere|hybrid|[\s(),\-–:]/gi, '');
  const remotey = isRemote || /remote|anywhere/i.test(s);
  const remote = remotey && (parts.length === 0 || parts.some(p => /remote|anywhere/i.test(p) && (usPart(p) || bare(p))) || (parts.some(usPart) && !parts.some(p => !usPart(p) && !bare(p))));
  return { bay, remote };
}
