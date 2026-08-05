/**
 * app.js
 * Main application controller for the Contact Tracker.
 */

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  contacts:   [],
  categories: ['Friend', 'Family', 'Colleague', 'Mentor', 'Client', 'Ex-colleague', 'Other'],
  version:    1,
};

let saveTimeout = null;
let sortState = { col: 'name', dir: 'asc' };

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  setDashboardDate();
  await loadData();
  bindNav();
  bindSettings();
  bindAddContact();
  bindContactForm();
  bindLogForm();
  bindConfirmModal();
  bindSearch();
  bindImport();
  bindTableSort();
  bindReconnectBanner();
  checkCalendarToken();
  renderAll();
}

// ── Data ──────────────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const data = await GitHubSync.load();
    state.contacts   = data.contacts   || [];
    state.categories = data.categories || state.categories;
  } catch (e) {
    console.error('Load failed:', e);
  }
}

function scheduleSave() {
  // Debounce saves — GitHub API has rate limits
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(persistData, 800);
}

async function persistData() {
  try {
    await GitHubSync.save({
      contacts:   state.contacts,
      categories: state.categories,
      version:    state.version,
    });
  } catch (e) {
    showToast('Save failed: ' + e.message, 'error');
  }
}

// ── Google reconnect banner ───────────────────────────────────────────────────

function checkCalendarToken() {
  const cfg = GCalendar.getConfig();
  // Only show banner if calendar has been set up but token has expired
  if (cfg.calendarId && !GCalendar.tokenValid()) {
    showReconnectBanner();
  }
}

function showReconnectBanner() {
  const banner = document.getElementById('gcal-reconnect-banner');
  if (banner) banner.style.display = '';
}

function hideReconnectBanner() {
  const banner = document.getElementById('gcal-reconnect-banner');
  if (banner) banner.style.display = 'none';
}

function bindReconnectBanner() {
  const reconnectBtn = document.getElementById('btn-reconnect-gcal');
  const dismissBtn   = document.getElementById('btn-dismiss-reconnect');

  if (reconnectBtn) {
    reconnectBtn.addEventListener('click', async () => {
      reconnectBtn.textContent = 'Connecting…';
      reconnectBtn.disabled = true;
      try {
        await GCalendar.authorise();
        hideReconnectBanner();
        showToast('Google Calendar reconnected.');
      } catch (e) {
        reconnectBtn.textContent = 'Reconnect';
        reconnectBtn.disabled = false;
        showToast('Reconnect failed: ' + e.message, 'error');
      }
    });
  }

  if (dismissBtn) {
    dismissBtn.addEventListener('click', hideReconnectBanner);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

function bindNav() {
  // Desktop sidebar
  document.querySelectorAll('.nav-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      const view = link.dataset.view;
      showView(view);
      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
      link.classList.add('active');
      syncMobileNav(view);
    });
  });

  // Mobile bottom nav — view buttons
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      showView(view);
      syncMobileNav(view);
      // Also sync desktop sidebar highlight
      document.querySelectorAll('.nav-link').forEach(l => {
        l.classList.toggle('active', l.dataset.view === view);
      });
    });
  });

  // Mobile add button
  const mobileAdd = document.getElementById('mobile-add-btn');
  if (mobileAdd) mobileAdd.addEventListener('click', () => openEditModal(null));

  // Mobile import button
  const mobileImport = document.getElementById('mobile-import-btn');
  if (mobileImport) mobileImport.addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });
}

function syncMobileNav(activeView) {
  document.querySelectorAll('.mobile-nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === activeView);
  });
}

function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById(`view-${name}`);
  if (el) {
    el.classList.add('active');
    if (name === 'dashboard') renderDashboard();
    if (name === 'contacts')  renderContactTable();
    if (name === 'settings')  renderSettings();
  }
}

// ── Render all ────────────────────────────────────────────────────────────────

