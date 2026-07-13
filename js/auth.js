// js/auth.js
//
// Renders the sign-up / login screen and wires up Supabase Auth.
// Email confirmation must be turned OFF in the Supabase dashboard
// (Authentication → Providers → Email) so signUp() returns an
// active session immediately — see schema.sql's final comment.

import { supabase } from './supabaseClient.js';
import { navigate } from './router.js';
import { showToast } from './toast.js';

const LEDGER_ROWS = [
  'Sections stay organized, six or sixty',
  'Attendance saves itself as you tap',
  'Every teacher\u2019s roster is private by default',
  'History is there when you need to check',
];

export function renderAuth(mount) {
  mount.innerHTML = `
    <div class="auth-screen">
      <aside class="auth-brand">
        <div>
          <div class="auth-brand__mark">Roll Call</div>
          <h1 class="auth-brand__title" style="margin-top:28px;">Attendance,<br/>kept simply.</h1>
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
      <span class="auth-card__sub">${isSignup ? 'Takes less than a minute — no email verification needed.' : 'Log in to your class roster.'}</span>

      <div class="auth-form-error" id="form-error"></div>

      <form id="auth-form" novalidate>
        <div class="field">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" autocomplete="email" placeholder="you@school.edu" required />
          <div class="field-error" id="email-error"></div>
        </div>
        <div class="field">
          <label for="password">Password</label>
          <input type="password" id="password" name="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" placeholder="At least 6 characters" required />
          <div class="field-error" id="password-error"></div>
        </div>
        ${isSignup ? `
        <div class="field">
          <label for="confirm-password">Confirm password</label>
          <input type="password" id="confirm-password" name="confirm-password" autocomplete="new-password" placeholder="Re-type your password" required />
          <div class="field-error" id="confirm-password-error"></div>
        </div>` : ''}

        <button type="submit" class="btn btn-primary" id="submit-btn">
          ${isSignup ? 'Create account' : 'Log in'}
        </button>
      </form>
    `;

    const form = panel.querySelector('#auth-form');
    form.addEventListener('submit', (e) => handleSubmit(e, isSignup));
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
