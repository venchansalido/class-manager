// js/history.js
//
// History — two calendar-based ways to look back at attendance:
//
//   "Section calendar" — a month grid for the whole section. Each day cell
//   surfaces the number of absences/lates that day (or "All present" / not
//   yet taken). Clicking a day opens a roster modal for that date where you
//   can review and correct any student's status inline.
//
//   "Student calendar" — pick one student and see their whole month colored
//   day-by-day (present/absent/late/excused). Clicking a day opens a small
//   editor for just that student/date.
//
// URL-driven state: #/history?section=<id>&month=<yyyy-mm>&view=section|student&student=<id>
// so switching section/month/view is a cheap, linkable re-render — consistent
// with how Attendance already works.

import { supabase, STORAGE_BUCKET } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const STATUS_LIST = [
  { key: 'present', label: 'Present', short: 'P' },
  { key: 'absent',  label: 'Absent',  short: 'A' },
  { key: 'late',    label: 'Late',    short: 'L' },
  { key: 'excused', label: 'Excused', short: 'E' },
];
const STATUS_MAP = Object.fromEntries(STATUS_LIST.map((s) => [s.key, s]));
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SIGNED_URL_TTL = 3600;

export async function renderHistory(mount, params) {
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
        <p>Add a section and a few students before viewing attendance history.</p>
        <button class="btn btn-primary" id="go-to-sections-btn" style="width:auto;margin-top:14px;">Go to Sections</button>
      </div>
    `;
    mount.querySelector('#go-to-sections-btn').addEventListener('click', () => navigate('sections'));
    return;
  }

  const sectionId = sections.some((s) => s.id === params?.section) ? params.section : sections[0].id;
  const month = isValidMonthStr(params?.month) ? params.month : currentMonthStr();
  const view = params?.view === 'student' ? 'student' : 'section';

  const { data: students, error: studentsError } = await supabase
    .from('students')
    .select('id, name, photo_url')
    .eq('section_id', sectionId)
    .order('name', { ascending: true });

  if (studentsError) {
    mount.innerHTML = `<div class="empty-state"><h3>Couldn't load students</h3><p>${escapeHtml(studentsError.message)}</p></div>`;
    return;
  }

  const studentId = view === 'student'
    ? ((students || []).some((s) => s.id === params?.student) ? params.student : (students || [])[0]?.id ?? null)
    : null;

  const needsRedirect =
    sectionId !== params?.section ||
    month !== params?.month ||
    (view === 'student' && studentId && studentId !== params?.student);

  if (needsRedirect) {
    navigate(buildUrl({ section: sectionId, month, view, student: studentId }), true);
    return;
  }

  mount.innerHTML = `
    <div class="view-header">
      <div>
        <h2>History</h2>
        <p class="view-header__sub">${formatMonthDisplay(month)}</p>
      </div>
    </div>

    <div class="attendance-toolbar">
      <div class="field attendance-toolbar__field">
        <label for="history-section-select">Section</label>
        <select id="history-section-select">
          ${sections.map((s) => `<option value="${s.id}" ${s.id === sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>

      <div class="field attendance-toolbar__field">
        <label>Month</label>
        <div class="date-nav">
          <button type="button" class="icon-btn" id="month-prev" aria-label="Previous month">&#8249;</button>
          <span class="month-nav-label">${formatMonthDisplay(month)}</span>
          <button type="button" class="icon-btn" id="month-next" aria-label="Next month">&#8250;</button>
        </div>
      </div>

      <button class="btn btn-ghost" id="month-today-btn" style="width:auto;">This month</button>

      <div class="view-toggle">
        <button type="button" class="view-toggle__btn${view === 'section' ? ' view-toggle__btn--active' : ''}" data-view="section">Section calendar</button>
        <button type="button" class="view-toggle__btn${view === 'student' ? ' view-toggle__btn--active' : ''}" data-view="student">Student calendar</button>
      </div>

      ${view === 'student' ? `
        <div class="field attendance-toolbar__field">
          <label for="history-student-select">Student</label>
          <select id="history-student-select" ${!students || students.length === 0 ? 'disabled' : ''}>
            ${(students || []).map((s) => `<option value="${s.id}" ${s.id === studentId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
          </select>
        </div>
      ` : ''}
    </div>

    <div id="history-body" class="history-body">
      <div class="empty-state"><p>Loading…</p></div>
    </div>
  `;

  mount.querySelector('#history-section-select').addEventListener('change', (e) => {
    navigate(buildUrl({ section: e.target.value, month, view: 'section', student: null }));
  });
  mount.querySelector('#month-prev').addEventListener('click', () => {
    navigate(buildUrl({ section: sectionId, month: addMonths(month, -1), view, student: studentId }));
  });
  mount.querySelector('#month-next').addEventListener('click', () => {
    navigate(buildUrl({ section: sectionId, month: addMonths(month, 1), view, student: studentId }));
  });
  mount.querySelector('#month-today-btn').addEventListener('click', () => {
    navigate(buildUrl({ section: sectionId, month: currentMonthStr(), view, student: studentId }));
  });
  mount.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const newView = btn.getAttribute('data-view');
      if (newView === view) return;
      navigate(buildUrl({ section: sectionId, month, view: newView, student: newView === 'student' ? (studentId || (students || [])[0]?.id) : null }));
    });
  });
  mount.querySelector('#history-student-select')?.addEventListener('change', (e) => {
    navigate(buildUrl({ section: sectionId, month, view: 'student', student: e.target.value }));
  });

  const body = mount.querySelector('#history-body');

  if (view === 'section') {
    await renderSectionCalendar(body, sectionId, month, students || []);
  } else if (!studentId) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students in this section yet</h3>
        <p>Add students to see their attendance calendar.</p>
        <button class="btn btn-primary" id="go-add-students-btn" style="width:auto;margin-top:14px;">Add students</button>
      </div>
    `;
    body.querySelector('#go-add-students-btn').addEventListener('click', () => navigate(`students?section=${sectionId}`));
  } else {
    const student = (students || []).find((s) => s.id === studentId);
    await renderStudentCalendar(body, sectionId, student, month);
  }
}

function buildUrl({ section, month, view, student }) {
  let url = `history?section=${section}&month=${month}&view=${view}`;
  if (view === 'student' && student) url += `&student=${student}`;
  return url;
}

// ---------------------------------------------------------------------------
// Section calendar
// ---------------------------------------------------------------------------

async function renderSectionCalendar(body, sectionId, month, students) {
  if (students.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students in this section yet</h3>
        <p>Add students to start tracking their attendance.</p>
      </div>
    `;
    return;
  }

  body.innerHTML = `<div class="empty-state"><p>Loading calendar…</p></div>`;

  const { year, monthIndex } = parseMonthStr(month);
  const startStr = formatDateLocal(new Date(year, monthIndex, 1));
  const endStr = formatDateLocal(new Date(year, monthIndex + 1, 0));
  const studentIds = students.map((s) => s.id);

  const { data: records, error } = await supabase
    .from('attendance_records')
    .select('date, status')
    .in('student_id', studentIds)
    .gte('date', startStr)
    .lte('date', endStr);

  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load calendar</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const byDate = {};
  (records || []).forEach((r) => {
    if (!byDate[r.date]) byDate[r.date] = { present: 0, absent: 0, late: 0, excused: 0, total: 0 };
    byDate[r.date][r.status] += 1;
    byDate[r.date].total += 1;
  });

  const weeks = buildMonthGrid(year, monthIndex);

  body.innerHTML = `
    <div class="calendar">
      <div class="calendar__weekdays">${WEEKDAY_LABELS.map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="calendar__grid">
        ${weeks.map((week) => week.map((date) => sectionCellHtml(date, byDate, students.length)).join('')).join('')}
      </div>
    </div>
    <div class="calendar-legend">
      <span><i class="legend-dot legend-dot--absent"></i> Has absences</span>
      <span><i class="legend-dot legend-dot--late"></i> Has late (no absences)</span>
      <span><i class="legend-dot legend-dot--ok"></i> All present</span>
      <span><i class="legend-dot legend-dot--none"></i> Not yet taken</span>
    </div>
  `;

  body.querySelectorAll('[data-cell-date]').forEach((cell) => {
    cell.addEventListener('click', () => openDayDetail(cell.getAttribute('data-cell-date'), sectionId, students, month));
  });
}

