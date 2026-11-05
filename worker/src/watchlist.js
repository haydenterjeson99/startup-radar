/* ============================================================
   watchlist.js — the Bay Area companies the radar follows
   ------------------------------------------------------------
   SEED is the starting list. It is inserted into D1 once; after
   that the D1 table is the source of truth and Hayden edits it
   from the site (add, remove, star). Editing this file later
   does not overwrite his changes — only missing ids are added.

   ats/slug point at the company's public job board. Every one
   below was checked against the live API on 2026-11-04 and
   confirmed to be the right company. Companies whose boards run
   on Workday or a custom page have ats:null — news about them is
   still tracked, roles are a manual click.

   aliases: what to look for in headlines. Names that are also
   ordinary words (Planet, Felt, Kettle) use a longer alias or
   need a sector keyword in the same story (needsContext).
   ============================================================ */

const c = (id, name, sector, city, website, ats, slug, extra = {}) =>
  ({ id, name, sector, city, website, ats, slug, aliases: [name], needsContext: false, ...extra });

export const SEED = [
  // Earth observation & geospatial
  c('planet',          'Planet',            'geo', 'San Francisco', 'https://www.planet.com', 'greenhouse', 'planetlabs',
    { aliases: ['Planet Labs', 'Planet (PL)', "Planet's satellite"], note: 'Daily EO imagery constellation; public (NYSE: PL).' }),
  c('muon-space',      'Muon Space',        'geo', 'Mountain View', 'https://www.muonspace.com', 'greenhouse', 'muonspace',
    { note: 'EO satellites; builds the FireSat wildfire constellation.' }),
  c('niantic-spatial', 'Niantic Spatial',   'geo', 'San Francisco', 'https://www.nianticspatial.com', 'ashby', 'niantic-spatial',
    { note: 'Geospatial AI / large geospatial model spun out of Niantic.' }),
  c('mapbox',          'Mapbox',            'geo', 'San Francisco · DC', 'https://www.mapbox.com', 'ashby', 'mapbox',
    { note: 'Mapping platform and location data.' }),
  c('felt',            'Felt',              'geo', 'San Francisco', 'https://felt.com', null, null,
    { aliases: ['Felt maps', 'Felt.com', 'Felt'], needsContext: true, note: 'Collaborative web GIS.', careers: 'https://felt.com/careers' }),
  c('array-labs',      'Array Labs',        'geo', 'San Francisco', 'https://www.arraylabs.io', null, null,
    { note: 'Satellite swarms for 3D Earth models.' }),
  c('voltair',         'Voltair',           'geo', 'San Francisco', 'https://www.ycombinator.com/companies/voltair', null, null,
    { note: 'YC W26 — autonomous drone network for EO, utilities first.' }),
  c('wherobots',       'Wherobots',         'geo', 'San Francisco', 'https://wherobots.com', null, null,
    { note: 'Spatial data cloud from the Apache Sedona team.', careers: 'https://wherobots.com/careers' }),

  // Climate & risk sensing
  c('pano-ai',         'Pano AI',           'risk', 'San Francisco', 'https://www.pano.ai', 'ashby', 'pano-ai',
    { aliases: ['Pano AI', 'Pano'], needsContext: true, note: 'Camera + AI wildfire detection for utilities and agencies.' }),
  c('gridware',        'Gridware',          'risk', 'San Francisco', 'https://www.gridware.io', 'lever', 'gridware',
    { note: 'Pole-mounted sensors for grid and wildfire risk.' }),
  c('buzz-solutions',  'Buzz Solutions',    'risk', 'Palo Alto', 'https://buzzsolutions.co', 'greenhouse', 'buzzsolutions',
    { note: 'AI for utility asset inspection imagery.' }),
  c('aidash',          'AiDash',            'risk', 'San Jose', 'https://www.aidash.com', null, null,
    { note: 'Satellite-based vegetation management for utilities — closest analogue to NSL.', careers: 'https://www.aidash.com/careers' }),
  c('zesty-ai',        'ZestyAI',           'risk', 'San Francisco', 'https://zesty.ai', 'greenhouse', 'zestyai',
    { aliases: ['ZestyAI', 'Zesty.ai', 'Zesty AI'], note: 'Property-level climate risk models for insurers.' }),
  c('one-concern',     'One Concern',       'risk', 'Menlo Park', 'https://oneconcern.com', null, null,
    { needsContext: true, note: 'Climate and disaster resilience analytics.', careers: 'https://oneconcern.com/careers' }),
  c('jupiter',         'Jupiter Intelligence','risk','San Mateo', 'https://www.jupiterintel.com', 'lever', 'jupiterintel',
    { note: 'Physical climate risk analytics.' }),
  c('kettle',          'Kettle',            'risk', 'San Francisco', 'https://www.kettleinsurance.io', null, null,
    { aliases: ['Kettle Re', 'Kettle Insurance', 'Kettle'], needsContext: true, note: 'AI wildfire reinsurance.' }),
  c('overstory',       'Overstory',         'risk', 'Remote (US)', 'https://www.overstory.com', 'ashby', 'overstory',
    { note: 'Vegetation intelligence from satellite imagery; Amsterdam HQ, US-remote roles.' }),
  c('burnbot',         'BurnBot',           'risk', 'San Francisco', 'https://www.burnbot.com', null, null,
    { note: 'Robotic prescribed burns / fuel reduction.' }),
  c('firemaps',        'Firemaps',          'risk', 'San Francisco', 'https://www.firemaps.com', null, null,
    { note: 'Wildfire home hardening using aerial mapping.' }),

  // Drones, autonomy & defense
  c('skydio',          'Skydio',            'defense', 'San Mateo', 'https://www.skydio.com', 'ashby', 'skydio',
    { note: 'Autonomous drones; largest US drone maker.' }),
  c('zipline',         'Zipline',           'defense', 'South San Francisco', 'https://www.flyzipline.com', 'greenhouse', 'flyzipline',
    { needsContext: true, note: 'Autonomous delivery drones.' }),
  c('applied-intuition','Applied Intuition','defense', 'Sunnyvale', 'https://www.appliedintuition.com', 'ashby', 'applied',
    { note: 'Vehicle autonomy software; large defense business.' }),
  c('saildrone',       'Saildrone',         'defense', 'Alameda', 'https://www.saildrone.com', 'greenhouse', 'saildroneinc',
    { note: 'Uncrewed ocean vessels for maritime domain awareness.' }),
  c('reliable-robotics','Reliable Robotics','defense', 'Mountain View', 'https://reliable.co', 'ashby', 'reliable-robotics',
    { note: 'Autonomous flight for cargo and defense aircraft.' }),
  c('scout-ai',        'Scout AI',          'defense', 'Sunnyvale', 'https://www.scoutco.ai', 'ashby', 'scout-ai',
    { note: 'Foundation models for unmanned ground vehicles; $100M Series A (2026).' }),
  c('chariot-defense', 'Chariot Defense',   'defense', 'San Bruno', 'https://www.chariotdefense.com', 'greenhouse', 'chariotdefense',
    { note: 'Defense hardware startup.' }),
  c('rhombus-power',   'Rhombus Power',     'defense', 'Palo Alto', 'https://rhombuspower.com', 'greenhouse', 'rhombuspower',
    { note: 'AI for defense decision-making and situational awareness.' }),
  c('vannevar-labs',   'Vannevar Labs',     'defense', 'Remote (US)', 'https://www.vannevarlabs.com', 'greenhouse', 'vannevarlabs',
    { note: 'Defense intelligence software; mostly remote.' }),
  c('matternet',       'Matternet',         'defense', 'Mountain View', 'https://matternet.com', 'workable', 'matternet',
    { note: 'Drone delivery platform.' }),
  c('xwing',           'Xwing',             'defense', 'San Francisco', 'https://www.xwing.com', null, null,
    { note: 'Autonomous flight for regional aircraft.', careers: 'https://www.xwing.com/careers' }),
  c('wisk',            'Wisk',              'defense', 'Mountain View', 'https://wisk.aero', null, null,
    { aliases: ['Wisk Aero', 'Wisk'], needsContext: true, note: 'Autonomous eVTOL air taxi (Boeing).', careers: 'https://wisk.aero/careers' }),
];

