/**
 * github-sync.js
 * Reads and writes contacts.json in a private GitHub repository
 * via the GitHub Contents API.
 *
 * Config is stored in localStorage under 'ct_github_config'.
 */

const GitHubSync = (() => {

  const API = 'https://api.github.com';
  const FILE = 'contacts.json';

  // ── Config ──────────────────────────────────────────────

  function getConfig() {
    try {
      return JSON.parse(localStorage.getItem('ct_github_config') || '{}');
    } catch { return {}; }
  }

  function saveConfig(cfg) {
    localStorage.setItem('ct_github_config', JSON.stringify(cfg));
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.token && c.repo);
  }

  // ── Low-level API call ───────────────────────────────────

  async function apiCall(method, path, body) {
    const { token } = getConfig();
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept':        'application/vnd.github.v3+json',
        'Content-Type':  'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub API error ${res.status}`);
    }
    return res.json();
  }

  // ── Read contacts.json ───────────────────────────────────

  async function load() {
    if (!isConfigured()) {
      // Fall back to localStorage when not configured
      try {
        return JSON.parse(localStorage.getItem('ct_data') || 'null') || defaultData();
      } catch { return defaultData(); }
    }

    const { repo } = getConfig();
    try {
      const file = await apiCall('GET', `/repos/${repo}/contents/${FILE}`);
      const raw  = atob(file.content.replace(/\n/g, ''));
      const data = JSON.parse(raw);
      // Cache sha for the next write
      const cfg  = getConfig();
      cfg.fileSha = file.sha;
      saveConfig(cfg);
      // Mirror to localStorage as offline cache
      localStorage.setItem('ct_data', JSON.stringify(data));
      return data;
    } catch (e) {
      if (e.message && e.message.includes('Not Found')) {
        // File doesn't exist yet — return empty data
        return defaultData();
      }
      // Network issue — serve from local cache
      console.warn('GitHub sync: falling back to local cache.', e);
      try {
        return JSON.parse(localStorage.getItem('ct_data') || 'null') || defaultData();
      } catch { return defaultData(); }
    }
  }

  // ── Write contacts.json ──────────────────────────────────

  async function save(data) {
    // Always keep local cache up to date
    localStorage.setItem('ct_data', JSON.stringify(data));

    if (!isConfigured()) return;

    const { repo, fileSha } = getConfig();
    const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));

    const body = {
      message: `Update contacts ${new Date().toISOString()}`,
      content,
    };
    if (fileSha) body.sha = fileSha;

    try {
      const res = await apiCall('PUT', `/repos/${repo}/contents/${FILE}`, body);
      // Store updated sha
      const cfg = getConfig();
      cfg.fileSha = res.content.sha;
      saveConfig(cfg);
    } catch (e) {
      // If sha mismatch (concurrent edit), pull latest sha and retry once
      if (e.message && e.message.includes('sha')) {
        try {
          const file = await apiCall('GET', `/repos/${repo}/contents/${FILE}`);
          const cfg  = getConfig();
          cfg.fileSha = file.sha;
          saveConfig(cfg);
          body.sha = file.sha;
          const res = await apiCall('PUT', `/repos/${repo}/contents/${FILE}`, body);
          const cfg2 = getConfig();
          cfg2.fileSha = res.content.sha;
          saveConfig(cfg2);
        } catch (e2) {
          console.error('GitHub sync: retry failed.', e2);
          throw e2;
        }
      } else {
        console.error('GitHub sync: save failed.', e);
        throw e;
      }
    }
  }

  // ── Test connection ──────────────────────────────────────

  async function testConnection() {
    if (!isConfigured()) throw new Error('Not configured');
    const { repo } = getConfig();
    // Just fetch repo metadata
    await apiCall('GET', `/repos/${repo}`);
    return true;
  }

  // ── Default data shape ───────────────────────────────────

  function defaultData() {
    return {
      contacts:   [],
      categories: ['Friend', 'Family', 'Colleague', 'Mentor', 'Client', 'Ex-colleague', 'Other'],
      version:    1,
    };
  }

  // ── Public API ───────────────────────────────────────────

  return { load, save, testConnection, getConfig, saveConfig, isConfigured, defaultData };

})();
