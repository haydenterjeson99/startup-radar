/* ---------- "Prepare to Apply" relay ----------
   The Notion button sets a job row's Resume Status to Queued (Notion's
   webhook action needs a paid plan); setting My Status to Preparing does
   the same for a row with no Resume Status. Every two minutes this checks
   the Job Database for such rows, fires the Claude Code routine for each
   one, and marks Resume Status Preparing so it is not fired twice.

   Secrets (wrangler secret put …): ROUTINE_ID, ROUTINE_TOKEN.
   Uses the existing NOTION_TOKEN and JOB_DS_ID. */

import { notion, queryAll, put } from './notion.js';

export const PREP_CRON = '*/2 * * * *';
const FIRE_URL = id => `https://api.anthropic.com/v1/claude_code/routines/${id}/fire`;

async function fireRoutine(env, pageId) {
  const res = await fetch(FIRE_URL(env.ROUTINE_ID), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ROUTINE_TOKEN}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ text: `Prepare to Apply was pressed. Process only Notion job page ${pageId}.` }),
  });
  if (!res.ok) throw new Error(`routine fire ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export async function runPrepareQueue(env) {
  if (!env.ROUTINE_ID || !env.ROUTINE_TOKEN || !env.NOTION_TOKEN || !env.JOB_DS_ID) return { skipped: 'secrets not set' };
  const budget = { left: 30 };
  // Fire on: Resume Status = Queued (button), or My Status = Preparing with no
  // resume yet. Resume Status blocks re-firing; clear it to redo a resume.
  const filter = { or: [
    { property: 'Resume Status', select: { equals: 'Queued' } },
    { and: [
      { property: 'My Status', select: { equals: 'Preparing' } },
      { property: 'Resume Status', select: { is_empty: true } },
    ] },
  ] };
  const rows = await queryAll(env, env.JOB_DS_ID, filter, budget);
  const fired = [];
  for (const row of rows.slice(0, 5)) {
    try {
      await fireRoutine(env, row.id);
      await notion(env, 'PATCH', `/pages/${row.id}`, { properties: { 'Resume Status': put.select('Preparing') } }, budget);
      fired.push(row.id);
    } catch (e) {
      console.error('prepare-to-apply failed for', row.id, e.message);
    }
  }
  return { queued: rows.length, fired };
}