/* ---------- job boards ---------- */

/** Read a careers URL and work out which public job board it is. */
export function detectAts(url) {
  if (!url) return null;
  const m = [
    [/(?:boards|job-boards)(?:-api)?\.greenhouse\.io\/(?:v1\/boards\/|embed\/job_board\?for=)?([A-Za-z0-9_-]+)/, 'greenhouse'],
    [/jobs\.lever\.co\/([A-Za-z0-9_-]+)/,           'lever'],
    [/jobs\.ashbyhq\.com\/([A-Za-z0-9_.%-]+)/,      'ashby'],
    [/apply\.workable\.com\/([A-Za-z0-9_-]+)/,      'workable'],
  ];
  for (const [re, ats] of m) {
    const hit = url.match(re);
    if (hit && hit[1] !== 'embed') return { ats, slug: decodeURIComponent(hit[1]) };
  }
  return null;
}

/** Fetch a careers page and sniff out the job board it embeds. */
export async function sniffAts(pageUrl) {
  const direct = detectAts(pageUrl);
  if (direct) return direct;
  try {
    const res = await fetch(pageUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/2.0)' }, redirect: 'follow' });
    if (!res.ok) return null;
    const html = await res.text();
    const links = html.match(/https?:\/\/(?:boards|job-boards|boards-api)\.greenhouse\.io\/[^"'\s<>]+|https?:\/\/jobs\.lever\.co\/[^"'\s<>]+|https?:\/\/jobs\.ashbyhq\.com\/[^"'\s<>]+|https?:\/\/apply\.workable\.com\/[^"'\s<>]+/g) || [];
    for (const l of links) { const d = detectAts(l); if (d) return d; }
  } catch { /* fall through */ }
  return null;
}

const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; startup-radar/2.0)' };

/** Normalised postings for one company: {id,title,location,dept,url,remote,postedAt}.
    With { details: true } (used only by the private job monitor) each
    posting also carries `text` (plain posting text) and, where the board
    gives structured pay, `comp` {min,max,basis} — at no extra requests. */
export async function fetchJobs(ats, slug, { details = false } = {}) {
  if (ats === 'greenhouse') {
    const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs${details ? '?content=true' : ''}`, { headers: UA });
    if (!r.ok) throw new Error(`greenhouse ${slug} ${r.status}`);
    const j = await r.json();
    return (j.jobs || []).map(p => ({
      id: `gh:${slug}:${p.id}`, title: p.title, location: p.location?.name || '',
      dept: '', url: p.absolute_url, remote: /remote/i.test(p.location?.name || ''),
      postedAt: Date.parse(p.first_published || p.updated_at) || 0,
      ...(details ? { postingId: String(p.id), text: htmlToText(p.content) } : {}),
    }));
  }
  if (ats === 'lever') {
    const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { headers: UA });
    if (!r.ok) throw new Error(`lever ${slug} ${r.status}`);
    const j = await r.json();
    return (Array.isArray(j) ? j : []).map(p => ({
      id: `lv:${slug}:${p.id}`, title: p.text,
      location: [p.categories?.location, ...(p.categories?.allLocations || [])].filter(Boolean).join('; '),
      dept: p.categories?.team || p.categories?.department || '', url: p.hostedUrl,
      remote: p.workplaceType === 'remote', postedAt: p.createdAt || 0,
      ...(details ? { text: [p.descriptionPlain, ...(p.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`), p.additionalPlain].filter(Boolean).join('\n\n'),
        comp: annual(p.salaryRange?.min, p.salaryRange?.max, p.salaryRange?.currency, /year|annual/i.test(p.salaryRange?.interval || '') ? 'Base' : null) } : {}),
    }));
  }
  if (ats === 'ashby') {
    const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}${details ? '?includeCompensation=true' : ''}`, { headers: UA });
    if (!r.ok) throw new Error(`ashby ${slug} ${r.status}`);
    const j = await r.json();
    return (j.jobs || []).filter(p => p.isListed !== false).map(p => ({
      id: `ab:${slug}:${p.id}`, title: p.title,
      location: [p.location, ...(p.secondaryLocations || []).map(s => s.location)].filter(Boolean).join('; '),
      dept: p.department || p.team || '', url: p.jobUrl,
      remote: !!p.isRemote || p.workplaceType === 'Remote', postedAt: Date.parse(p.publishedAt) || 0,
      ...(details ? { text: p.descriptionPlain || htmlToText(p.descriptionHtml), comp: ashbyComp(p.compensation) } : {}),
    }));
  }
  if (ats === 'workable') {
    const r = await fetch(`https://apply.workable.com/api/v1/widget/accounts/${slug}`, { headers: UA });
    if (!r.ok) throw new Error(`workable ${slug} ${r.status}`);
    const j = await r.json();
    return (j.jobs || []).map(p => ({
      id: `wk:${slug}:${p.shortcode}`, title: p.title,
      location: [p.city, p.state, p.country].filter(Boolean).join(', '),
      dept: p.department || '', url: p.url || p.shortlink || `https://apply.workable.com/${slug}/j/${p.shortcode}/`,
      remote: !!p.telecommuting, postedAt: Date.parse(p.published_on || p.created_at) || 0,
    }));
  }
  return [];
}

