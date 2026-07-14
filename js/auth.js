// js/auth.js
//
// Renders the sign-up / login screen and wires up Supabase Auth.
// Email confirmation must be turned OFF in the Supabase dashboard
// (Authentication → Providers → Email) so signUp() returns an
// active session immediately — see schema.sql's final comment.

import { supabase } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';
import { openModal, closeModal } from './modal.js';

const LEDGER_ROWS = [
  'Sections stay organized, six or sixty',
  'Attendance saves itself as you tap',
  'Every teacher\u2019s roster is private by default',
  'History is there when you need to check',
];

const EYE_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.6 21.6 0 0 1 5.06-6.06M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 8 11 8a21.6 21.6 0 0 1-2.61 3.94M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

// Wires up every .password-toggle button inside `container` to flip its
// paired input between type="password" and type="text". Reused by the
// login/signup form and the change-password modal.
function attachPasswordToggles(container) {
  container.querySelectorAll('.password-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-toggle-for');
      const input = container.querySelector(`#${targetId}`);
      if (!input) return;
      const willShow = input.type === 'password';
      input.type = willShow ? 'text' : 'password';
      btn.innerHTML = willShow ? EYE_OFF_ICON : EYE_ICON;
      btn.setAttribute('aria-label', willShow ? 'Hide password' : 'Show password');
      btn.setAttribute('title', willShow ? 'Hide password' : 'Show password');
    });
  });
}

function passwordFieldHtml({ id, label, autocomplete, placeholder, helper }) {
  return `
    <div class="field">
      <label for="${id}">${label}</label>
      <div class="password-field">
        <input type="password" id="${id}" name="${id}" autocomplete="${autocomplete}" placeholder="${placeholder}" required />
        <button type="button" class="password-toggle" data-toggle-for="${id}" aria-label="Show password" title="Show password">${EYE_ICON}</button>
      </div>
      ${helper ? `<span class="field-helper">${helper}</span>` : ''}
      <div class="field-error" id="${id}-error"></div>
    </div>
  `;
}

export function renderAuth(mount) {
  mount.innerHTML = `
    <div class="auth-screen">
      <aside class="auth-brand">
        <div>
          <div class="auth-brand__mark">Roll Call</div>
          <h1 class="auth-brand__title" style="margin-top:28px;">Attendance,<br/>kept simply.</h1>
          <p class="auth-brand__tagline">One tap to mark a student, one glance to see who's missing.</p>
        </div>
        <div>
          <div class="auth-brand__ledger">
            ${LEDGER_ROWS.map(row => `
              <div class="auth-brand__row">
                <span>&#10003;</span>
                <span>${row}</span>
              </div>
            `).join('')}
          </div>
          <p class="auth-brand__foot" style="margin-top:24px;">Built for one teacher, six sections, every student.</p>
        </div>
      </aside>

      <div class="auth-form-wrap">
        <div class="auth-card">
          <div class="auth-card__mobile-mark">Roll Call</div>

          <div class="auth-tabs" role="tablist">
            <button class="auth-tab" role="tab" id="tab-login" aria-selected="true">Log in</button>
            <button class="auth-tab" role="tab" id="tab-signup" aria-selected="false">Sign up</button>
          </div>

          <div id="auth-panel"></div>

          <p class="auth-card__footnote" id="auth-footnote"></p>
        </div>
      </div>
    </div>
  `;

  const tabLogin = mount.querySelector('#tab-login');
  const tabSignup = mount.querySelector('#tab-signup');
  const panel = mount.querySelector('#auth-panel');
  const footnote = mount.querySelector('#auth-footnote');

  let mode = 'login';

  function setMode(next) {
    mode = next;
    tabLogin.setAttribute('aria-selected', String(mode === 'login'));
    tabSignup.setAttribute('aria-selected', String(mode === 'signup'));
    renderPanel();
  }

  tabLogin.addEventListener('click', () => setMode('login'));
  tabSignup.addEventListener('click', () => setMode('signup'));

  function renderPanel() {
    const isSignup = mode === 'signup';
    panel.innerHTML = `
      <h1>${isSignup ? 'Create your account' : 'Welcome back'}</h1>
      <span class="auth-card__sub">${isSignup ? 'Takes less than a minute to set up — no email verification needed.' : 'Log in to view and update your class roster.'}</span>

      <div class="auth-form-error" id="form-error"></div>

      <form id="auth-form" novalidate>
        <div class="field">
          <label for="email">Email address</label>
          <input type="email" id="email" name="email" autocomplete="email" placeholder="you@school.edu" required />
          <div class="field-error" id="email-error"></div>
        </div>

        ${passwordFieldHtml({
          id: 'password',
          label: 'Password',
          autocomplete: isSignup ? 'new-password' : 'current-password',
          placeholder: isSignup ? 'Create a password (at least 6 characters)' : 'Enter your password',
        })}

        ${isSignup ? passwordFieldHtml({
          id: 'confirm-password',
          label: 'Confirm password',
          autocomplete: 'new-password',
          placeholder: 'Re-type your password',
        }) : ''}

        <button type="submit" class="btn btn-primary" id="submit-btn">
          ${isSignup ? 'Create account' : 'Log in'}
        </button>
      </form>
    `;

    const form = panel.querySelector('#auth-form');
    form.addEventListener('submit', (e) => handleSubmit(e, isSignup));
    attachPasswordToggles(panel);

    footnote.textContent = isSignup
      ? 'Already have an account? Switch to the Log in tab above.'
      : 'New here? Switch to the Sign up tab above to create an account.';
  }

  async function handleSubmit(e, isSignup) {
    e.preventDefault();
    const form = e.target;
    const email = form.email.value.trim();
    const password = form.password.value;
    const confirmPassword = isSignup ? form['confirm-password'].value : null;

    clearErrors(form);
    let hasError = false;

    if (!isValidEmail(email)) {
      showFieldError('email-error', 'Enter a valid email address.');
      hasError = true;
    }
    if (password.length < 6) {
      showFieldError('password-error', 'Password must be at least 6 characters.');
      hasError = true;
    }
    if (isSignup && confirmPassword !== password) {
      showFieldError('confirm-password-error', 'Passwords do not match.');
      hasError = true;
    }
    if (hasError) return;

    const submitBtn = form.querySelector('#submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = isSignup ? 'Creating account…' : 'Logging in…';

    try {
      const { data, error } = isSignup
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });

      if (error) throw error;

      if (isSignup && !data.session) {
        // Only happens if "Confirm email" is still enabled in the dashboard.
        showToast('Account created — check your email to confirm, then log in.', 'info', 5000);
        setMode('login');
        return;
      }

      showToast(isSignup ? 'Account created. Welcome!' : 'Welcome back!', 'success');
      navigate('sections', true);
    } catch (err) {
      showFormError(friendlyAuthError(err));
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = isSignup ? 'Create account' : 'Log in';
    }
  }

  function showFieldError(id, message) {
    const el = panel.querySelector(`#${id}`);
    if (el) el.textContent = message;
  }

  function showFormError(message) {
    const el = panel.querySelector('#form-error');
    el.textContent = message;
    el.classList.add('auth-form-error--visible');
  }

  function clearErrors(form) {
    panel.querySelectorAll('.field-error').forEach(el => (el.textContent = ''));
    const formError = panel.querySelector('#form-error');
    formError.textContent = '';
    formError.classList.remove('auth-form-error--visible');
  }

  renderPanel();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function friendlyAuthError(err) {
  const msg = err?.message || 'Something went wrong. Please try again.';
  if (/already registered/i.test(msg)) return 'An account with this email already exists — try logging in.';
  if (/invalid login credentials/i.test(msg)) return 'Incorrect email or password.';
  if (/rate limit/i.test(msg)) return 'Too many attempts — please wait a moment and try again.';
  return msg;
}

