// js/attendance.js
//
// Daily attendance sheet. URL-driven state (#/attendance?section=<id>&date=<yyyy-mm-dd>)
// so switching section/date is a real (cheap) route re-render, but marking a
// status or saving a note updates just that row — no full remount, no page
// reload. Every write is an upsert keyed on (student_id, date), matching the
// schema's unique constraint, so re-marking a student just overwrites today's
// row instead of creating duplicates.

import { supabase, STORAGE_BUCKET } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const STATUSES = [
  { key: 'present', label: 'Present', short: 'P' },
  { key: 'absent',  label: 'Absent',  short: 'A' },
  { key: 'late',    label: 'Late',    short: 'L' },
  { key: 'excused', label: 'Excused', short: 'E' },
];

const SIGNED_URL_TTL = 3600;

export async function renderAttendance(mount, params) {
  mount.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;

  const { data: sections, error: sectionsError } = await supabase
    .from('sections')
    .select('id, name')
    .order('name', { ascending: true });

  if (sectionsError) {
    mount.innerHTML = `<div class="empty-state"><h3>Couldn't load sections</h3><p>${escapeHtml(sectionsError.message)}</p></div>`;
    return;
  }

  if (!sections || sections.length === 0) {
    mount.innerHTML = `
      <div class="empty-state">
        <h3>No sections yet</h3>
        <p>Add a section and a few students before taking attendance.</p>
        <button class="btn btn-primary" id="go-to-sections-btn" style="width:auto;margin-top:14px;">Go to Sections</button>
      </div>
    `;
    mount.querySelector('#go-to-sections-btn').addEventListener('click', () => navigate('sections'));
    return;
  }

  // Resolve/normalize URL state; redirect (replace) if section/date is missing or invalid.
  const sectionId = sections.some((s) => s.id === params?.section) ? params.section : sections[0].id;
  const date = isValidDateStr(params?.date) ? params.date : todayStr();

  if (sectionId !== params?.section || date !== params?.date) {
    navigate(`attendance?section=${sectionId}&date=${date}`, true);
    return;
  }

  mount.innerHTML = `
    <div class="view-header">
      <div>
        <h2>Attendance</h2>
        <p class="view-header__sub" id="attendance-date-display">${formatDateDisplay(date)}</p>
      </div>
      <span class="sync-indicator" id="sync-indicator"></span>
    </div>

    <div class="attendance-toolbar">
      <div class="field attendance-toolbar__field">
        <label for="section-select">Section</label>
        <select id="section-select">
          ${sections.map((s) => `<option value="${s.id}" ${s.id === sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field attendance-toolbar__field">
        <label for="date-input">Date</label>
        <div class="date-nav">
          <button type="button" class="icon-btn" id="date-prev" aria-label="Previous day">&#8249;</button>
          <input type="date" id="date-input" value="${date}" />
          <button type="button" class="icon-btn" id="date-next" aria-label="Next day">&#8250;</button>
        </div>
      </div>

      <button class="btn btn-ghost" id="today-btn" style="width:auto;">Today</button>
      <button class="btn btn-primary" id="mark-all-present-btn" style="width:auto;">Mark all present</button>
    </div>

    <div id="attendance-body" class="attendance-body">
      <div class="empty-state"><p>Loading students…</p></div>
    </div>
  `;

  mount.querySelector('#section-select').addEventListener('change', (e) => {
    navigate(`attendance?section=${e.target.value}&date=${date}`);
  });
  mount.querySelector('#date-input').addEventListener('change', (e) => {
    if (isValidDateStr(e.target.value)) navigate(`attendance?section=${sectionId}&date=${e.target.value}`);
  });
  mount.querySelector('#date-prev').addEventListener('click', () => {
    navigate(`attendance?section=${sectionId}&date=${addDaysStr(date, -1)}`);
  });
  mount.querySelector('#date-next').addEventListener('click', () => {
    navigate(`attendance?section=${sectionId}&date=${addDaysStr(date, 1)}`);
  });
  mount.querySelector('#today-btn').addEventListener('click', () => {
    navigate(`attendance?section=${sectionId}&date=${todayStr()}`);
  });

  const state = { records: new Map(), inFlight: 0 };
  const syncIndicator = mount.querySelector('#sync-indicator');
  const body = mount.querySelector('#attendance-body');

  mount.querySelector('#mark-all-present-btn').addEventListener('click', () => markAllPresent(sectionId, date, state, body, syncIndicator));

  await loadAndRenderBody(sectionId, date, state, body, syncIndicator);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAndRenderBody(sectionId, date, state, body, syncIndicator) {
  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('id, name, photo_url')
    .eq('section_id', sectionId)
    .order('name', { ascending: true });

  if (studentsError) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load students</h3><p>${escapeHtml(studentsError.message)}</p></div>`;
    return;
  }

  if (!students || students.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students in this section yet</h3>
        <p>Add students to this section before taking attendance.</p>
        <button class="btn btn-primary" id="go-to-students-btn" style="width:auto;margin-top:14px;">Add students</button>
      </div>
    `;
    body.querySelector('#go-to-students-btn').addEventListener('click', () => navigate(`students?section=${sectionId}`));
    return;
  }

  const studentIds = students.map((s) => s.id);
  const { data: records, error: recordsError } = await supabase
    .from('attendance_records')
    .select('id, student_id, status, notes')
    .eq('date', date)
    .in('student_id', studentIds);

  if (recordsError) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load attendance</h3><p>${escapeHtml(recordsError.message)}</p></div>`;
    return;
  }

  state.records = new Map((records || []).map((r) => [r.student_id, { id: r.id, status: r.status, notes: r.notes }]));

  const photoPaths = students.filter((s) => s.photo_url).map((s) => s.photo_url);
  const signedUrlMap = await getSignedUrls(photoPaths);

  renderRows(students, signedUrlMap, state, body, syncIndicator, sectionId, date);
}

