// js/modal.js
//
// Minimal modal helper. Used for "add/edit section", "confirm delete", etc.
// openModal returns the modal's root element so callers can query into it.

let activeOverlay = null;

export function openModal({ title, bodyHtml, onMount }) {
  closeModal();

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
      <div class="modal__header">
        <h2>${title}</h2>
        <button class="modal__close" aria-label="Close" id="modal-close-btn">&times;</button>
      </div>
      <div class="modal__body">${bodyHtml}</div>
    </div>
  `;

  document.body.appendChild(overlay);
  activeOverlay = overlay;

  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeModal();
  });
  overlay.querySelector('#modal-close-btn').addEventListener('click', closeModal);

  const escHandler = (e) => {
    if (e.key === 'Escape') closeModal();
  };
  document.addEventListener('keydown', escHandler);
  overlay.dataset.escBound = 'true';
  overlay._escHandler = escHandler;

  requestAnimationFrame(() => overlay.classList.add('modal-overlay--visible'));

  if (typeof onMount === 'function') onMount(overlay);

  return overlay;
}

export function closeModal() {
  if (!activeOverlay) return;
  if (activeOverlay._escHandler) {
    document.removeEventListener('keydown', activeOverlay._escHandler);
  }
  activeOverlay.remove();
  activeOverlay = null;
}