export async function signOut() {
  await supabase.auth.signOut();
  navigate('auth', true);
}

// ---------------------------------------------------------------------------
// Change password (available once logged in — see app.js)
// ---------------------------------------------------------------------------

export function openChangePasswordModal() {
  const overlay = openModal({
    title: 'Change password',
    bodyHtml: `
      <form id="change-password-form" novalidate>
        <div class="auth-form-error" id="cp-form-error"></div>

        ${passwordFieldHtml({
          id: 'cp-current',
          label: 'Current password',
          autocomplete: 'current-password',
          placeholder: 'Enter your current password',
        })}

        ${passwordFieldHtml({
          id: 'cp-new',
          label: 'New password',
          autocomplete: 'new-password',
          placeholder: 'At least 6 characters',
        })}

        ${passwordFieldHtml({
          id: 'cp-confirm',
          label: 'Confirm new password',
          autocomplete: 'new-password',
          placeholder: 'Re-type your new password',
        })}

        <button type="submit" class="btn btn-primary" id="cp-submit-btn">Update password</button>
      </form>
    `,
  });

  attachPasswordToggles(overlay);
  overlay.querySelector('#change-password-form').addEventListener('submit', handleChangePassword);
}

async function handleChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const overlay = form.closest('.modal-overlay');

  const currentPassword = form['cp-current'].value;
  const newPassword = form['cp-new'].value;
  const confirmNewPassword = form['cp-confirm'].value;

  clearScopedErrors(overlay, 'cp-form-error');
  let hasError = false;

  if (!currentPassword) {
    showScopedFieldError(overlay, 'cp-current-error', 'Enter your current password.');
    hasError = true;
  }
  if (newPassword.length < 6) {
    showScopedFieldError(overlay, 'cp-new-error', 'New password must be at least 6 characters.');
    hasError = true;
  }
  if (confirmNewPassword !== newPassword) {
    showScopedFieldError(overlay, 'cp-confirm-error', 'Passwords do not match.');
    hasError = true;
  }
  if (!hasError && currentPassword && newPassword === currentPassword) {
    showScopedFieldError(overlay, 'cp-new-error', 'New password must be different from your current password.');
    hasError = true;
  }
  if (hasError) return;

  const submitBtn = overlay.querySelector('#cp-submit-btn');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Updating\u2026';

  try {
    const { data: userData, error: userError } = await supabase.auth.getUser();
    if (userError) throw userError;
    const email = userData.user.email;

    // Confirm the current password is correct before changing it.
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email, password: currentPassword });
    if (verifyError) {
      showScopedFieldError(overlay, 'cp-current-error', 'Your current password is incorrect.');
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) throw updateError;

    showToast('Password updated.', 'success');
    closeModal();
  } catch (err) {
    showScopedFormError(overlay, 'cp-form-error', err?.message || 'Could not update password. Please try again.');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Update password';
  }
}

function showScopedFieldError(container, id, message) {
  const el = container.querySelector(`#${id}`);
  if (el) el.textContent = message;
}

function showScopedFormError(container, id, message) {
  const el = container.querySelector(`#${id}`);
  if (!el) return;
  el.textContent = message;
  el.classList.add('auth-form-error--visible');
}

function clearScopedErrors(container, formErrorId) {
  container.querySelectorAll('.field-error').forEach((el) => (el.textContent = ''));
  const formError = container.querySelector(`#${formErrorId}`);
  if (formError) {
    formError.textContent = '';
    formError.classList.remove('auth-form-error--visible');
  }
}