function renderAll() {
  renderDashboard();
  renderContactTable();
  renderSettings();
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function setDashboardDate() {
  const el = document.getElementById('dashboard-date');
  if (el) el.textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function renderDashboard() {
  const today    = new Date(); today.setHours(0,0,0,0);
  const window14 = new Date(today); window14.setDate(today.getDate() + 14);

  const overdue = [];
  const dueSoon = [];

  state.contacts.forEach(c => {
    const next = GCalendar.getNextDueDate(c);
    next.setHours(0,0,0,0);
    const diffDays = Math.round((next - today) / 86400000);

    if (diffDays < 0)         overdue.push({ contact: c, diffDays });
    else if (next <= window14) dueSoon.push({ contact: c, diffDays });
  });

  overdue.sort((a, b) => a.diffDays - b.diffDays);
  dueSoon.sort((a, b) => a.diffDays - b.diffDays);

  renderBand('grid-overdue', 'count-overdue', overdue, 'overdue');
  renderBand('grid-due',     'count-due',     dueSoon, 'due-soon');
}

function renderBand(gridId, countId, items, statusClass) {
  const grid  = document.getElementById(gridId);
  const count = document.getElementById(countId);
  if (!grid) return;

  count.textContent = items.length || '';

  if (!items.length) {
    grid.innerHTML = '<p class="empty-state">None right now.</p>';
    return;
  }

  grid.innerHTML = items.map(({ contact, diffDays }) => {
    const catColour = categoryColour(contact.category);
    const dayLabel  = diffDays === 0
      ? 'Today'
      : diffDays > 0
        ? `In ${diffDays}d`
        : `${Math.abs(diffDays)}d overdue`;

    return `
      <div class="contact-card ${statusClass}"
           style="--cat-color: ${catColour}"
           data-id="${contact.id}"
           role="button" tabindex="0">
        <div class="card-name">${esc(contact.name)}</div>
        <div class="card-meta">${esc(contact.company || contact.category || '')}</div>
        <div class="card-footer">
          <span class="card-tag" style="background:${catColour}18;color:${catColour}">
            ${esc(contact.category || 'Uncategorised')}
          </span>
          <span class="card-days">${dayLabel}</span>
        </div>
      </div>`;
  }).join('');

  grid.querySelectorAll('.contact-card').forEach(card => {
    card.addEventListener('click', () => openContactDetail(card.dataset.id));
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') openContactDetail(card.dataset.id);
    });
  });
}

// ── Contact table ─────────────────────────────────────────────────────────────