function renderRows(students, signedUrlMap, state, body, syncIndicator, sectionId, date) {
  const presentCount = [...state.records.values()].filter((r) => r.status === 'present').length;

  body.innerHTML = `
    <p class="attendance-summary">${state.records.size} of ${students.length} marked &middot; ${presentCount} present</p>
    <div class="attendance-list">
      ${students.map((s) => rowHtml(s, state.records.get(s.id), signedUrlMap[s.photo_url])).join('')}
    </div>
  `;

  students.forEach((student) => {
    const row = body.querySelector(`[data-row="${student.id}"]`);
    if (!row) return;

    row.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const status = btn.getAttribute('data-status');
        saveRecord(student.id, sectionId, date, { status }, state, row, syncIndicator, () => {
          updateSummary(body, students.length, state);
        });
      });
    });

    row.querySelector('[data-note-btn]')?.addEventListener('click', () => {
      openNoteModal(student, state, sectionId, date, row, syncIndicator, body, students.length);
    });
  });
}

function updateSummary(body, totalStudents, state) {
  const el = body.querySelector('.attendance-summary');
  if (!el) return;
  const presentCount = [...state.records.values()].filter((r) => r.status === 'present').length;
  el.textContent = `${state.records.size} of ${totalStudents} marked \u00B7 ${presentCount} present`;
}

