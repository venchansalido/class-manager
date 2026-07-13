// js/students.js
//
// Students view for a single section: roster list with photo thumbnails,
// add/edit (name + optional photo) in a modal, delete with confirmation.
//
// Photo handling:
//   - Files are resized/cropped client-side to a 300x300 JPEG before upload
//     (keeps storage + bandwidth low on mobile).
//   - Uploaded to the private "student-photos" bucket at `${user_id}/${student_id}.jpg`
//     (see schema.sql's storage policies — access is gated on that path prefix).
//   - Since the bucket is private, we store the storage PATH in `photo_url`
//     (not a public URL) and generate short-lived signed URLs at render time.

import { supabase, STORAGE_BUCKET } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024; // 8MB, before client-side resize
const PHOTO_SIZE = 300;
const SIGNED_URL_TTL = 3600; // 1 hour, plenty for one view session

export async function renderStudents(mount, params) {
  const sectionId = params?.section;
  if (!sectionId) {
    navigate('sections', true);
    return;
  }

  mount.innerHTML = `
    <button class="btn btn-ghost back-btn" id="back-to-sections">&#8592; Back to sections</button>
    <div id="students-container">
      <div class="empty-state"><p>Loading…</p></div>
    </div>
  `;
  mount.querySelector('#back-to-sections').addEventListener('click', () => navigate('sections'));

  const container = mount.querySelector('#students-container');

  const { data: section, error } = await supabase
    .from('sections')
    .select('id, name')
    .eq('id', sectionId)
    .single();

  if (error || !section) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>Section not found</h3>
        <p>It may have been deleted, or belongs to a different account.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2>${escapeHtml(section.name)}</h2>
        <p class="view-header__sub" id="student-count-sub">Loading students…</p>
      </div>
      <button class="btn btn-primary" id="add-student-btn" style="width:auto;">+ Add student</button>
    </div>
    <div id="students-body" class="students-body">
      <div class="empty-state"><p>Loading students…</p></div>
    </div>
  `;

  container.querySelector('#add-student-btn').addEventListener('click', () => openStudentForm(section, container));

  await loadAndRenderStudents(container, section);
}

// ---------------------------------------------------------------------------
// Load + render the roster
// ---------------------------------------------------------------------------

async function loadAndRenderStudents(container, section) {
  const body = container.querySelector('#students-body');
  const sub = container.querySelector('#student-count-sub');

  const { data: students, error } = await supabase
    .from('students')
    .select('id, name, photo_url, created_at')
    .eq('section_id', section.id)
    .order('created_at', { ascending: true });

  if (error) {
    body.innerHTML = `<div class="empty-state"><h3>Couldn't load students</h3><p>${escapeHtml(error.message)}</p></div>`;
    sub.textContent = '';
    return;
  }

  sub.textContent = `${students.length} ${students.length === 1 ? 'student' : 'students'}`;

  if (students.length === 0) {
    body.innerHTML = `
      <div class="empty-state">
        <h3>No students yet</h3>
        <p>Add your first student to start taking attendance for this section.</p>
      </div>
    `;
    return;
  }

  const photoPaths = students.filter((s) => s.photo_url).map((s) => s.photo_url);
  const signedUrlMap = await getSignedUrls(photoPaths);

  body.innerHTML = `
    <div class="student-grid">
      ${students.map((s) => studentCardHtml(s, signedUrlMap[s.photo_url])).join('')}
    </div>
  `;

  body.querySelectorAll('[data-edit-student]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const student = students.find((s) => s.id === btn.getAttribute('data-edit-student'));
      openStudentForm(section, container, student, signedUrlMap[student?.photo_url]);
    });
  });

  body.querySelectorAll('[data-delete-student]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const student = students.find((s) => s.id === btn.getAttribute('data-delete-student'));
      confirmDeleteStudent(student, container, section);
    });
  });
}

