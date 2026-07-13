// js/sections.js
//
// Sections view: shows every section as a card with its student count.
// Add/edit happen in a modal; delete asks for confirmation first (deleting
// a section cascades to its students and their attendance records, per the
// schema's `on delete cascade`).

import { supabase } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';

export async function renderSections(mount) {
  mount.innerHTML = `
    <div class="view-header">
      <div>
        <h2>Sections</h2>
        <p class="view-header__sub">Your classes at a glance. Tap a section to manage its students.</p>
      </div>
      <button class="btn btn-primary" id="add-section-btn" style="width:auto;">+ Add section</button>
    </div>
    <div id="sections-body" class="sections-body">
      <div class="empty-state"><p>Loading sections…</p></div>
    </div>
  `;

  mount.querySelector('#add-section-btn').addEventListener('click', () => openSectionForm());

  await loadAndRenderSections(mount);
}

async function loadAndRenderSections(mount) {
  const body = mount.querySelector('#sections-body');

  const { data: sections, error } = await supabase
    .from('sections')
    .select('id, name, created_at, students(count)')
    .order('created_at', { ascending: true });

  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load sections</h3><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  if (!sections || sections.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No sections yet</h3>
        <p>Add your first section to start building your class roster.</p>
      </div>
    `;
    return;
  }

  body.innerHTML = `
    <div class="section-grid">
      ${sections.map(sectionCardHtml).join('')}
    </div>
  `;

  body.querySelectorAll('[data-open-section]').forEach(card => {
    card.addEventListener('click', () => {
      navigate(`students?section=${card.getAttribute('data-open-section')}`);
    });
  });

  body.querySelectorAll('[data-edit-section]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-edit-section');
      const section = sections.find(s => s.id === id);
      openSectionForm(section, mount);
    });
  });

  body.querySelectorAll('[data-delete-section]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-delete-section');
      const section = sections.find(s => s.id === id);
      confirmDeleteSection(section, mount);
    });
  });
}

function sectionCardHtml(section) {
  const count = section.students?.[0]?.count ?? 0;
  return `
    <div class="section-card" data-open-section="${section.id}">
      <div class="section-card__top">
        <h3>${escapeHtml(section.name)}</h3>
        <div class="section-card__actions">
          <button class="icon-btn" data-edit-section="${section.id}" aria-label="Edit ${escapeHtml(section.name)}">&#9998;</button>
          <button class="icon-btn icon-btn--danger" data-delete-section="${section.id}" aria-label="Delete ${escapeHtml(section.name)}">&#128465;</button>
        </div>
      </div>
      <p class="section-card__count">${count} ${count === 1 ? 'student' : 'students'}</p>
    </div>
  `;
}

function openSectionForm(existingSection, mount) {
  const isEdit = !!existingSection;

  const overlay = openModal({
    title: isEdit ? 'Edit section' : 'Add section',
    bodyHtml: `
      <form id="section-form">
        <div class="field">
          <label for="section-name">Section name</label>
          <input type="text" id="section-name" name="name" placeholder="e.g. Grade 7 - Newton" required maxlength="80" value="${isEdit ? escapeHtml(existingSection.name) : ''}" />
          <div class="field-error" id="section-name-error"></div>
        </div>
        <button type="submit" class="btn btn-primary" id="section-submit-btn">
          ${isEdit ? 'Save changes' : 'Add section'}
        </button>
      </form>
    `,
  });

  const form = overlay.querySelector('#section-form');
  const input = overlay.querySelector('#section-name');
  input.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = input.value.trim();
    const errorEl = overlay.querySelector('#section-name-error');
    errorEl.textContent = '';

    if (!name) {
      errorEl.textContent = 'Section name is required.';
      return;
    }

    const submitBtn = overlay.querySelector('#section-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      if (isEdit) {
        const { error } = await supabase
          .from('sections')
          .update({ name })
          .eq('id', existingSection.id);
        if (error) throw error;
        showToast('Section updated.', 'success');
      } else {
        const { data: userData, error: userError } = await supabase.auth.getUser();
        if (userError) throw userError;
        const { error } = await supabase
          .from('sections')
          .insert({ name, user_id: userData.user.id });
        if (error) throw error;
        showToast('Section added.', 'success');
      }
      closeModal();
      if (mount) await loadAndRenderSections(mount);
      else await renderSections(document.getElementById('app-main'));
    } catch (err) {
      errorEl.textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Save changes' : 'Add section';
    }
  });
}

function confirmDeleteSection(section, mount) {
  const overlay = openModal({
    title: 'Delete section?',
    bodyHtml: `
      <p style="margin-bottom:20px;color:var(--color-muted);">
        This permanently deletes <strong>${escapeHtml(section.name)}</strong>, along with every student
        and attendance record in it. This can't be undone.
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
      const { error } = await supabase.from('sections').delete().eq('id', section.id);
      if (error) throw error;
      showToast('Section deleted.', 'success');
      closeModal();
      await loadAndRenderSections(mount);
    } catch (err) {
      showToast(err.message || 'Could not delete section.', 'error');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}
