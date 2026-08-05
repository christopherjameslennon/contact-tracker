/**
 * calendar.js
 * Handles Google OAuth (implicit flow) and Google Calendar API calls.
 *
 * Config stored in localStorage under 'ct_gcal_config'.
 *
 * Each contact stores:
 *   calendarEventId: string | null
 *
 * Flow:
 *   1. User pastes client ID in Settings → clicks "Connect Google Account"
 *   2. OAuth popup completes → access token stored in sessionStorage
 *   3. On any contact save/log, upsertEvent() is called
 *   4. On contact delete, deleteEvent() is called
 */

const GCalendar = (() => {

  const SCOPES  = 'https://www.googleapis.com/auth/calendar.events';
  const API     = 'https://www.googleapis.com/calendar/v3';
  const GAPI    = 'https://accounts.google.com/o/oauth2/v2/auth';
  const CLIENT_ID = '807399165696-ssf3cp6b7r1m20g83jlhiad1c6g0oi7p.apps.googleusercontent.com';

  // ── Config ──────────────────────────────────────────────

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem('ct_gcal_config') || '{}');
    } catch { return {}; }
  }

  function saveConfig(cfg) {
    localStorage.setItem('ct_gcal_config', JSON.stringify(cfg));
  }

  function getToken() {
    return sessionStorage.getItem('ct_gcal_token') || null;
  }

  function setToken(token, expiresIn) {
    sessionStorage.setItem('ct_gcal_token', token);
    const exp = Date.now() + (parseInt(expiresIn, 10) - 60) * 1000;
    sessionStorage.setItem('ct_gcal_token_exp', exp.toString());
  }

  function tokenValid() {
    const token = getToken();
    const exp   = parseInt(sessionStorage.getItem('ct_gcal_token_exp') || '0', 10);
    return !!(token && Date.now() < exp);
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.clientId && c.calendarId);
  }

  // ── OAuth implicit flow ──────────────────────────────────

  function buildAuthUrl() {
    const redirect = window.location.origin + window.location.pathname;
    const params   = new URLSearchParams({
      client_id:     CLIENT_ID,
      redirect_uri:  redirect,
      response_type: 'token',
      scope:         SCOPES,
      include_granted_scopes: 'true',
    });
    return `${GAPI}?${params.toString()}`;
  }

  /**
   * Opens the OAuth popup. Returns a Promise that resolves with the access token
   * or rejects on failure/cancel.
   */
  function authorise() {
    return new Promise((resolve, reject) => {
      const url    = buildAuthUrl();
      const popup  = window.open(url, 'gcal_auth', 'width=520,height=620,resizable=yes');

      if (!popup) {
        reject(new Error('Popup blocked. Allow popups for this site and try again.'));
        return;
      }

      const timer = setInterval(() => {
        try {
          const href = popup.location.href;
          if (href.includes('access_token')) {
            clearInterval(timer);
            popup.close();
            const fragment = new URLSearchParams(href.split('#')[1]);
            const token    = fragment.get('access_token');
            const expires  = fragment.get('expires_in');
            if (token) {
              setToken(token, expires);
              resolve(token);
            } else {
              reject(new Error('No access token in response.'));
            }
          }
        } catch (_) {
          // Cross-origin — popup is still on Google's domain, keep waiting
        }
        if (popup.closed) {
          clearInterval(timer);
          if (!tokenValid()) reject(new Error('Authentication cancelled.'));
          else resolve(getToken());
        }
      }, 500);
    });
  }

  // ── API helper ───────────────────────────────────────────

  async function apiCall(method, path, body) {
    const token = getToken();
    if (!token) throw new Error('Not authenticated. Connect Google Account in Settings.');
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err.error && err.error.message) || `Calendar API error ${res.status}`);
    }
    return res.json();
  }

  // ── List calendars ───────────────────────────────────────

  async function listCalendars() {
    const data = await apiCall('GET', '/users/me/calendarList');
    return (data.items || []).map(c => ({ id: c.id, name: c.summary }));
  }

  // ── Build event body ─────────────────────────────────────

  function buildEventBody(contact) {
    const nextDue  = getNextDueDate(contact);
    const dateStr  = toDateString(nextDue);

    // Description: most recent interaction → profile notes → earlier interactions
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
      start:       { date: dateStr },
      end:         { date: dateStr },
      reminders: {
        useDefault: false,
        overrides:  [
          { method: 'popup', minutes: 24 * 60 },  // 1 day before
          { method: 'email', minutes: 24 * 60 },
        ],
      },
    };
  }

  // ── Create or update event ───────────────────────────────

  async function upsertEvent(contact) {
    if (!isConfigured() || !tokenValid()) return contact;

    const { calendarId } = getConfig();
    const eventBody      = buildEventBody(contact);

    try {
      if (contact.calendarEventId) {
        // Update existing event
        await apiCall(
          'PUT',
          `/calendars/${encodeURIComponent(calendarId)}/events/${contact.calendarEventId}`,
          eventBody
        );
        return contact; // eventId unchanged
      } else {
        // Create new event
        const res = await apiCall(
          'POST',
          `/calendars/${encodeURIComponent(calendarId)}/events`,
          eventBody
        );
        return { ...contact, calendarEventId: res.id };
      }
    } catch (e) {
      console.warn('Calendar upsert failed:', e.message);
      return contact; // non-fatal — app still works without calendar
    }
  }

  // ── Delete event ─────────────────────────────────────────

  async function deleteEvent(contact) {
    if (!contact.calendarEventId || !isConfigured() || !tokenValid()) return;
    const { calendarId } = getConfig();
    try {
      await apiCall(
        'DELETE',
        `/calendars/${encodeURIComponent(calendarId)}/events/${contact.calendarEventId}`
      );
    } catch (e) {
      console.warn('Calendar delete failed:', e.message);
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  function getNextDueDate(contact) {
    const base = contact.lastContacted ? new Date(contact.lastContacted) : new Date();
    const days = frequencyToDays(contact.frequency, contact.customDays);
    const next = new Date(base);
    next.setDate(next.getDate() + days);
    return next;
  }

  function frequencyToDays(freq, customDays) {
    const map = {
      weekly:      7,
      fortnightly: 14,
      monthly:     30,
      quarterly:   91,
      annually:    365,
    };
    if (freq === 'custom') return parseInt(customDays, 10) || 30;
    return map[freq] || 30;
  }

  function toDateString(date) {
    return date.toISOString().split('T')[0];
  }

  function formatDate(str) {
    if (!str) return '';
    const d = new Date(str);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // ── Public API ───────────────────────────────────────────

  return {
    authorise,
    listCalendars,
    upsertEvent,
    deleteEvent,
    getConfig,
    saveConfig,
    isConfigured,
    tokenValid,
    getToken,
    frequencyToDays,
    getNextDueDate,
  };

})();