function studentCardHtml(student, signedUrl) {
  const avatarInner = signedUrl
    ? `<img src="${signedUrl}" alt="" />`
    : `<span>${escapeHtml(getInitials(student.name))}</span>`;

  return `
    <div class="student-card">
      <div class="student-card__main">
        <div class="avatar${signedUrl ? '' : ' avatar--placeholder'}">${avatarInner}</div>
        <h3 class="student-card__name">${escapeHtml(student.name)}</h3>
      </div>
      <div class="student-card__actions">
        <button class="icon-btn" data-edit-student="${student.id}" aria-label="Edit ${escapeHtml(student.name)}">&#9998;</button>
        <button class="icon-btn icon-btn--danger" data-delete-student="${student.id}" aria-label="Delete ${escapeHtml(student.name)}">&#128465;</button>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Add / edit modal
// ---------------------------------------------------------------------------

function openStudentForm(section, container, existingStudent, existingSignedUrl) {
  const isEdit = !!existingStudent;
  const hasExistingPhoto = !!existingStudent?.photo_url;

  const overlay = openModal({
    title: isEdit ? 'Edit student' : 'Add student',
    bodyHtml: `
      <form id="student-form">
        <div class="photo-upload">
          <div class="photo-upload__preview" id="photo-preview">
            ${hasExistingPhoto && existingSignedUrl
              ? `<img src="${existingSignedUrl}" alt="" id="photo-preview-img" />`
              : `<span id="photo-preview-initials">${escapeHtml(getInitials(existingStudent?.name || ''))}</span>`}
          </div>
          <div class="photo-upload__controls">
            <label class="btn btn-ghost photo-upload__btn" for="student-photo">Choose photo</label>
            <input type="file" id="student-photo" name="photo" accept="image/*" hidden />
            <button type="button" class="photo-upload__remove" id="remove-photo-btn" ${hasExistingPhoto ? '' : 'style="display:none;"'}>Remove photo</button>
          </div>
        </div>
        <div class="field-error" id="photo-error"></div>

        <div class="field">
          <label for="student-name">Student name</label>
          <input type="text" id="student-name" name="name" placeholder="e.g. Juan Dela Cruz" required maxlength="120" value="${isEdit ? escapeHtml(existingStudent.name) : ''}" />
          <div class="field-error" id="student-name-error"></div>
        </div>

        <button type="submit" class="btn btn-primary" id="student-submit-btn">
          ${isEdit ? 'Save changes' : 'Add student'}
        </button>
      </form>
    `,
  });

  const form = overlay.querySelector('#student-form');
  const nameInput = overlay.querySelector('#student-name');
  const fileInput = overlay.querySelector('#student-photo');
  const removeBtn = overlay.querySelector('#remove-photo-btn');
  const preview = overlay.querySelector('#photo-preview');
  const photoError = overlay.querySelector('#photo-error');

  nameInput.focus();

  let selectedFile = null;
  let removeRequested = false;

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    photoError.textContent = '';
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      photoError.textContent = 'Please choose an image file.';
      fileInput.value = '';
      return;
    }
    if (file.size > MAX_SOURCE_FILE_BYTES) {
      photoError.textContent = 'Image is too large (max 8MB).';
      fileInput.value = '';
      return;
    }

    selectedFile = file;
    removeRequested = false;
    preview.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="" />`;
    removeBtn.style.display = '';
  });

  removeBtn.addEventListener('click', () => {
    selectedFile = null;
    removeRequested = true;
    fileInput.value = '';
    preview.innerHTML = `<span>${escapeHtml(getInitials(nameInput.value))}</span>`;
    removeBtn.style.display = 'none';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = nameInput.value.trim();
    const nameError = overlay.querySelector('#student-name-error');
    nameError.textContent = '';
    photoError.textContent = '';

    if (!name) {
      nameError.textContent = 'Student name is required.';
      return;
    }

    const submitBtn = overlay.querySelector('#student-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving…';

    try {
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;
      const userId = userData.user.id;

      const studentId = isEdit ? existingStudent.id : crypto.randomUUID();

      if (isEdit) {
        const { error } = await supabase.from('students').update({ name }).eq('id', studentId);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('students')
          .insert({ id: studentId, name, section_id: section.id, user_id: userId });
        if (error) throw error;
      }

      if (selectedFile) {
        submitBtn.textContent = 'Uploading photo…';
        const blob = await resizeImageToBlob(selectedFile, PHOTO_SIZE);
        const path = `${userId}/${studentId}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from(STORAGE_BUCKET)
          .upload(path, blob, { upsert: true, contentType: 'image/jpeg' });
        if (uploadError) throw uploadError;

        const { error: updateError } = await supabase
          .from('students')
          .update({ photo_url: path })
          .eq('id', studentId);
        if (updateError) throw updateError;
      } else if (removeRequested && existingStudent?.photo_url) {
        await supabase.storage.from(STORAGE_BUCKET).remove([existingStudent.photo_url]);
        const { error: updateError } = await supabase
          .from('students')
          .update({ photo_url: null })
          .eq('id', studentId);
        if (updateError) throw updateError;
      }

      showToast(isEdit ? 'Student updated.' : 'Student added.', 'success');
      closeModal();
      await loadAndRenderStudents(container, section);
    } catch (err) {
      photoError.textContent = '';
      nameError.textContent = err.message || 'Something went wrong. Please try again.';
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isEdit ? 'Save changes' : 'Add student';
    }
  });
}

function confirmDeleteStudent(student, container, section) {
  const overlay = openModal({
    title: 'Delete student?',
    bodyHtml: `
      <p style="margin-bottom:20px;color:var(--color-muted);">
        This permanently deletes <strong>${escapeHtml(student.name)}</strong> and every attendance
        record for them. This can't be undone.
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
      if (student.photo_url) {
        await supabase.storage.from(STORAGE_BUCKET).remove([student.photo_url]);
      }
      const { error } = await supabase.from('students').delete().eq('id', student.id);
      if (error) throw error;
      showToast('Student deleted.', 'success');
      closeModal();
      await loadAndRenderStudents(container, section);
    } catch (err) {
      showToast(err.message || 'Could not delete student.', 'error');
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  });
}

// ---------------------------------------------------------------------------
// Image helpers
// ---------------------------------------------------------------------------

function resizeImageToBlob(file, size = PHOTO_SIZE, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');

      // Cover-crop centered, so portraits don't get squashed.
      const scale = Math.max(size / img.width, size / img.height);
      const sw = size / scale;
      const sh = size / scale;
      const sx = (img.width - sw) / 2;
      const sy = (img.height - sh) / 2;

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Could not process image.'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read that image file.'));
    };
    img.src = objectUrl;
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