/* ---------- posting details (job monitor only) ---------- */

export function htmlToText(html) {
  return (html || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/ul|\/ol)[^>]*>/gi, '\n').replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Annual USD range, or null. Basis is 'Base' or 'OTE'. */
export function annual(min, max, currency, basis) {
  if (!basis || (currency && currency !== 'USD')) return null;
  const lo = Math.round(+min || 0), hi = Math.round(+max || +min || 0);
  if (lo < 20000 || hi < lo || hi > 5e6) return null;   // hourly or junk
  return { min: lo, max: hi, basis };
}

function ashbyComp(c) {
  const comps = c?.summaryComponents || [];
  const sal = comps.find(x => x.compensationType === 'Salary' && /YEAR/i.test(x.interval || ''));
  const ote = /\bOTE\b|on[- ]target/i.test(c?.compensationTierSummary || '');
  return sal ? annual(sal.minValue, sal.maxValue, sal.currencyCode, ote ? 'OTE' : 'Base') : null;
}

/* ---------- mention matching ---------- */

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build one matcher per company. Case-sensitive on purpose:
    "Planet Labs" is a company, "planet" is not. */
export function mentionMatchers(list) {
  return list.map(w => {
    const aliases = (w.aliases && w.aliases.length ? w.aliases : [w.name]).filter(a => a && a.length >= 3);
    return { id: w.id, needsContext: !!w.needsContext,
      re: new RegExp(`(^|[^A-Za-z0-9])(${aliases.map(esc).join('|')})(?![A-Za-z0-9])`) };
  });
}