function sectionCellHtml(date, byDate, totalStudents) {
  if (!date) return `<div class="calendar-cell calendar-cell--empty"></div>`;

  const dateStr = formatDateLocal(date);
  const stats = byDate[dateStr];
  const isToday = dateStr === todayStr();
  const isFuture = dateStr > todayStr();

  let statusClass = 'calendar-cell--none';
  let badge = '';
  if (stats && stats.total > 0) {
    if (stats.absent > 0) {
      statusClass = 'calendar-cell--absent';
      badge = `<span class="calendar-cell__badge calendar-cell__badge--absent">${stats.absent} absent</span>`;
    } else if (stats.late > 0) {
      statusClass = 'calendar-cell--late';
      badge = `<span class="calendar-cell__badge calendar-cell__badge--late">${stats.late} late</span>`;
    } else {
      statusClass = 'calendar-cell--ok';
      badge = `<span class="calendar-cell__badge calendar-cell__badge--ok">All present</span>`;
    }
  }

  return `
    <button type="button" class="calendar-cell ${statusClass}${isToday ? ' calendar-cell--today' : ''}"
      data-cell-date="${dateStr}" ${isFuture ? 'disabled' : ''}>
      <span class="calendar-cell__date">${date.getDate()}</span>
      ${badge}
      ${stats && stats.total > 0 ? `<span class="calendar-cell__count">${stats.total}/${totalStudents} marked</span>` : ''}
    </button>
  `;
}

