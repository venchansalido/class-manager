// js/toast.js
//
// Lightweight toast notifications. Used for auth errors, auto-save
// confirmations, etc. No dependencies.

let hideTimer = null;

export function showToast(message, variant = 'info', duration = 3200) {
  const region = document.getElementById('toast-region');
  if (!region) return;

  region.innerHTML = '';
  const el = document.createElement('div');
  el.className = `toast toast--${variant}`;
  el.textContent = message;
  region.appendChild(el);

  requestAnimationFrame(() => el.classList.add('toast--visible'));

  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    el.classList.remove('toast--visible');
    setTimeout(() => { if (el.parentNode) el.remove(); }, 200);
  }, duration);
}
