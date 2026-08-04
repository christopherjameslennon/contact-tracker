/**
 * sync-script.mjs
 * Run by GitHub Actions daily.
 * 1. Loads contacts.json from the private data repo
 * 2. Gets a fresh Google access token via the refresh token
 * 3. For each contact: creates, updates, or deletes the Calendar event
 * 4. Writes updated contacts.json back (stores event IDs)
 */

import fetch from 'node-fetch';

const {
  GH_DATA_TOKEN,
  GH_DATA_REPO,
  GCAL_CLIENT_ID,
  GCAL_CLIENT_SECRET,
  GCAL_REFRESH_TOKEN,
  GCAL_CALENDAR_ID,
} = process.env;

const GH_API   = 'https://api.github.com';
const GCAL_API = 'https://www.googleapis.com/calendar/v3';
const FILE     = 'contacts.json';

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function ghGet(path) {
  const res = await fetch(`${GH_API}${path}`, {
    headers: {
      Authorization: `token ${GH_DATA_TOKEN}`,
      Accept:        'application/vnd.github.v3+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub GET ${path} → ${res.status}`);
  return res.json();
}

async function ghPut(path, body) {
  const res = await fetch(`${GH_API}${path}`, {
    method:  'PUT',
    headers: {
      Authorization: `token ${GH_DATA_TOKEN}`,
      Accept:        'application/vnd.github.v3+json',
      'Content-Type':'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`GitHub PUT ${path} → ${res.status}: ${err.message}`);
  }
  return res.json();
}

async function loadContacts() {
  const file    = await ghGet(`/repos/${GH_DATA_REPO}/contents/${FILE}`);
  const raw     = Buffer.from(file.content, 'base64').toString('utf8');
  const data    = JSON.parse(raw);
  data._sha     = file.sha;
  return data;
}

async function saveContacts(data) {
  const sha     = data._sha;
  delete data._sha;
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await ghPut(`/repos/${GH_DATA_REPO}/contents/${FILE}`, {
    message: `Sync contacts ${new Date().toISOString()}`,
    content,
    sha,
  });
}

// ── Google helpers ────────────────────────────────────────────────────────────

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     GCAL_CLIENT_ID,
      client_secret: GCAL_CLIENT_SECRET,
      refresh_token: GCAL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
  const json = await res.json();
  return json.access_token;
}

async function gcalRequest(method, path, token, body) {
  const res = await fetch(`${GCAL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type':'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Calendar ${method} ${path} → ${res.status}: ${(err.error || {}).message}`);
  }
  return res.json();
}

// ── Domain logic ──────────────────────────────────────────────────────────────

function frequencyToDays(freq, customDays) {
  const map = { weekly: 7, fortnightly: 14, monthly: 30, quarterly: 91, annually: 365 };
  if (freq === 'custom') return parseInt(customDays, 10) || 30;
  return map[freq] || 30;
}

function getNextDueDate(contact) {
  const base = contact.lastContacted ? new Date(contact.lastContacted) : new Date();
  const days = frequencyToDays(contact.frequency, contact.customDays);
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateString(date) {
  return date.toISOString().split('T')[0];
}

function formatDate(str) {
  if (!str) return '';
  return new Date(str + 'T00:00:00').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

function buildEventBody(contact) {
  const next = getNextDueDate(contact);

  const interactions = [...(contact.interactions || [])].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  let description = '';

  if (interactions.length > 0) {
    const latest = interactions[0];
    description += `Last interaction (${formatDate(latest.date)} — ${latest.medium})\n`;
    description += (latest.summary || '(no notes)') + '\n\n';
  }

  if (contact.notes) {
    description += `Profile notes\n${contact.notes}\n\n`;
  }

  if (interactions.length > 1) {
    description += 'Earlier interactions\n';
    interactions.slice(1).forEach(i => {
      description += `${formatDate(i.date)} (${i.medium}): ${i.summary || '(no notes)'}\n`;
    });
  }

  if (contact.company)  description += `\nCompany: ${contact.company}`;
  if (contact.howMet)   description += `\nHow we met: ${contact.howMet}`;
  if (contact.category) description += `\nCategory: ${contact.category}`;

  return {
    summary:     `Reach out to ${contact.name}`,
    description: description.trim(),
    start:       { date: toDateString(next) },
    end:         { date: toDateString(next) },
    reminders: {
      useDefault: false,
      overrides:  [
        { method: 'popup', minutes: 24 * 60 },
        { method: 'email', minutes: 24 * 60 },
      ],
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading contacts from GitHub…');
  const data = await loadContacts();

  console.log(`Found ${data.contacts.length} contacts. Getting Google access token…`);
  const token = await getAccessToken();

  const calId = encodeURIComponent(GCAL_CALENDAR_ID);
  let changed = false;

  for (const contact of data.contacts) {
    const eventBody = buildEventBody(contact);

    try {
      if (contact.calendarEventId) {
        // Check the event still exists
        const existing = await gcalRequest(
          'GET',
          `/calendars/${calId}/events/${contact.calendarEventId}`,
          token
        );

        if (!existing) {
          // Event was deleted from Google Calendar — recreate
          console.log(`  ${contact.name}: event missing, recreating`);
          const res = await gcalRequest('POST', `/calendars/${calId}/events`, token, eventBody);
          contact.calendarEventId = res.id;
          changed = true;
        } else {
          // Update existing
          console.log(`  ${contact.name}: updating event`);
          await gcalRequest(
            'PUT',
            `/calendars/${calId}/events/${contact.calendarEventId}`,
            token,
            eventBody
          );
        }
      } else {
        // No event yet — create one
        console.log(`  ${contact.name}: creating event`);
        const res = await gcalRequest('POST', `/calendars/${calId}/events`, token, eventBody);
        contact.calendarEventId = res.id;
        changed = true;
      }
    } catch (err) {
      console.warn(`  ${contact.name}: calendar error — ${err.message}`);
    }
  }

  if (changed) {
    console.log('Writing updated contacts back to GitHub…');
    await saveContacts(data);
    console.log('Done.');
  } else {
    console.log('No event IDs changed — skipping write.');
    // Still write to update timestamps etc. if needed
    await saveContacts({ ...data, _sha: data._sha });
    // Restore sha for saveContacts (it deletes _sha)
  }

  console.log('Sync complete.');
}

main().catch(err => {
  console.error('Sync failed:', err);
  process.exit(1);
});