function renderContactTable() {
  const tbody   = document.getElementById('contact-table-body');
  const empty   = document.getElementById('contacts-empty');
  const search  = (document.getElementById('search-contacts').value || '').toLowerCase();
  const catFilt = document.getElementById('filter-category').value;
  const freqFilt= document.getElementById('filter-frequency').value;

  let filtered = state.contacts.filter(c => {
    const matchSearch = !search ||
      c.name.toLowerCase().includes(search) ||
      (c.company || '').toLowerCase().includes(search);
    const matchCat  = !catFilt  || c.category  === catFilt;
    const matchFreq = !freqFilt || c.frequency === freqFilt;
    return matchSearch && matchCat && matchFreq;
  });

  // Populate category filter options
  const catSelect = document.getElementById('filter-category');
  const prevCat   = catSelect.value;
  catSelect.innerHTML = '<option value="">All categories</option>' +
    state.categories.map(c => `<option value="${esc(c)}"${c === prevCat ? ' selected' : ''}>${esc(c)}</option>`).join('');

  // Sort
  const today = new Date(); today.setHours(0,0,0,0);

  filtered.sort((a, b) => {
    let av, bv;
    if (sortState.col === 'name') {
      av = a.name.toLowerCase(); bv = b.name.toLowerCase();
    } else if (sortState.col === 'category') {
      av = (a.category || '').toLowerCase(); bv = (b.category || '').toLowerCase();
    } else if (sortState.col === 'frequency') {
      av = GCalendar.frequencyToDays(a.frequency, a.customDays);
      bv = GCalendar.frequencyToDays(b.frequency, b.customDays);
    } else if (sortState.col === 'lastContacted') {
      av = a.lastContacted || '0000-00-00'; bv = b.lastContacted || '0000-00-00';
    } else if (sortState.col === 'nextDue') {
      av = GCalendar.getNextDueDate(a).getTime();
      bv = GCalendar.getNextDueDate(b).getTime();
    } else if (sortState.col === 'status') {
      const diffA = Math.round((GCalendar.getNextDueDate(a) - today) / 86400000);
      const diffB = Math.round((GCalendar.getNextDueDate(b) - today) / 86400000);
      av = diffA; bv = diffB;
    }
    if (av < bv) return sortState.dir === 'asc' ? -1 : 1;
    if (av > bv) return sortState.dir === 'asc' ? 1 : -1;
    return 0;
  });

  if (!filtered.length) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    // Still update headers
    updateSortHeaders();
    return;
  }
  empty.style.display = 'none';

  tbody.innerHTML = filtered.map(c => {
    const next    = GCalendar.getNextDueDate(c);
    next.setHours(0,0,0,0);
    const diff    = Math.round((next - today) / 86400000);
    const status  = diff < 0 ? 'overdue' : diff <= 14 ? 'due-soon' : 'on-track';
    const label   = diff === 0 ? 'Today' : diff > 0 ? `In ${diff}d` : `${Math.abs(diff)}d overdue`;
    const cat     = catColour(c.category);
    const freqLabel = freqDisplay(c.frequency, c.customDays);

    return `<tr data-id="${c.id}">
      <td>
        <div style="display:flex;align-items:center;gap:.5rem">
          <span class="cat-dot" style="background:${cat}"></span>
          <strong>${esc(c.name)}</strong>
        </div>
      </td>
      <td>${esc(c.category || '—')}</td>
      <td>${freqLabel}</td>
      <td>${c.lastContacted ? formatDate(c.lastContacted) : '—'}</td>
      <td class="mono" style="font-size:.8rem">${formatDate(toDateString(next))}</td>
      <td><span class="status-pill ${status}">${label}</span></td>
      <td>
        <div class="row-actions">
          <button class="btn-icon" data-action="log"  data-id="${c.id}" title="Log interaction">Log</button>
          <button class="btn-icon" data-action="edit" data-id="${c.id}" title="Edit contact">Edit</button>
          <button class="btn-icon danger" data-action="delete" data-id="${c.id}" title="Delete">Del</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('[data-action]')) return;
      openContactDetail(row.dataset.id);
    });
  });

  tbody.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const { action, id } = btn.dataset;
      if (action === 'log')    openLogModal(id);
      if (action === 'edit')   openEditModal(id);
      if (action === 'delete') confirmDelete(id);
    });
  });

  updateSortHeaders();
}

function updateSortHeaders() {
  document.querySelectorAll('#contact-table th.sortable').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === sortState.col) {
      th.classList.add(sortState.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function bindTableSort() {
  document.querySelectorAll('#contact-table th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (sortState.col === col) {
        sortState.dir = sortState.dir === 'asc' ? 'desc' : 'asc';
      } else {
        sortState.col = col;
        sortState.dir = 'asc';
      }
      renderContactTable();
    });
  });
}

function bindSearch() {
  document.getElementById('search-contacts').addEventListener('input', renderContactTable);
  document.getElementById('filter-category').addEventListener('change', renderContactTable);
  document.getElementById('filter-frequency').addEventListener('change', renderContactTable);
}

// ── CSV Import ────────────────────────────────────────────────────────────────

function bindImport() {
  document.getElementById('btn-import-csv').addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });

  document.getElementById('csv-file-input').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    e.target.value = ''; // reset so same file can be re-uploaded
    importCSV(text);
  });
}

function parseCSVLine(line) {
  const cols = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

function importCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    showToast('CSV file is empty or has no data rows.', 'error');
    return;
  }

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const validFreqs = ['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually', 'custom'];

  let imported = 0;
  let skipped  = 0;
  const skippedNames = [];
  const errors = [];

  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const cols = parseCSVLine(lines[i]);
    const row  = {};
    headers.forEach((h, idx) => { row[h] = (cols[idx] || '').trim(); });

    const name = row['name'];
    if (!name) { errors.push(`Row ${i + 1}: no name, skipped.`); continue; }

    // Duplicate check
    const exists = state.contacts.find(
      c => c.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      skipped++;
      skippedNames.push(name);
      continue;
    }

    // Validate / default frequency
    let freq = (row['frequency'] || 'monthly').toLowerCase();
    if (!validFreqs.includes(freq)) freq = 'monthly';

    const contact = {
      id:            uid(),
      name,
      company:       row['company']       || '',
      howMet:        row['how_met']        || '',
      category:      row['category']       || 'Other',
      frequency:     freq,
      customDays:    freq === 'custom' ? (row['custom_days'] || '30') : null,
      notes:         row['notes']          || '',
      lastContacted: row['last_contacted'] || null,
      interactions:  [],
      calendarEventId: null,
      createdAt:     new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
    };

    state.contacts.push(contact);
    imported++;
  }

  // Show import result modal
  showImportResult({ imported, skipped, skippedNames, errors });

  if (imported > 0) {
    // Queue calendar events in background — don't block UI
    syncImportedCalendarEvents();
    scheduleSave();
    renderAll();
  }
}

async function syncImportedCalendarEvents() {
  // Process contacts that have no calendarEventId yet
  const unsynced = state.contacts.filter(c => !c.calendarEventId);
  for (const contact of unsynced) {
    const idx = state.contacts.findIndex(c => c.id === contact.id);
    if (idx === -1) continue;
    state.contacts[idx] = await GCalendar.upsertEvent(contact);
  }
  scheduleSave();
}

function showImportResult({ imported, skipped, skippedNames, errors }) {
  let msg = `Import complete. ${imported} contact${imported !== 1 ? 's' : ''} added.`;
  if (skipped > 0) {
    msg += ` ${skipped} skipped (already exist): ${skippedNames.join(', ')}.`;
  }
  if (errors.length > 0) {
    msg += ` ${errors.length} error${errors.length !== 1 ? 's' : ''}: ${errors.join(' ')}`;
  }
  const type = imported > 0 ? 'ok' : 'error';

  // Use a longer-lived toast for import results
  let toast = document.getElementById('ct-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ct-toast';
    toast.style.cssText = `
      position:fixed; bottom:1.5rem; right:1.5rem; z-index:9999;
      padding:.65rem 1.1rem; border-radius:6px; font-size:.85rem;
      font-family:var(--font-body); box-shadow:0 4px 12px rgba(0,0,0,.15);
      transition:opacity .3s; max-width:400px; line-height:1.5;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'error' ? 'var(--red)' : 'var(--text)';
  toast.style.color       = '#fff';
  toast.style.opacity     = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 8000);
}

