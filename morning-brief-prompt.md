Send Hayden his Startup Radar morning brief by email. This task is fully self-contained — do not assume any prior conversation.

STEP 1 — Fetch the brief.
Run this and read the JSON:

    curl -s -m 45 "https://startup-intel.haydenmterjeson.workers.dev/api/brief"

A plain-text rendering of the same brief is at:

    curl -s -m 45 "https://startup-intel.haydenmterjeson.workers.dev/api/brief.txt"

The brief is rebuilt every weekday at about 1:20am Pacific by a Cloudflare Worker ("startup-intel"). It contains only items that are NEW since the previous brief — the worker records everything it has shown and never shows it again. The JSON has: `headline`, `date`, `since`, `quiet` (true when nothing new), `counts`, and `sections[]`. Each section has `id`, `title`, `lead`, and `items[]` with `kind`, `label`, `detail`, `stat`, and usually `url`.

If the endpoint errors, returns 503, or the JSON has no `sections`, try once more after 30 seconds. If it still fails, email Hayden a short note saying the brief could not be generated and include the error — do not invent content.

If `generatedAt` is more than 30 hours old, say so in one line at the top of the email ("This brief is from {date} — the nightly build may have failed.") and still send it.

STEP 2 — Compose the email.
Write clean, readable HTML (inline styles only; many clients strip <style> blocks). Keep it skimmable on a phone.

- Lead with the `headline`, styled prominently.
- Render the sections in the order given. Each: its `title`, its `lead` line, then its items.
- Each item: the `label` as a link to `url` when present; `stat` as small monospace text beside it; `detail` underneath in a muted color.
- For the "New GTM roles" section, make items whose `kind` is "revops" visually stand out (bold or an accent color) — those are the RevOps/ops roles Hayden is targeting.
- If `quiet` is true, keep the email to the headline, the roles section's lead line, and the link to the site. Short is correct on a quiet day; do not pad.
- Every number and every company must come from the JSON. Do not add analysis, predictions, summaries, or companies that are not in the payload. The brief is deterministic by design; its value is that it cannot drift.
- End with a link to the full radar: https://haydenterjeson99.github.io/startup-radar/

Subject line: "Startup Radar — {Mon D}: {a short specific hook drawn from the headline}"
For example: "Startup Radar — Nov 5: Planet posted a RevOps Manager role in SF"
On a quiet day: "Startup Radar — {Mon D}: quiet day"

STEP 3 — Send it.
Use the Gmail connector to send to h.terjeson12@gmail.com. Hayden has already authorized this recurring send, so send it directly rather than creating a draft or asking for confirmation.

If the Gmail connector is unavailable or unauthorized, do not silently skip: report clearly that the brief was generated but could not be sent, and include the plain-text brief in your output so it isn't lost.
