/* ============================================================
   brief.js — the morning briefing
   ------------------------------------------------------------
   Deterministic, not model-generated. Every sentence traces to a
   number in the snapshot, so the brief cannot drift or invent.
   Priorities, per the brief's owner: gaps & whitespace, industry
   movement, tooling. Funding news rides along as context.
   ============================================================ */

const pp = n => `${n > 0 ? '+' : ''}${n}pp`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

/**
 * @param cur    landscape snapshot built today
 * @param prev   the previous stored snapshot (may be null on first run)
 * @param news   recent funding/launch stories
 * @param fresh  companies first seen since the last run
 */
export function buildBrief(cur, prev, news, fresh) {
  const sections = [];

  /* ---- 1. Gaps & whitespace ---- */
  const crowding = [...cur.gaps].sort((a, b) => b.deltaPP - a.deltaPP);
  const closing  = crowding.filter(g => g.deltaPP >= 3).slice(0, 3);
  const opening  = crowding.filter(g => g.heat === 'open' || g.deltaPP <= -2).slice(0, 3);

  sections.push({
    id: 'gaps',
    title: 'Gaps & whitespace',
    lead: closing.length
      ? `${closing[0].problem} is the fastest-crowding gap — ${plural(closing[0].count, 'company', 'companies')} now name it, ${pp(closing[0].deltaPP)} on a year ago.`
      : 'No gap moved sharply this cycle.',
    items: [
      ...closing.map(g => ({
        kind: 'closing', label: g.problem, detail: g.response,
        stat: `${g.count} cos · ${g.share}% · ${pp(g.deltaPP)}`, heat: g.heat,
      })),
      ...opening.map(g => ({
        kind: 'open', label: g.problem, detail: g.response,
        stat: `${g.count} cos · ${g.share}% · ${pp(g.deltaPP)}`, heat: g.heat,
      })),
    ],
  });

  /* ---- 2. Industry movement ---- */
  const movers = [...cur.industries].sort((a, b) => Math.abs(b.deltaPP) - Math.abs(a.deltaPP)).slice(0, 5);
  sections.push({
    id: 'movement',
    title: 'Industry movement',
    lead: movers.length
      ? `${movers[0].label} moved most: ${movers[0].now}% of ${cur.current}, against ${movers[0].then}% a year ago (${pp(movers[0].deltaPP)}).`
      : '',
    items: movers.map(i => ({
      kind: i.deltaPP >= 0 ? 'up' : 'down', label: i.label,
      detail: `${i.nowN} of ${cur.batchSizes[cur.current]} companies in ${cur.current}, versus ${i.thenN} in ${cur.yearAgo}.`,
      stat: `${i.now}% · ${pp(i.deltaPP)}`,
    })),
  });

  /* ---- 3. Tooling & stack ---- */
  const toolMovers = [...cur.tools].sort((a, b) => b.deltaPP - a.deltaPP);
  sections.push({
    id: 'tooling',
    title: 'Tooling & stack',
    lead: `${toolMovers[0].label} is the fastest-growing building block (${pp(toolMovers[0].deltaPP)}); ${toolMovers[toolMovers.length - 1].label} is fading (${pp(toolMovers[toolMovers.length - 1].deltaPP)}).`,
    items: toolMovers.slice(0, 4).concat(toolMovers.slice(-1)).map(t => ({
      kind: t.deltaPP >= 0 ? 'up' : 'down', label: t.label, detail: t.note,
      stat: `${t.count} cos · ${pp(t.deltaPP)}`,
    })),
  });

  /* ---- 4. New to the directory ---- */
  if (fresh?.length) {
    sections.push({
      id: 'new',
      title: 'New to the directory',
      lead: `${plural(fresh.length, 'company', 'companies')} appeared since the last read.`,
      items: fresh.slice(0, 12).map(c => ({
        kind: 'new', label: c.name, detail: c.oneLiner, stat: c.batch, url: c.url,
      })),
    });
  }

  /* ---- 5. Funding news ---- */
  const funding = news.filter(n => n.funding).slice(0, 8);
  if (funding.length) {
    sections.push({
      id: 'funding',
      title: 'Money moving',
      lead: `${plural(funding.length, 'story', 'stories')} in the last week.`,
      items: funding.map(n => ({
        kind: 'news', label: n.title, detail: n.source, url: n.link, stat: '',
      })),
    });
  }

  /* ---- Headline: the single most notable structural fact ---- */
  const topTheme = cur.themes[0];
  const topVocab = [...cur.vocabulary].sort((a, b) => b.deltaPP - a.deltaPP)[0];
  const headline = `${topTheme.label} leads ${cur.current} at ${topTheme.share}% of the batch; "${topVocab.term}" is the fastest-rising vocabulary (${pp(topVocab.deltaPP)}).`;

  return {
    generatedAt: Date.now(),
    date: new Date().toISOString().slice(0, 10),
    batch: cur.current,
    batchSize: cur.batchSizes[cur.current],
    headline,
    sections,
    freshCount: fresh?.length || 0,
  };
}

/** Plain-text rendering, for email. */
export function briefToText(b) {
  const L = [`STARTUP RADAR — ${b.date}`, '', b.headline, ''];
  for (const s of b.sections) {
    L.push(`── ${s.title.toUpperCase()} ──`);
    if (s.lead) L.push(s.lead, '');
    for (const it of s.items) {
      L.push(`  • ${it.label}${it.stat ? `  [${it.stat}]` : ''}`);
      if (it.detail) L.push(`    ${it.detail}`);
      if (it.url)    L.push(`    ${it.url}`);
    }
    L.push('');
  }
  L.push(`Full radar: https://haydenterjeson99.github.io/startup-radar/`);
  return L.join('\n');
}