async function openDayDetail(dateStr, sectionId, students, month) {
  const overlay = openModal({
    title: formatDateDisplay(dateStr),
    bodyHtml: `<div id="day-detail-list"><div class="empty-state"><p>Loading…</p></div></div>`,
  });
  const listEl = overlay.querySelector('#day-detail-list');

  const studentIds = students.map((s) => s.id);
  const { data: records, error } = await supabase
    .from('attendance_records')
    .select('id, student_id, status, notes')
    .eq('date', dateStr)
    .in('student_id', studentIds);

  if (error) {
    listEl.innerHTML = `<p class="field-error">${escapeHtml(error.message)}</p>`;
    return;
  }

  const recordMap = new Map((records || []).map((r) => [r.student_id, { id: r.id, status: r.status, notes: r.notes }]));

  listEl.innerHTML = `
    <div class="day-detail-list">
      ${students.map((s) => dayDetailRowHtml(s, recordMap.get(s.id))).join('')}
    </div>
  `;

  students.forEach((student) => {
    const row = listEl.querySelector(`[data-day-row="${student.id}"]`);
    if (!row) return;

    row.querySelectorAll('[data-status]').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveQuickRecord(student.id, dateStr, { status: btn.getAttribute('data-status') }, recordMap, row);
      });
    });

    row.querySelector('[data-view-student]')?.addEventListener('click', () => {
      closeModal();
      navigate(buildUrl({ section: sectionId, month, view: 'student', student: student.id }));
    });
  });
}

function dayDetailRowHtml(student, record) {
  return `
    <div class="attendance-row" data-day-row="${student.id}">
      <div class="attendance-row__student">
        <span class="attendance-row__name">${escapeHtml(student.name)}</span>
      </div>
      <div class="attendance-row__controls">
        <div class="status-btn-group" role="group" aria-label="Status for ${escapeHtml(student.name)}">
          ${STATUS_LIST.map((s) => `
            <button type="button" class="status-btn status-btn--${s.key}${record?.status === s.key ? ' status-btn--active' : ''}"
              data-status="${s.key}" aria-label="${s.label}" title="${s.label}">${s.short}</button>
          `).join('')}
        </div>
        <button type="button" class="icon-btn" data-view-student title="View ${escapeHtml(student.name)}'s calendar" aria-label="View calendar">&#128197;</button>
      </div>
    </div>
  `;
}