// ── Contact detail modal ──────────────────────────────────────────────────────

function openContactDetail(id) {
  const contact = state.contacts.find(c => c.id === id);
  if (!contact) return;

  const body    = document.getElementById('modal-contact-body');
  const today   = new Date(); today.setHours(0,0,0,0);
  const next    = GCalendar.getNextDueDate(contact);
  next.setHours(0,0,0,0);
  const diff    = Math.round((next - today) / 86400000);
  const status  = diff < 0 ? 'overdue' : diff <= 14 ? 'due-soon' : 'on-track';
  const dayLabel= diff === 0 ? 'Today' : diff > 0 ? `Due in ${diff} days` : `${Math.abs(diff)} days overdue`;
  const cat     = catColour(contact.category);

  const interactions = [...(contact.interactions || [])].sort(
    (a, b) => new Date(b.date) - new Date(a.date)
  );

  body.innerHTML = `
    <div class="detail-header">
      <div class="detail-avatar" style="background:${cat}">${initials(contact.name)}</div>
      <div>
        <div class="detail-name">${esc(contact.name)}</div>
        <div class="detail-sub">
          ${esc(contact.company || '')}${contact.company && contact.category ? ' · ' : ''}${esc(contact.category || '')}
        </div>
      </div>
      <div class="detail-actions">
        <button class="btn-secondary" id="detail-log-btn">Log interaction</button>
        <button class="btn-secondary" id="detail-edit-btn">Edit</button>
        <button class="btn-icon danger" id="detail-delete-btn">Delete</button>
      </div>
    </div>

    <div class="detail-grid">
      <div class="detail-section">
        <h3>Contact info</h3>
        <div class="detail-field">
          <label>Frequency</label>
          <span>${freqDisplay(contact.frequency, contact.customDays)}</span>
        </div>
        <div class="detail-field">
          <label>Last contacted</label>
          <span>${contact.lastContacted ? formatDate(contact.lastContacted) : '—'}</span>
        </div>
        <div class="detail-field">
          <label>Next due</label>
          <span class="${status}">${formatDate(toDateString(next))} &nbsp;<small>(${dayLabel})</small></span>
        </div>
        ${contact.howMet ? `
        <div class="detail-field">
          <label>How we met</label>
          <span>${esc(contact.howMet)}</span>
        </div>` : ''}
      </div>

      <div class="detail-section">
        <h3>Profile notes</h3>
        <div class="notes-box">${esc(contact.notes || 'No profile notes yet.')}</div>
      </div>
    </div>

    <div class="detail-section">
      <h3>Interactions (${interactions.length})</h3>
      ${interactions.length ? `
        <div class="interactions-list">
          ${interactions.map(i => `
            <div class="interaction-item">
              <div class="interaction-header">
                <span class="interaction-date">${formatDate(i.date)}</span>
                <span class="interaction-medium">${esc(i.medium || 'other')}</span>
              </div>
              <div class="interaction-summary">${esc(i.summary || 'No notes recorded.')}</div>
            </div>`).join('')}
        </div>` :
        '<p class="empty-state">No interactions logged yet.</p>'
      }
    </div>
  `;

  document.getElementById('detail-log-btn').addEventListener('click', () => {
    closeModal('modal-contact');
    openLogModal(id);
  });
  document.getElementById('detail-edit-btn').addEventListener('click', () => {
    closeModal('modal-contact');
    openEditModal(id);
  });
  document.getElementById('detail-delete-btn').addEventListener('click', () => {
    closeModal('modal-contact');
    confirmDelete(id);
  });

  openModal('modal-contact');
}