function rowHtml(student, record, signedUrl) {
  const avatarInner = signedUrl
    ? `<img src="${signedUrl}" alt="" />`
    : `<span>${escapeHtml(getInitials(student.name))}</span>`;
  const hasNotes = !!record?.notes;

  return `
    <div class="attendance-row" data-row="${student.id}">
      <div class="attendance-row__student">
        <div class="avatar${signedUrl ? '' : ' avatar--placeholder'}">${avatarInner}</div>
        <span class="attendance-row__name">${escapeHtml(student.name)}</span>
      </div>
      <div class="attendance-row__controls">
        <div class="status-btn-group" role="group" aria-label="Attendance status for ${escapeHtml(student.name)}">
          ${STATUSES.map((s) => `
            <button type="button" class="status-btn status-btn--${s.key}${record?.status === s.key ? ' status-btn--active' : ''}"
              data-status="${s.key}" aria-label="${s.label}" title="${s.label}">${s.short}</button>
          `).join('')}
        </div>
        <button type="button" class="note-btn${hasNotes ? ' note-btn--filled' : ''}" data-note-btn aria-label="${hasNotes ? 'Edit note' : 'Add note'}" title="${hasNotes ? 'Edit note' : 'Add note'}">&#128221;</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

async function saveRecord(studentId, sectionId, date, changes, state, row, syncIndicator, onDone) {
  const previous = state.records.get(studentId);
  const next = {
    status: previous?.status ?? 'present',
    notes: previous?.notes ?? null,
    ...changes,
  };

  // Optimistic UI update
  state.records.set(studentId, { ...previous, ...next });
  reflectRowState(row, next);
  onDone?.();

  beginSync(state, syncIndicator);
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;

    const { data, error } = await supabase
      .from('attendance_records')
      .upsert(
        { user_id: userData.user.id, student_id: studentId, date, status: next.status, notes: next.notes },
        { onConflict: 'student_id,date' }
      )
      .select('id, status, notes')
      .single();
    if (error) throw error;

    state.records.set(studentId, { id: data.id, status: data.status, notes: data.notes });
    endSync(state, syncIndicator, null);
  } catch (err) {
    // Roll back on failure
    if (previous) state.records.set(studentId, previous);
    else state.records.delete(studentId);
    reflectRowState(row, previous ?? { status: null, notes: null });
    onDone?.();
    endSync(state, syncIndicator, err.message || 'Could not save. Check your connection.');
  }
}

function reflectRowState(row, record) {
  row.querySelectorAll('[data-status]').forEach((btn) => {
    btn.classList.toggle('status-btn--active', btn.getAttribute('data-status') === record.status);
  });
  const noteBtn = row.querySelector('[data-note-btn]');
  if (noteBtn) {
    const hasNotes = !!record.notes;
    noteBtn.classList.toggle('note-btn--filled', hasNotes);
    noteBtn.setAttribute('aria-label', hasNotes ? 'Edit note' : 'Add note');
    noteBtn.setAttribute('title', hasNotes ? 'Edit note' : 'Add note');
  }
}

async function markAllPresent(sectionId, date, state, body, syncIndicator) {
  const rows = [...body.querySelectorAll('[data-row]')];
  if (rows.length === 0) return;

  beginSync(state, syncIndicator);
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const userId = userData.user.id;

    const studentIds = rows.map((r) => r.getAttribute('data-row'));
    const payload = studentIds.map((studentId) => ({
      user_id: userId,
      student_id: studentId,
      date,
      status: 'present',
      notes: state.records.get(studentId)?.notes ?? null,
    }));

    const { data, error } = await supabase
      .from('attendance_records')
      .upsert(payload, { onConflict: 'student_id,date' })
      .select('id, student_id, status, notes');
    if (error) throw error;

    (data || []).forEach((r) => state.records.set(r.student_id, { id: r.id, status: r.status, notes: r.notes }));

    rows.forEach((row) => {
      const studentId = row.getAttribute('data-row');
      reflectRowState(row, state.records.get(studentId));
    });
    updateSummary(body, rows.length, state);

    showToast('Everyone marked present.', 'success');
    endSync(state, syncIndicator, null);
  } catch (err) {
    showToast(err.message || 'Could not mark everyone present.', 'error');
    endSync(state, syncIndicator, err.message || 'Could not save. Check your connection.');
  }
}

function beginSync(state, syncIndicator) {
  state.inFlight += 1;
  if (syncIndicator) {
    syncIndicator.textContent = 'Saving\u2026';
    syncIndicator.classList.remove('sync-indicator--error');
  }
}

function endSync(state, syncIndicator, errorMessage) {
  state.inFlight = Math.max(0, state.inFlight - 1);
  if (!syncIndicator) return;
  if (errorMessage) {
    syncIndicator.textContent = errorMessage;
    syncIndicator.classList.add('sync-indicator--error');
    return;
  }
  if (state.inFlight === 0) {
    syncIndicator.textContent = 'All changes saved';
    syncIndicator.classList.remove('sync-indicator--error');
    clearTimeout(syncIndicator._fadeTimer);
    syncIndicator._fadeTimer = setTimeout(() => {
      if (syncIndicator.textContent === 'All changes saved') syncIndicator.textContent = '';
    }, 1800);
  }
}

// ---------------------------------------------------------------------------
// Notes modal
// ---------------------------------------------------------------------------

function openNoteModal(student, state, sectionId, date, row, syncIndicator, body, totalStudents) {
  const record = state.records.get(student.id);

  const overlay = openModal({
    title: `Note for ${student.name}`,
    bodyHtml: `
      <form id="note-form">
        <div class="field">
          <label for="note-text">Note <span style="font-weight:400;color:var(--color-muted);">(optional)</span></label>
          <textarea id="note-text" rows="3" maxlength="300" placeholder="e.g. Called in sick, doctor's appointment…">${escapeHtml(record?.notes || '')}</textarea>
        </div>
        <button type="submit" class="btn btn-primary" id="note-save-btn">Save note</button>
      </form>
    `,
  });

  const textarea = overlay.querySelector('#note-text');
  textarea.focus();

  overlay.querySelector('#note-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const notes = textarea.value.trim() || null;
    closeModal();
    saveRecord(student.id, sectionId, date, { notes }, state, row, syncIndicator, () => {
      updateSummary(body, totalStudents, state);
    });
  });
}

// ---------------------------------------------------------------------------
// Date helpers (local time — never UTC, so late-night entries land on the
// correct calendar day for the teacher's own timezone)
// ---------------------------------------------------------------------------

function todayStr() {
  return formatDateLocal(new Date());
}

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDaysStr(str, delta) {
  const d = parseDateLocal(str);
  d.setDate(d.getDate() + delta);
  return formatDateLocal(d);
}

function isValidDateStr(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(parseDateLocal(str).getTime());
}

function formatDateDisplay(str) {
  return parseDateLocal(str).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Shared helpers (photo signing, text)
// ---------------------------------------------------------------------------

async function getSignedUrls(paths) {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrls(paths, SIGNED_URL_TTL);
  if (error) {
    console.error('createSignedUrls error:', error);
    return {};
  }
  const map = {};
  (data || []).forEach((item) => {
    if (item.signedUrl) map[item.path] = item.signedUrl;
  });
  return map;
}

function getInitials(name) {
  const cleaned = (name || '').trim();
  if (!cleaned) return '?';
  return cleaned
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