async function saveQuickRecord(studentId, dateStr, changes, recordMap, row) {
  const previous = recordMap.get(studentId);
  const next = { status: previous?.status ?? 'present', notes: previous?.notes ?? null, ...changes };

  recordMap.set(studentId, { ...previous, ...next });
  row.querySelectorAll('[data-status]').forEach((btn) => {
    btn.classList.toggle('status-btn--active', btn.getAttribute('data-status') === next.status);
  });

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;

    const { data, error } = await supabase
      .from('attendance_records')
      .upsert(
        { user_id: userData.user.id, student_id: studentId, date: dateStr, status: next.status, notes: next.notes },
        { onConflict: 'student_id,date' }
      )
      .select('id, status, notes')
      .single();
    if (error) throw error;

    recordMap.set(studentId, { id: data.id, status: data.status, notes: data.notes });
  } catch (err) {
    if (previous) recordMap.set(studentId, previous);
    else recordMap.delete(studentId);
    row.querySelectorAll('[data-status]').forEach((btn) => {
      btn.classList.toggle('status-btn--active', btn.getAttribute('data-status') === previous?.status);
    });
    showToast(err.message || 'Could not save. Check your connection.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Student calendar
// ---------------------------------------------------------------------------

async function renderStudentCalendar(body, sectionId, student, month) {
  if (!student) {
    body.innerHTML = `<div class="empty-state"><h3>Student not found</h3></div>`;
    return;
  }

  body.innerHTML = `<div class="empty-state"><p>Loading calendar…</p></div>`;

  const { year, monthIndex } = parseMonthStr(month);
  const startStr = formatDateLocal(new Date(year, monthIndex, 1));
  const endStr = formatDateLocal(new Date(year, monthIndex + 1, 0));

  const { data: records, error } = await supabase
    .from('attendance_records')
    .select('id, date, status, notes')
    .eq('student_id', student.id)
    .gte('date', startStr)
    .lte('date', endStr);

  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load calendar</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const byDate = {};
  (records || []).forEach((r) => { byDate[r.date] = { id: r.id, status: r.status, notes: r.notes }; });

  const signedUrlMap = student.photo_url ? await getSignedUrls([student.photo_url]) : {};
  const photoUrl = signedUrlMap[student.photo_url];

  const counts = { present: 0, absent: 0, late: 0, excused: 0 };
  Object.values(byDate).forEach((r) => { counts[r.status] += 1; });
  const markedTotal = Object.values(counts).reduce((a, b) => a + b, 0);

  const weeks = buildMonthGrid(year, monthIndex);

  body.innerHTML = `
    <div class="student-calendar-header">
      <div class="avatar student-calendar-header__avatar${photoUrl ? '' : ' avatar--placeholder'}">
        ${photoUrl ? `<img src="${photoUrl}" alt="" />` : `<span>${escapeHtml(getInitials(student.name))}</span>`}
      </div>
      <div>
        <h3 style="margin:0;">${escapeHtml(student.name)}</h3>
        <p class="view-header__sub" style="margin:2px 0 0;">${markedTotal} ${markedTotal === 1 ? 'day' : 'days'} marked this month</p>
      </div>
    </div>

    <div class="calendar">
      <div class="calendar__weekdays">${WEEKDAY_LABELS.map((d) => `<div>${d}</div>`).join('')}</div>
      <div class="calendar__grid">
        ${weeks.map((week) => week.map((date) => studentCellHtml(date, byDate)).join('')).join('')}
      </div>
    </div>

    <div class="calendar-legend">
      <span><i class="legend-dot legend-dot--present-solid"></i> Present (${counts.present})</span>
      <span><i class="legend-dot legend-dot--absent-solid"></i> Absent (${counts.absent})</span>
      <span><i class="legend-dot legend-dot--late-solid"></i> Late (${counts.late})</span>
      <span><i class="legend-dot legend-dot--excused-solid"></i> Excused (${counts.excused})</span>
    </div>
  `;

  body.querySelectorAll('[data-cell-date]').forEach((cell) => {
    cell.addEventListener('click', () => {
      openStudentDayEdit(cell.getAttribute('data-cell-date'), sectionId, student, month, byDate, body);
    });
  });
}

function studentCellHtml(date, byDate) {
  if (!date) return `<div class="calendar-cell calendar-cell--empty"></div>`;

  const dateStr = formatDateLocal(date);
  const record = byDate[dateStr];
  const isToday = dateStr === todayStr();
  const isFuture = dateStr > todayStr();
  const statusClass = record ? `calendar-cell--student-${record.status}` : 'calendar-cell--none';

  return `
    <button type="button" class="calendar-cell ${statusClass}${isToday ? ' calendar-cell--today' : ''}"
      data-cell-date="${dateStr}" ${isFuture ? 'disabled' : ''}>
      <span class="calendar-cell__date">${date.getDate()}</span>
      ${record ? `<span class="calendar-cell__letter">${STATUS_MAP[record.status].short}</span>` : ''}
      ${record?.notes ? `<span class="calendar-cell__note-dot" title="Has a note"></span>` : ''}
    </button>
  `;
}

function openStudentDayEdit(dateStr, sectionId, student, month, byDate, body) {
  const record = byDate[dateStr];

  const overlay = openModal({
    title: `${student.name} — ${formatDateDisplay(dateStr)}`,
    bodyHtml: `
      <div class="status-btn-group" role="group" aria-label="Attendance status" style="margin-bottom:16px;">
        ${STATUS_LIST.map((s) => `
          <button type="button" class="status-btn status-btn--${s.key}${record?.status === s.key ? ' status-btn--active' : ''}"
            data-status="${s.key}" aria-label="${s.label}" title="${s.label}">${s.short}</button>
        `).join('')}
      </div>
      <div class="field">
        <label for="student-day-note">Note <span style="font-weight:400;color:var(--color-muted);">(optional)</span></label>
        <textarea id="student-day-note" rows="3" maxlength="300" placeholder="e.g. Called in sick…">${escapeHtml(record?.notes || '')}</textarea>
      </div>
      <button type="button" class="btn btn-primary" id="student-day-save-btn">Save</button>
    `,
  });

  let pendingStatus = record?.status ?? null;
  overlay.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingStatus = btn.getAttribute('data-status');
      overlay.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('status-btn--active', b === btn));
    });
  });

  overlay.querySelector('#student-day-save-btn').addEventListener('click', async () => {
    const notes = overlay.querySelector('#student-day-note').value.trim() || null;
    const status = pendingStatus ?? 'present';
    const btn = overlay.querySelector('#student-day-save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;

      const { error } = await supabase
        .from('attendance_records')
        .upsert(
          { user_id: userData.user.id, student_id: student.id, date: dateStr, status, notes },
          { onConflict: 'student_id,date' }
        );
      if (error) throw error;

      showToast('Saved.', 'success');
      closeModal();
      await renderStudentCalendar(body, sectionId, student, month);
    } catch (err) {
      showToast(err.message || 'Could not save.', 'error');
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });
}

// ---------------------------------------------------------------------------
// Calendar/date helpers (local time, never UTC)
// ---------------------------------------------------------------------------

function buildMonthGrid(year, monthIndex) {
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();

  const cells = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, monthIndex, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function isValidMonthStr(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}$/.test(str);
}

function parseMonthStr(str) {
  const [year, m] = str.split('-').map(Number);
  return { year, monthIndex: m - 1 };
}

function addMonths(str, delta) {
  const { year, monthIndex } = parseMonthStr(str);
  const d = new Date(year, monthIndex + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function formatMonthDisplay(str) {
  const { year, monthIndex } = parseMonthStr(str);
  return new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function formatDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateLocal(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDateDisplay(str) {
  return parseDateLocal(str).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function todayStr() {
  return formatDateLocal(new Date());
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
  return cleaned.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