document.getElementById('btn-close-contact').addEventListener('click', () => closeModal('modal-contact'));

// ── Add / Edit contact modal ──────────────────────────────────────────────────

function bindAddContact() {
  document.getElementById('btn-add-contact').addEventListener('click', () => openEditModal(null));
}

function openEditModal(id) {
  const contact = id ? state.contacts.find(c => c.id === id) : null;

  document.getElementById('edit-modal-title').textContent = contact ? 'Edit contact' : 'Add contact';
  document.getElementById('edit-contact-id').value        = id || '';

  // Populate category select
  const catSelect = document.getElementById('edit-category');
  catSelect.innerHTML = state.categories.map(cat =>
    `<option value="${esc(cat)}">${esc(cat)}</option>`
  ).join('');

  if (contact) {
    document.getElementById('edit-name').value          = contact.name || '';
    document.getElementById('edit-company').value       = contact.company || '';
    document.getElementById('edit-how-met').value       = contact.howMet || '';
    document.getElementById('edit-category').value      = contact.category || state.categories[0];
    document.getElementById('edit-frequency').value     = contact.frequency || 'monthly';
    document.getElementById('edit-custom-days').value   = contact.customDays || '';
    document.getElementById('edit-notes').value         = contact.notes || '';
    document.getElementById('edit-last-contacted').value= contact.lastContacted || '';
    toggleCustomFreq(contact.frequency === 'custom');
  } else {
    document.getElementById('contact-form').reset();
    toggleCustomFreq(false);
  }

  openModal('modal-edit');
}

function toggleCustomFreq(show) {
  document.getElementById('custom-freq-wrap').style.display = show ? '' : 'none';
}

document.getElementById('edit-frequency').addEventListener('change', e => {
  toggleCustomFreq(e.target.value === 'custom');
});

function bindContactForm() {
  document.getElementById('contact-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id       = document.getElementById('edit-contact-id').value;
    const freq     = document.getElementById('edit-frequency').value;
    const existing = id ? state.contacts.find(c => c.id === id) : null;

    let contact = {
      id:            id || uid(),
      name:          document.getElementById('edit-name').value.trim(),
      company:       document.getElementById('edit-company').value.trim(),
      howMet:        document.getElementById('edit-how-met').value.trim(),
      category:      document.getElementById('edit-category').value,
      frequency:     freq,
      customDays:    freq === 'custom' ? document.getElementById('edit-custom-days').value : null,
      notes:         document.getElementById('edit-notes').value.trim(),
      lastContacted: document.getElementById('edit-last-contacted').value || null,
      interactions:  existing ? existing.interactions : [],
      calendarEventId: existing ? existing.calendarEventId : null,
      createdAt:     existing ? existing.createdAt : new Date().toISOString(),
      updatedAt:     new Date().toISOString(),
    };

    if (!contact.name) { alert('Name is required.'); return; }

    // Duplicate check — only for new contacts, not edits
    if (!existing) {
      const duplicate = state.contacts.find(
        c => c.name.trim().toLowerCase() === contact.name.toLowerCase()
      );
      if (duplicate) {
        showToast(`${contact.name} already exists as a contact.`, 'error');
        return;
      }
    }

    // Calendar sync
    contact = await GCalendar.upsertEvent(contact);

    if (existing) {
      const idx = state.contacts.findIndex(c => c.id === id);
      state.contacts[idx] = contact;
    } else {
      state.contacts.push(contact);
    }

    closeModal('modal-edit');
    scheduleSave();
    renderAll();
    showToast(`${contact.name} saved.`);
  });
}

