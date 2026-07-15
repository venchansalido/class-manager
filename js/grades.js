// js/grades.js
//
// Grades module. URL-driven state (#/grades?section=<id>&assessment=<id>):
//   - section only  -> assessments list for that section (add/edit/delete)
//   - + assessment  -> score sheet for that assessment (full roster, one
//                      numeric input per student, validated against that
//                      assessment's max_score, auto-saved on blur/change
//                      via upsert — same pattern as attendance.js).
//
// Deleting an assessment cascades to its scores (schema.sql: scores
// references assessments(id) on delete cascade).

import { supabase, STORAGE_BUCKET } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';
import { exportGradebookExcel } from './export.js';

const CATEGORIES = [
  { key: 'quiz',      label: 'Quiz' },
  { key: 'exam',      label: 'Exam' },
  { key: 'summative', label: 'Summative' },
  { key: 'activity',  label: 'Activity' },
  { key: 'other',     label: 'Other' },
];

const SIGNED_URL_TTL = 3600;

export async function renderGrades(mount, params) {
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
        <p>Add a section and a few students before recording grades.</p>
        <button class="btn btn-primary" id="go-to-sections-btn" style="width:auto;margin-top:14px;">Go to Sections</button>
      </div>
    `;
    mount.querySelector('#go-to-sections-btn').addEventListener('click', () => navigate('sections'));
    return;
  }

  const sectionId = sections.some((s) => s.id === params?.section) ? params.section : sections[0].id;

  if (sectionId !== params?.section) {
    navigate(`grades?section=${sectionId}`, true);
    return;
  }

  if (params?.assessment) {
    return renderScoreSheet(mount, sections, sectionId, params.assessment);
  }
  if (params?.view === 'summary') {
    return renderSummary(mount, sections, sectionId);
  }
  return renderAssessmentsList(mount, sections, sectionId);
}

// ---------------------------------------------------------------------------
// Assessments / Summary tabs (shared header control)
// ---------------------------------------------------------------------------

function gradesTabsHtml(activeTab) {
  return `
    <div class="grades-tabs" role="tablist">
      <button class="grades-tab" data-grades-tab="assessments" role="tab" aria-selected="${activeTab === 'assessments'}">Assessments</button>
      <button class="grades-tab" data-grades-tab="summary" role="tab" aria-selected="${activeTab === 'summary'}">Summary</button>
    </div>
  `;
}

function wireGradesTabs(mount, sectionId) {
  mount.querySelectorAll('[data-grades-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-grades-tab');
      navigate(tab === 'summary' ? `grades?section=${sectionId}&view=summary` : `grades?section=${sectionId}`);
    });
  });
}

// ---------------------------------------------------------------------------
// Assessments list
// ---------------------------------------------------------------------------

async function renderAssessmentsList(mount, sections, sectionId) {
  mount.innerHTML = `
    <div class="view-header">
      <div>
        <h2>Grades</h2>
        <p class="view-header__sub">Assessments for this section. Click one to open its score sheet.</p>
      </div>
    </div>

    ${gradesTabsHtml('assessments')}

    <div class="attendance-toolbar">
      <div class="field attendance-toolbar__field">
        <label for="grades-section-select">Section</label>
        <select id="grades-section-select">
          ${sections.map((s) => `<option value="${s.id}" ${s.id === sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-ghost" id="edit-weights-btn" style="width:auto;">&#9878; Weights</button>
      <button class="btn btn-ghost" id="export-gradebook-btn" style="width:auto;">&#8681; Export .xlsx</button>
      <button class="btn btn-primary" id="add-assessment-btn" style="width:auto;">+ Add assessment</button>
    </div>

    <div id="assessments-body" class="assessments-body">
      <div class="empty-state"><p>Loading assessments…</p></div>
    </div>
  `;

  wireGradesTabs(mount, sectionId);
  mount.querySelector('#grades-section-select').addEventListener('change', (e) => {
    navigate(`grades?section=${e.target.value}`);
  });
  mount.querySelector('#add-assessment-btn').addEventListener('click', () => openAssessmentForm(mount, sectionId));
  mount.querySelector('#edit-weights-btn').addEventListener('click', () => openWeightsForm(mount, sectionId));
  mount.querySelector('#export-gradebook-btn').addEventListener('click', (e) => {
    const sectionName = sections.find((s) => s.id === sectionId)?.name || '';
    exportGradebookExcel(sectionId, sectionName, e.currentTarget);
  });

  await loadAndRenderAssessments(mount, sectionId);
}

async function loadAndRenderAssessments(mount, sectionId) {
  const body = mount.querySelector('#assessments-body');

  const [{ data: assessments, error }, { count: studentCount }] = await Promise.all([
    supabase
      .from('assessments')
      .select('id, title, category, max_score, date, scores(count)')
      .eq('section_id', sectionId)
      .order('date', { ascending: false }),
    supabase
      .from('students')
      .select('id', { count: 'exact', head: true })
      .eq('section_id', sectionId),
  ]);

  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load assessments</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  if (!assessments || assessments.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No assessments yet</h3>
        <p>Add a quiz, exam, or activity to start recording scores for this section.</p>
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div class="assessment-list">
      ${assessments.map((a) => assessmentRowHtml(a, studentCount ?? 0)).join('')}
    </div>
  `;

  body.querySelectorAll('[data-open-assessment]').forEach((row) => {
    row.addEventListener('click', () => {
      navigate(`grades?section=${sectionId}&assessment=${row.getAttribute('data-open-assessment')}`);
    });
  });

  body.querySelectorAll('[data-edit-assessment]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = assessments.find((x) => x.id === btn.getAttribute('data-edit-assessment'));
      openAssessmentForm(mount, sectionId, a);
    });
  });

  body.querySelectorAll('[data-delete-assessment]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = assessments.find((x) => x.id === btn.getAttribute('data-delete-assessment'));
      confirmDeleteAssessment(mount, sectionId, a);
    });
  });
}

function assessmentRowHtml(a, studentCount) {
  const scoredCount = a.scores?.[0]?.count ?? 0;
  const catMeta = CATEGORIES.find((c) => c.key === a.category) || CATEGORIES[CATEGORIES.length - 1];

  return `
    <div class="assessment-row" data-open-assessment="${a.id}">
      <div class="assessment-row__main">
        <span class="assessment-row__title">${escapeHtml(a.title)}</span>
        <div class="assessment-row__meta">
          <span class="category-badge category-badge--${catMeta.key}">${catMeta.label}</span>
          <span>${formatDateDisplay(a.date)}</span>
          <span>&middot; out of ${formatNumber(a.max_score)}</span>
          <span>&middot; ${scoredCount} of ${studentCount} scored</span>
        </div>
      </div>
      <div class="assessment-row__actions">
        <button class="icon-btn" data-edit-assessment="${a.id}" aria-label="Edit ${escapeHtml(a.title)}">&#9998;</button>
        <button class="icon-btn icon-btn--danger" data-delete-assessment="${a.id}" aria-label="Delete ${escapeHtml(a.title)}">&#128465;</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Add / edit assessment modal
// ---------------------------------------------------------------------------

function openAssessmentForm(mount, sectionId, existingAssessment, onSaved) {
  const isEdit = !!existingAssessment;
  const handleSaved = onSaved || (() => loadAndRenderAssessments(mount, sectionId));

  const overlay = openModal({
    title: isEdit ? 'Edit assessment' : 'Add assessment',
    bodyHtml: `
      <form id="assessment-form">
        <div class="field">
          <label for="assessment-title">Title</label>
          <input type="text" id="assessment-title" name="title" placeholder="e.g. Chapter 3 Quiz" required maxlength="120" value="${isEdit ? escapeHtml(existingAssessment.title) : ''}" />
          <div class="field-error" id="assessment-title-error"></div>
        </div>

        <div class="field">
          <label for="assessment-category">Category</label>
          <select id="assessment-category">
            ${CATEGORIES.map((c) => `<option value="${c.key}" ${isEdit && existingAssessment.category === c.key ? 'selected' : ''}>${c.label}</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label for="assessment-max-score">Max score</label>
          <input type="number" id="assessment-max-score" name="max_score" min="0.01" step="any" required value="${isEdit ? formatNumber(existingAssessment.max_score) : '100'}" />
          <div class="field-error" id="assessment-max-score-error"></div>
        </div>

        <div class="field">
          <label for="assessment-date">Date</label>
          <input type="date" id="assessment-date" name="date" required value="${isEdit ? existingAssessment.date : todayStr()}" />
          <div class="field-error" id="assessment-date-error"></div>
        </div>

        <button type="submit" class="btn btn-primary" id="assessment-submit-btn">
          ${isEdit ? 'Save changes' : 'Add assessment'}
        </button>
      </form>
    `,
  });

  const form = overlay.querySelector('#assessment-form');
  const titleInput = overlay.querySelector('#assessment-title');
  const categorySelect = overlay.querySelector('#assessment-category');
  const maxScoreInput = overlay.querySelector('#assessment-max-score');
  const dateInput = overlay.querySelector('#assessment-date');
  titleInput.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const title = titleInput.value.trim();
    const maxScore = parseFloat(maxScoreInput.value);
    const date = dateInput.value;

    const titleError = overlay.querySelector('#assessment-title-error');
    const maxScoreError = overlay.querySelector('#assessment-max-score-error');
    const dateError = overlay.querySelector('#assessment-date-error');
    titleError.textContent = '';
    maxScoreError.textContent = '';
    dateError.textContent = '';

    let hasError = false;
    if (!title) { titleError.textContent = 'Title is required.'; hasError = true; }
    if (!Number.isFinite(maxScore) || maxScore <= 0) { maxScoreError.textContent = 'Enter a max score greater than 0.'; hasError = true; }
    if (!isValidDateStr(date)) { dateError.textContent = 'Enter a valid date.'; hasError = true; }
    if (hasError) return;

    const submitBtn = overlay.querySelector('#assessment-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const payload = { title, category: categorySelect.value, max_score: maxScore, date };

      if (isEdit) {
        const { error } = await supabase.from('assessments').update(payload).eq('id', existingAssessment.id);
        if (error) throw error;
        showToast('Assessment updated.', 'success');
      } else {
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        const { error } = await supabase
          .from('assessments')
          .insert({ ...payload, section_id: sectionId, user_id: userData.user.id });
        if (error) throw error;
        showToast('Assessment added.', 'success');
      }
      closeModal();
      await handleSaved();
    } catch (err) {
      titleError.textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Save changes' : 'Add assessment';
    }
  });
}

function confirmDeleteAssessment(mount, sectionId, assessment, onDeleted) {
  const handleDeleted = onDeleted || (() => loadAndRenderAssessments(mount, sectionId));

  const overlay = openModal({
    title: 'Delete assessment?',
    bodyHtml: `
      <p style="margin-bottom:20px;color:var(--color-muted);">
        This permanently deletes <strong>${escapeHtml(assessment.title)}</strong> and every score
        recorded for it. This can't be undone.
      </p>
      <div style="display:flex;gap:10px;">
        <button class="btn btn-ghost" id="cancel-delete-btn" style="flex:1;">Cancel</button>
        <button class="btn btn-primary" id="confirm-delete-btn" style="flex:1;background:var(--status-absent);">Delete</button>
      </div>
    `,
  });

  overlay.querySelector('#cancel-delete-btn').addEventListener('click', closeModal);
  overlay.querySelector('#confirm-delete-btn').addEventListener('click', async () => {
    const btn = overlay.querySelector('#confirm-delete-btn');
    btn.disabled = true;
    btn.textContent = 'Deleting…';
    try {
      const { error } = await supabase.from('assessments').delete().eq('id', assessment.id);
      if (error) throw error;
      showToast('Assessment deleted.', 'success');
      closeModal();
      await handleDeleted();
    } catch (err) {
      showToast(err.message || 'Could not delete assessment.', 'error');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

// ---------------------------------------------------------------------------
// Grade weights (per-section, per-category)
// ---------------------------------------------------------------------------

const WEIGHT_TOTAL_TOLERANCE = 0.01;

async function openWeightsForm(mount, sectionId, onSaved) {
  const triggerBtn = mount.querySelector('#edit-weights-btn');
  const originalLabel = triggerBtn ? triggerBtn.innerHTML : '';
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = 'Loading…';
  }

  const { data: rows, error } = await supabase
    .from('category_weights')
    .select('category, weight')
    .eq('section_id', sectionId);

  if (triggerBtn) {
    triggerBtn.disabled = false;
    triggerBtn.innerHTML = originalLabel;
  }

  if (error) {
    showToast(error.message || 'Could not load weights.', 'error');
    return;
  }

  const existing = {};
  (rows || []).forEach((r) => { existing[r.category] = r.weight; });
  const defaultWeight = parseFloat((100 / CATEGORIES.length).toFixed(2));
  const hasExisting = (rows || []).length > 0;

  const overlay = openModal({
    title: 'Grade weights',
    bodyHtml: `
      <form id="weights-form">
        <p class="field-helper" style="margin-bottom:16px;">
          How much each category counts toward a student's final grade for this section.
          Must add up to 100%.${hasExisting ? '' : ' Starting with an even split — adjust as needed.'}
        </p>
        ${CATEGORIES.map((c) => `
          <div class="field weight-field">
            <label for="weight-${c.key}">${c.label}</label>
            <div class="weight-input-group">
              <input type="number" id="weight-${c.key}" data-weight-input="${c.key}" min="0" max="100" step="any"
                value="${formatNumber(existing[c.key] != null ? existing[c.key] : defaultWeight)}" required />
              <span class="weight-input-suffix">%</span>
            </div>
          </div>
        `).join('')}
        <div class="weights-total" id="weights-total">
          Total: <span id="weights-total-value">100</span>%
        </div>
        <div class="field-error" id="weights-total-error"></div>
        <button type="submit" class="btn btn-primary" id="weights-submit-btn">Save weights</button>
      </form>
    `,
  });

  const form = overlay.querySelector('#weights-form');
  const totalError = overlay.querySelector('#weights-total-error');
  const totalEl = overlay.querySelector('#weights-total');
  const totalValueEl = overlay.querySelector('#weights-total-value');
  const inputs = CATEGORIES.map((c) => overlay.querySelector(`[data-weight-input="${c.key}"]`));

  function refreshTotal() {
    const total = inputs.reduce((sum, inp) => sum + (parseFloat(inp.value) || 0), 0);
    totalValueEl.textContent = formatNumber(total);
    const isValid = Math.abs(total - 100) <= WEIGHT_TOTAL_TOLERANCE;
    totalEl.classList.toggle('weights-total--ok', isValid);
    totalEl.classList.toggle('weights-total--off', !isValid);
  }

  inputs.forEach((inp) => {
    inp.addEventListener('input', () => {
      inp.classList.remove('score-input--invalid');
      totalError.textContent = '';
      refreshTotal();
    });
  });
  refreshTotal();
  inputs[0].focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    totalError.textContent = '';
    inputs.forEach((inp) => inp.classList.remove('score-input--invalid'));

    const values = inputs.map((inp) => parseFloat(inp.value));
    let hasError = false;
    values.forEach((v, i) => {
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        inputs[i].classList.add('score-input--invalid');
        hasError = true;
      }
    });
    if (hasError) {
      totalError.textContent = 'Enter a value between 0 and 100 for each category.';
      return;
    }

    const total = values.reduce((sum, v) => sum + v, 0);
    if (Math.abs(total - 100) > WEIGHT_TOTAL_TOLERANCE) {
      totalError.textContent = `Weights must add up to 100% (currently ${formatNumber(total)}%).`;
      return;
    }

    const submitBtn = overlay.querySelector('#weights-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;

      const payload = CATEGORIES.map((c, i) => ({
        user_id: userData.user.id,
        section_id: sectionId,
        category: c.key,
        weight: values[i],
      }));

      const { error: saveError } = await supabase
        .from('category_weights')
        .upsert(payload, { onConflict: 'section_id,category' });
      if (saveError) throw saveError;

      showToast('Weights saved.', 'success');
      closeModal();
      if (typeof onSaved === 'function') await onSaved();
    } catch (err) {
      totalError.textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save weights';
    }
  });
}

// ---------------------------------------------------------------------------
// Summary (weighted averages)
// ---------------------------------------------------------------------------

async function renderSummary(mount, sections, sectionId) {
  mount.innerHTML = `
    <div class="view-header">
      <div>
        <h2>Grades</h2>
        <p class="view-header__sub">Weighted running average per student for this section.</p>
      </div>
    </div>

    ${gradesTabsHtml('summary')}

    <div class="attendance-toolbar">
      <div class="field attendance-toolbar__field">
        <label for="grades-section-select">Section</label>
        <select id="grades-section-select">
          ${sections.map((s) => `<option value="${s.id}" ${s.id === sectionId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn-ghost" id="edit-weights-btn" style="width:auto;">&#9878; Weights</button>
      <button class="btn btn-ghost" id="export-gradebook-btn" style="width:auto;">&#8681; Export .xlsx</button>
    </div>

    <div id="summary-body" class="summary-body">
      <div class="empty-state"><p>Loading summary…</p></div>
    </div>
  `;

  wireGradesTabs(mount, sectionId);
  mount.querySelector('#grades-section-select').addEventListener('change', (e) => {
    navigate(`grades?section=${e.target.value}&view=summary`);
  });
  mount.querySelector('#edit-weights-btn').addEventListener('click', () => {
    openWeightsForm(mount, sectionId, () => loadAndRenderSummary(mount, sectionId));
  });
  mount.querySelector('#export-gradebook-btn').addEventListener('click', (e) => {
    const sectionName = sections.find((s) => s.id === sectionId)?.name || '';
    exportGradebookExcel(sectionId, sectionName, e.currentTarget);
  });

  await loadAndRenderSummary(mount, sectionId);
}

async function loadAndRenderSummary(mount, sectionId) {
  const body = mount.querySelector('#summary-body');
  body.innerHTML = `<div class="empty-state"><p>Loading summary…</p></div>`;

  const [
    { data: students, error: studentsError },
    { data: assessments, error: assessmentsError },
    { data: weightRows, error: weightsError },
  ] = await Promise.all([
    supabase.from('students').select('id, name, photo_url').eq('section_id', sectionId).order('name', { ascending: true }),
    supabase.from('assessments').select('id, category, max_score').eq('section_id', sectionId),
    supabase.from('category_weights').select('category, weight').eq('section_id', sectionId),
  ]);

  if (studentsError || assessmentsError || weightsError) {
    const err = studentsError || assessmentsError || weightsError;
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load summary</h3><p>${escapeHtml(err.message)}</p></div>`;
    return;
  }

  if (!students || students.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students in this section yet</h3>
        <p>Add students to this section before viewing grade summaries.</p>
      </div>
    `;
    return;
  }

  let scoresByAssessment = new Map();
  if (assessments && assessments.length > 0) {
    const assessmentIds = assessments.map((a) => a.id);
    const { data: scores, error: scoresError } = await supabase
      .from('scores')
      .select('assessment_id, student_id, score')
      .in('assessment_id', assessmentIds);

    if (scoresError) {
      body.innerHTML = `<div class="empty-state"><h3>Couldn't load scores</h3><p>${escapeHtml(scoresError.message)}</p></div>`;
      return;
    }

    (scores || []).forEach((s) => {
      if (!scoresByAssessment.has(s.assessment_id)) scoresByAssessment.set(s.assessment_id, new Map());
      scoresByAssessment.get(s.assessment_id).set(s.student_id, s.score);
    });
  }

  const assessmentsByCategory = new Map();
  (assessments || []).forEach((a) => {
    if (!assessmentsByCategory.has(a.category)) assessmentsByCategory.set(a.category, []);
    assessmentsByCategory.get(a.category).push(a);
  });

  const weightMap = new Map((weightRows || []).map((w) => [w.category, w.weight]));
  const usingDefaultWeights = weightMap.size === 0;
  const defaultWeight = 100 / CATEGORIES.length;

  const photoPaths = students.filter((s) => s.photo_url).map((s) => s.photo_url);
  const signedUrlMap = await getSignedUrls(photoPaths);

  const studentRows = students.map((student) => {
    const breakdown = CATEGORIES.map((c) => {
      const catAssessments = assessmentsByCategory.get(c.key) || [];
      let sumPct = 0;
      let count = 0;
      catAssessments.forEach((a) => {
        const score = scoresByAssessment.get(a.id)?.get(student.id);
        if (score != null) {
          sumPct += (score / a.max_score) * 100;
          count += 1;
        }
      });
      return {
        key: c.key,
        label: c.label,
        weight: usingDefaultWeights ? defaultWeight : (weightMap.get(c.key) ?? 0),
        avg: count > 0 ? sumPct / count : null,
        count,
        total: catAssessments.length,
      };
    });

    const graded = breakdown.filter((b) => b.avg != null);
    const weightSum = graded.reduce((sum, b) => sum + b.weight, 0);
    const overall = weightSum > 0
      ? graded.reduce((sum, b) => sum + b.avg * b.weight, 0) / weightSum
      : null;

    return { student, breakdown, overall };
  });

  const graded = studentRows.filter((r) => r.overall != null);
  const classAvg = graded.length > 0
    ? graded.reduce((sum, r) => sum + r.overall, 0) / graded.length
    : null;
  let highest = null;
  let lowest = null;
  graded.forEach((r) => {
    if (!highest || r.overall > highest.overall) highest = r;
    if (!lowest || r.overall < lowest.overall) lowest = r;
  });

  body.innerHTML = `
    ${usingDefaultWeights ? `
      <p class="field-helper summary-weights-note">
        No custom weights saved yet — using an even split across categories. Use the Weights button to set your own.
      </p>
    ` : ''}
    <div class="summary-class-line">
      ${classAvg != null
        ? `Class average: <strong>${formatNumber(classAvg)}%</strong>
           &middot; Highest: <strong>${escapeHtml(highest.student.name)}</strong> (${formatNumber(highest.overall)}%)
           &middot; Lowest: <strong>${escapeHtml(lowest.student.name)}</strong> (${formatNumber(lowest.overall)}%)`
        : 'No grades recorded yet for this section.'}
    </div>
    <div class="summary-list">
      ${studentRows.map((r) => summaryCardHtml(r, signedUrlMap[r.student.photo_url])).join('')}
    </div>
  `;
}

function summaryCardHtml(row, signedUrl) {
  const { student, breakdown, overall } = row;
  const avatarInner = signedUrl
    ? `<img src="${signedUrl}" alt="" />`
    : `<span>${escapeHtml(getInitials(student.name))}</span>`;
  const overallDisplay = overall != null ? `${formatNumber(overall)}%` : '\u2014';

  return `
    <details class="summary-card">
      <summary class="summary-card__header">
        <div class="attendance-row__student">
          <div class="avatar${signedUrl ? '' : ' avatar--placeholder'}">${avatarInner}</div>
          <span class="attendance-row__name">${escapeHtml(student.name)}</span>
        </div>
        <span class="summary-card__average${overall == null ? ' summary-card__average--empty' : ''}">${overallDisplay}</span>
        <span class="summary-card__chevron" aria-hidden="true">&#9662;</span>
      </summary>
      <div class="summary-card__breakdown">
        ${breakdown.map((b) => `
          <div class="summary-card__category-row">
            <span class="summary-card__category-label">${b.label} <span class="summary-card__category-weight">(${formatNumber(b.weight)}%)</span></span>
            <span class="summary-card__category-value">
              ${b.avg != null ? `${formatNumber(b.avg)}%` : '\u2014'}
              <span class="summary-card__category-count">${b.count} of ${b.total} scored</span>
            </span>
          </div>
        `).join('')}
      </div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Score sheet
// ---------------------------------------------------------------------------

async function renderScoreSheet(mount, sections, sectionId, assessmentId) {
  mount.innerHTML = `<div class="empty-state"><p>Loading…</p></div>`;

  const { data: assessments, error: assessmentsError } = await supabase
    .from('assessments')
    .select('id, title, category, max_score, date')
    .eq('section_id', sectionId)
    .order('date', { ascending: false });

  if (assessmentsError) {
    mount.innerHTML = `<div class="empty-state"><h3>Couldn't load assessment</h3><p>${escapeHtml(assessmentsError.message)}</p></div>`;
    return;
  }

  const assessment = (assessments || []).find((a) => a.id === assessmentId);
  if (!assessment) {
    showToast("That assessment couldn't be found.", 'error');
    navigate(`grades?section=${sectionId}`, true);
    return;
  }

  mount.innerHTML = `
    <button class="btn btn-ghost back-btn" id="back-to-assessments">&#8592; Back to assessments</button>

    <div class="view-header">
      <div>
        <div class="score-sheet-heading">
          <h2 id="score-sheet-title">${escapeHtml(assessment.title)}</h2>
          <div class="score-sheet-heading__actions">
            <button class="icon-btn" id="edit-assessment-btn" aria-label="Edit ${escapeHtml(assessment.title)}" title="Edit assessment">&#9998;</button>
            <button class="icon-btn icon-btn--danger" id="delete-assessment-btn" aria-label="Delete ${escapeHtml(assessment.title)}" title="Delete assessment">&#128465;</button>
          </div>
        </div>
        <p class="view-header__sub">
          <span class="category-badge category-badge--${assessment.category}">${categoryLabel(assessment.category)}</span>
          &nbsp;${formatDateDisplay(assessment.date)} &middot; out of ${formatNumber(assessment.max_score)}
        </p>
      </div>
      <span class="sync-indicator" id="sync-indicator"></span>
    </div>

    <div class="attendance-toolbar">
      <div class="field attendance-toolbar__field">
        <label for="assessment-select">Assessment</label>
        <select id="assessment-select">
          ${assessments.map((a) => `<option value="${a.id}" ${a.id === assessmentId ? 'selected' : ''}>${escapeHtml(a.title)} (${formatDateDisplay(a.date)})</option>`).join('')}
        </select>
      </div>
      <div class="field attendance-toolbar__field">
        <label for="score-student-search">Search students</label>
        <input type="text" id="score-student-search" placeholder="Search by name…" autocomplete="off" />
      </div>
    </div>

    <div id="score-sheet-body" class="score-sheet-body">
      <div class="empty-state"><p>Loading students…</p></div>
    </div>
  `;

  mount.querySelector('#back-to-assessments').addEventListener('click', () => navigate(`grades?section=${sectionId}`));
  mount.querySelector('#assessment-select').addEventListener('change', (e) => {
    navigate(`grades?section=${sectionId}&assessment=${e.target.value}`);
  });
  mount.querySelector('#edit-assessment-btn').addEventListener('click', () => {
    openAssessmentForm(mount, sectionId, assessment, () => navigate(`grades?section=${sectionId}&assessment=${assessment.id}`));
  });
  mount.querySelector('#delete-assessment-btn').addEventListener('click', () => {
    confirmDeleteAssessment(mount, sectionId, assessment, () => navigate(`grades?section=${sectionId}`));
  });

  const state = { scores: new Map(), allStudents: [], signedUrlMap: {}, filterText: '', inFlight: 0 };
  const syncIndicator = mount.querySelector('#sync-indicator');
  const body = mount.querySelector('#score-sheet-body');

  mount.querySelector('#score-student-search').addEventListener('input', (e) => {
    state.filterText = e.target.value;
    renderFilteredScoreRows(state, body, syncIndicator, assessment);
  });

  await loadAndRenderScoreSheet(assessment, sectionId, state, body, syncIndicator);
}

async function loadAndRenderScoreSheet(assessment, sectionId, state, body, syncIndicator) {
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
        <p>Add students to this section before recording scores.</p>
        <button class="btn btn-primary" id="go-to-students-btn" style="width:auto;margin-top:14px;">Add students</button>
      </div>
    `;
    body.querySelector('#go-to-students-btn').addEventListener('click', () => navigate(`students?section=${sectionId}`));
    return;
  }

  const studentIds = students.map((s) => s.id);
  const { data: scores, error: scoresError } = await supabase
    .from('scores')
    .select('id, student_id, score')
    .eq('assessment_id', assessment.id)
    .in('student_id', studentIds);

  if (scoresError) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load scores</h3><p>${escapeHtml(scoresError.message)}</p></div>`;
    return;
  }

  state.scores = new Map((scores || []).map((r) => [r.student_id, { id: r.id, score: r.score }]));

  const photoPaths = students.filter((s) => s.photo_url).map((s) => s.photo_url);
  state.signedUrlMap = await getSignedUrls(photoPaths);
  state.allStudents = students;

  renderFilteredScoreRows(state, body, syncIndicator, assessment, sectionId);
}

function filterStudents(students, filterText) {
  const q = filterText.trim().toLowerCase();
  if (!q) return students;
  return students.filter((s) => s.name.toLowerCase().includes(q));
}

function renderFilteredScoreRows(state, body, syncIndicator, assessment) {
  const filtered = filterStudents(state.allStudents, state.filterText);

  if (filtered.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students match "${escapeHtml(state.filterText)}"</h3>
        <p>Try a different name or clear the search box.</p>
      </div>
    `;
    return;
  }

  renderScoreRows(filtered, state, body, syncIndicator, assessment, state.allStudents.length);
}

function renderScoreRows(students, state, body, syncIndicator, assessment, totalAll) {
  const scoredCount = state.scores.size;
  const showingNote = students.length !== totalAll ? ` &middot; showing ${students.length} of ${totalAll}` : '';

  body.innerHTML = `
    <p class="attendance-summary" id="score-summary">${scoredCount} of ${totalAll} scored${showingNote}</p>
    <div class="score-list">
      ${students.map((s) => scoreRowHtml(s, state.scores.get(s.id), state.signedUrlMap[s.photo_url], assessment.max_score)).join('')}
    </div>
  `;

  students.forEach((student) => {
    const row = body.querySelector(`[data-row="${student.id}"]`);
    if (!row) return;

    const displayEl = row.querySelector('[data-score-display]');
    const editEl = row.querySelector('[data-score-edit]');
    const valueEl = row.querySelector('[data-score-value]');
    const input = row.querySelector('[data-score-input]');
    const errorEl = row.querySelector('[data-score-error]');
    const editBtn = row.querySelector('[data-score-edit-btn]');
    const deleteBtn = row.querySelector('[data-score-delete-btn]');
    const saveBtn = row.querySelector('[data-score-save-btn]');
    const cancelBtn = row.querySelector('[data-score-cancel-btn]');

    const enterEditMode = () => {
      displayEl.style.display = 'none';
      editEl.style.display = 'flex';
      errorEl.textContent = '';
      input.classList.remove('score-input--invalid');
      input.focus();
      input.select();
    };

    const exitEditMode = () => {
      displayEl.style.display = 'flex';
      editEl.style.display = 'none';
      errorEl.textContent = '';
      input.classList.remove('score-input--invalid');
    };

    editBtn.addEventListener('click', enterEditMode);

    cancelBtn.addEventListener('click', () => {
      const record = state.scores.get(student.id);
      input.value = record?.score ?? '';
      exitEditMode();
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveBtn.click(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelBtn.click(); }
    });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      const result = await commitScore(student.id, assessment, input, errorEl, state, syncIndicator);
      saveBtn.disabled = false;
      if (result.success) {
        valueEl.textContent = result.value != null ? formatNumber(result.value) : '\u2014';
        deleteBtn.disabled = result.value == null;
        updateScoreSummary(body, totalAll, state);
        exitEditMode();
      }
    });

    deleteBtn.addEventListener('click', async () => {
      deleteBtn.disabled = true;
      const previous = state.scores.get(student.id);
      const result = await deleteScore(student.id, previous, state, syncIndicator);
      if (result.success) {
        input.value = '';
        valueEl.textContent = '\u2014';
        errorEl.textContent = '';
        showToast('Score removed.', 'success');
        updateScoreSummary(body, totalAll, state);
      } else {
        deleteBtn.disabled = false;
      }
    });
  });
}

function scoreRowHtml(student, record, signedUrl, maxScore) {
  const avatarInner = signedUrl
    ? `<img src="${signedUrl}" alt="" />`
    : `<span>${escapeHtml(getInitials(student.name))}</span>`;
  const hasScore = record?.score != null;
  const value = hasScore ? record.score : '';
  const displayValue = hasScore ? formatNumber(record.score) : '\u2014';

  return `
    <div class="score-row" data-row="${student.id}">
      <div class="attendance-row__student">
        <div class="avatar${signedUrl ? '' : ' avatar--placeholder'}">${avatarInner}</div>
        <span class="attendance-row__name">${escapeHtml(student.name)}</span>
      </div>
      <div class="score-row__controls">
        <div class="score-display" data-score-display>
          <span class="score-display__value" data-score-value>${displayValue}</span>
          <span class="score-input-max">/ ${formatNumber(maxScore)}</span>
          <button type="button" class="icon-btn" data-score-edit-btn aria-label="Edit score for ${escapeHtml(student.name)}" title="Edit score">&#9998;</button>
          <button type="button" class="icon-btn icon-btn--danger" data-score-delete-btn aria-label="Remove score for ${escapeHtml(student.name)}" title="Remove score" ${hasScore ? '' : 'disabled'}>&#128465;</button>
        </div>
        <div class="score-edit" data-score-edit style="display:none;">
          <input type="number" class="score-input" data-score-input min="0" max="${formatNumber(maxScore)}" step="any"
            value="${value}" placeholder="\u2014" aria-label="Score for ${escapeHtml(student.name)}" />
          <span class="score-input-max">/ ${formatNumber(maxScore)}</span>
          <button type="button" class="icon-btn" data-score-save-btn aria-label="Save score for ${escapeHtml(student.name)}" title="Save">&#10003;</button>
          <button type="button" class="icon-btn" data-score-cancel-btn aria-label="Cancel editing score for ${escapeHtml(student.name)}" title="Cancel">&#10005;</button>
        </div>
        <div class="field-error score-row__error" data-score-error></div>
      </div>
    </div>
  `;
}

async function commitScore(studentId, assessment, input, errorEl, state, syncIndicator) {
  const raw = input.value.trim();
  const previous = state.scores.get(studentId);

  errorEl.textContent = '';
  input.classList.remove('score-input--invalid');

  // Saving a blank field clears the existing score, if any.
  if (raw === '') {
    return deleteScore(studentId, previous, state, syncIndicator);
  }

  const value = parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > assessment.max_score) {
    input.classList.add('score-input--invalid');
    errorEl.textContent = `Enter a score between 0 and ${formatNumber(assessment.max_score)}.`;
    return { success: false };
  }

  beginSync(state, syncIndicator);
  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;

    const { data, error } = await supabase
      .from('scores')
      .upsert(
        { user_id: userData.user.id, assessment_id: assessment.id, student_id: studentId, score: value },
        { onConflict: 'assessment_id,student_id' }
      )
      .select('id, score')
      .single();
    if (error) throw error;

    state.scores.set(studentId, { id: data.id, score: data.score });
    endSync(state, syncIndicator, null);
    return { success: true, value: data.score };
  } catch (err) {
    errorEl.textContent = err.message || 'Could not save. Please try again.';
    endSync(state, syncIndicator, err.message || 'Could not save. Check your connection.');
    return { success: false };
  }
}

async function deleteScore(studentId, previous, state, syncIndicator) {
  if (!previous) return { success: true, value: null };

  beginSync(state, syncIndicator);
  try {
    const { error } = await supabase.from('scores').delete().eq('id', previous.id);
    if (error) throw error;
    state.scores.delete(studentId);
    endSync(state, syncIndicator, null);
    return { success: true, value: null };
  } catch (err) {
    endSync(state, syncIndicator, err.message || 'Could not remove score.');
    return { success: false };
  }
}

function updateScoreSummary(body, totalAll, state) {
  const el = body.querySelector('#score-summary');
  if (!el) return;
  el.textContent = `${state.scores.size} of ${totalAll} scored`;
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
// Small helpers
// ---------------------------------------------------------------------------

function categoryLabel(key) {
  return (CATEGORIES.find((c) => c.key === key) || CATEGORIES[CATEGORIES.length - 1]).label;
}

function formatNumber(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return Number.isInteger(num) ? String(num) : String(parseFloat(num.toFixed(2)));
}

function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isValidDateStr(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && !isNaN(new Date(str).getTime());
}

function formatDateDisplay(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

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