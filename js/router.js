// js/router.js
//
// Tiny hash-based router. Each route maps to a render function that
// receives the mount element and an optional params object, and returns
// an optional cleanup function (for removing listeners/subscriptions
// when the user navigates away). No full page reloads ever happen —
// we only swap the innerHTML of #view.

const routes = new Map();
let currentCleanup = null;
const mountEl = () => document.getElementById('view');

export function registerRoute(name, renderFn) {
  routes.set(name, renderFn);
}

export function navigate(path, replace = false) {
  const target = `#${path}`;
  if (replace) {
    window.location.replace(target);
  } else if (window.location.hash === target) {
    // already there — re-run the render manually
    handleRouteChange();
  } else {
    window.location.hash = target;
  }
}

function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [name, queryString] = raw.split('?');
  const params = Object.fromEntries(new URLSearchParams(queryString || ''));
  return { name: name || 'auth', params };
}

async function handleRouteChange() {
  const { name, params } = parseHash();
  const renderFn = routes.get(name) || routes.get('not-found');
  if (!renderFn) return;

  if (typeof currentCleanup === 'function') {
    try { currentCleanup(); } catch (_) { /* ignore */ }
  }

  const el = mountEl();
  el.setAttribute('data-route', name);
  currentCleanup = await renderFn(el, params);
}

export function startRouter() {
  window.addEventListener('hashchange', handleRouteChange);
  handleRouteChange();
}

export function currentRouteName() {
  return parseHash().name;
}