document.getElementById('btn-close-edit').addEventListener('click',   () => closeModal('modal-edit'));
document.getElementById('btn-cancel-edit').addEventListener('click',   () => closeModal('modal-edit'));

// ── Log interaction modal ─────────────────────────────────────────────────────

function openLogModal(id) {
  document.getElementById('log-contact-id').value = id;
  document.getElementById('log-date').value       = toDateString(new Date());
  document.getElementById('log-summary').value    = '';
  document.getElementById('log-medium').value     = 'call';
  document.getElementById('log-reset-timer').checked = true;
  openModal('modal-log');
}

function bindLogForm() {
  document.getElementById('log-form').addEventListener('submit', async e => {
    e.preventDefault();
    const id    = document.getElementById('log-contact-id').value;
    const idx   = state.contacts.findIndex(c => c.id === id);
    if (idx === -1) return;

    const date   = document.getElementById('log-date').value;
    const medium = document.getElementById('log-medium').value;
    const summary= document.getElementById('log-summary').value.trim();
    const reset  = document.getElementById('log-reset-timer').checked;

    const interaction = {
      id:      uid(),
      date,
      medium,
      summary,
      loggedAt: new Date().toISOString(),
    };

    let contact = { ...state.contacts[idx] };
    contact.interactions = [...(contact.interactions || []), interaction];

    if (reset) contact.lastContacted = date;
    contact.updatedAt = new Date().toISOString();

    // Update calendar event with new next-due date
    contact = await GCalendar.upsertEvent(contact);

    state.contacts[idx] = contact;
    closeModal('modal-log');
    scheduleSave();
    renderAll();
    showToast(`Interaction logged for ${contact.name}.`);
  });
}

document.getElementById('btn-close-log').addEventListener('click',   () => closeModal('modal-log'));
document.getElementById('btn-cancel-log').addEventListener('click',  () => closeModal('modal-log'));

// ── Delete ────────────────────────────────────────────────────────────────────

let pendingDeleteId = null;

function confirmDelete(id) {
  const contact = state.contacts.find(c => c.id === id);
  if (!contact) return;
  document.getElementById('confirm-message').textContent =
    `This will permanently remove ${contact.name} and all their interaction history.`;
  pendingDeleteId = id;
  openModal('modal-confirm');
}

function bindConfirmModal() {
  document.getElementById('btn-confirm-ok').addEventListener('click', async () => {
    if (!pendingDeleteId) return;
    const contact = state.contacts.find(c => c.id === pendingDeleteId);
    if (contact) await GCalendar.deleteEvent(contact);
    state.contacts = state.contacts.filter(c => c.id !== pendingDeleteId);
    pendingDeleteId = null;
    closeModal('modal-confirm');
    scheduleSave();
    renderAll();
    showToast('Contact deleted.');
  });

  document.getElementById('btn-confirm-cancel').addEventListener('click', () => {
    pendingDeleteId = null;
    closeModal('modal-confirm');
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────

function renderSettings() {
  const ghCfg   = GitHubSync.getConfig();
  if (ghCfg.token) document.getElementById('setting-gh-token').value = ghCfg.token;
  if (ghCfg.repo)  document.getElementById('setting-gh-repo').value  = ghCfg.repo;
  renderCategoryList();
}

function bindSettings() {
  // GitHub
  document.getElementById('btn-save-github').addEventListener('click', async () => {
    const token = document.getElementById('setting-gh-token').value.trim();
    const repo  = document.getElementById('setting-gh-repo').value.trim();
    const status= document.getElementById('github-status');

    if (!token || !repo) { status.textContent = 'Enter both token and repository.'; status.className = 'settings-status err'; return; }

    GitHubSync.saveConfig({ token, repo });
    status.textContent = 'Testing…'; status.className = 'settings-status';

    try {
      await GitHubSync.testConnection();
      status.textContent = 'Connected. Loading data from GitHub…'; status.className = 'settings-status ok';
      await loadData();
      renderAll();
    } catch (e) {
      status.textContent = 'Connection failed: ' + e.message; status.className = 'settings-status err';
    }
  });

  // Google Calendar auth
  document.getElementById('btn-gcal-auth').addEventListener('click', async () => {
    const status = document.getElementById('gcal-status');
    status.textContent = 'Opening Google sign-in…'; status.className = 'settings-status';

    try {
      await GCalendar.authorise();
      status.textContent = 'Connected. Calendar reminders are active.';
      status.className = 'settings-status ok';
      hideReconnectBanner();
    } catch (e) {
      status.textContent = 'Auth failed: ' + e.message; status.className = 'settings-status err';
    }
  });

  // Add category
  document.getElementById('btn-add-category').addEventListener('click', addCategory);
  document.getElementById('new-category-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addCategory(); }
  });
}

function addCategory() {
  const input = document.getElementById('new-category-input');
  const name  = input.value.trim();
  if (!name) return;
  if (state.categories.includes(name)) {
    showToast('Category already exists.', 'error');
    return;
  }
  state.categories.push(name);
  input.value = '';
  renderCategoryList();
  scheduleSave();
  showToast(`Category "${name}" added.`);
}

const BUILT_IN = ['Friend', 'Family', 'Colleague', 'Mentor', 'Client', 'Ex-colleague', 'Other'];

function renderCategoryList() {
  const list = document.getElementById('category-list');
  list.innerHTML = state.categories.map(cat => {
    const builtIn = BUILT_IN.includes(cat);
    return `
      <span class="tag-item${builtIn ? ' built-in' : ''}" style="border-color:${catColour(cat)}30">
        <span class="cat-dot" style="background:${catColour(cat)}"></span>
        ${esc(cat)}
        <button data-cat="${esc(cat)}" title="Remove category" aria-label="Remove ${esc(cat)}">&times;</button>
      </span>`;
  }).join('');

  list.querySelectorAll('button[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat;
      if (BUILT_IN.includes(cat)) return;
      if (!confirm(`Remove category "${cat}"? Contacts using it will keep the label but it won't appear in menus.`)) return;
      state.categories = state.categories.filter(c => c !== cat);
      renderCategoryList();
      scheduleSave();
    });
  });
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function openModal(id) {
  document.getElementById(id).classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
  document.body.style.overflow = '';
}

// Close on overlay click
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeModal(overlay.id);
  });
});

// Close on Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => closeModal(m.id));
  }
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function showToast(msg, type = 'ok') {
  let toast = document.getElementById('ct-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'ct-toast';
    toast.style.cssText = `
      position:fixed; bottom:1.5rem; right:1.5rem; z-index:9999;
      padding:.65rem 1.1rem; border-radius:6px; font-size:.85rem;
      font-family:var(--font-body); box-shadow:0 4px 12px rgba(0,0,0,.15);
      transition:opacity .3s; max-width:320px;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.background = type === 'error' ? 'var(--red)'   : 'var(--text)';
  toast.style.color       = '#fff';
  toast.style.opacity     = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + (str.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function toDateString(date) {
  return date.toISOString().split('T')[0];
}

function initials(name) {
  return (name || '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('');
}

function freqDisplay(freq, customDays) {
  if (freq === 'custom') return `Every ${customDays || '?'} days`;
  const map = { weekly: 'Weekly', fortnightly: 'Fortnightly', monthly: 'Monthly', quarterly: 'Quarterly', annually: 'Annually' };
  return map[freq] || freq;
}

const CAT_COLOURS = [
  '#2B6CB0','#276749','#9B2C2C','#744210',
  '#553C9A','#086F83','#702459','#1A365D',
];

const _catMap = {};

function catColour(cat) {
  if (!cat) return CAT_COLOURS[0];
  if (!_catMap[cat]) {
    const idx = Object.keys(_catMap).length % CAT_COLOURS.length;
    _catMap[cat] = CAT_COLOURS[idx];
  }
  return _catMap[cat];
}

// alias used inside renderContactTable
function categoryColour(cat) { return catColour(cat); }

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
