// js/app.js
//
// Entry point. Responsibilities:
//   1. Check for an existing Supabase session on load.
//   2. Register all routes with the router.
//   3. Guard authenticated routes — bounce to #/auth if logged out.
//   4. Render the app shell (sidebar nav on desktop, bottom tabs on phone)
//      around every authenticated view.
//   5. React live to auth state changes (login/logout in another tab, etc).

import { supabase } from './supabaseClient.js';
import { registerRoute, startRouter, navigate, currentRouteName } from './router.js';
import { renderAuth, signOut } from './auth.js';
import { renderSections } from './sections.js';
import { renderStudents } from './students.js';
import { renderAttendance } from './attendance.js';
import { renderHistory } from './history.js';

const PUBLIC_ROUTES = new Set(['auth']);

const NAV_ITEMS = [
  { route: 'sections',   label: 'Sections',   icon: '&#9636;' },
  { route: 'attendance', label: 'Attendance', icon: '&#10003;' },
  { route: 'history',    label: 'History',    icon: '&#128337;' },
];

let currentSession = null;

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

registerRoute('auth', async (mount) => {
  if (currentSession) { navigate('sections', true); return; }
  renderAuth(mount);
});

registerRoute('sections', (mount) => renderAppShell(mount, 'sections', renderSections));
registerRoute('students', (mount, params) => renderAppShell(mount, 'sections', renderStudents, params));
registerRoute('attendance', (mount, params) => renderAppShell(mount, 'attendance', renderAttendance, params));
registerRoute('history', (mount, params) => renderAppShell(mount, 'history', renderHistory, params));

registerRoute('not-found', (mount) => {
  mount.innerHTML = `<div class="empty-state"><h3>Page not found</h3><p>That view doesn't exist yet.</p></div>`;
});

// ---------------------------------------------------------------------------
// App shell — shared chrome for every logged-in view
// ---------------------------------------------------------------------------

function renderAppShell(mount, activeRoute, renderContent, params) {
  mount.innerHTML = `
    <div class="app-shell">
      <header class="app-topbar">
        <span class="app-topbar__mark">Roll Call</span>
        <button class="btn btn-ghost" id="logout-btn-mobile" style="padding:6px 12px;font-size:0.82rem;">Log out</button>
      </header>

      <nav class="app-nav">
        <div class="app-nav__mark">Roll Call</div>
        ${NAV_ITEMS.map(item => `
          <button class="app-nav__item" data-route="${item.route}" ${item.route === activeRoute ? 'aria-current="page"' : ''}>
            <span aria-hidden="true">${item.icon}</span> ${item.label}
          </button>
        `).join('')}
        <div class="app-nav__spacer"></div>
        <button class="app-nav__item" id="logout-btn-desktop">&#8592; Log out</button>
      </nav>

      <main class="app-main" id="app-main"></main>

      <nav class="app-bottombar">
        ${NAV_ITEMS.map(item => `
          <button class="app-bottombar__item" data-route="${item.route}" ${item.route === activeRoute ? 'aria-current="page"' : ''}>
            <span aria-hidden="true">${item.icon}</span>
            <span>${item.label}</span>
          </button>
        `).join('')}
      </nav>
    </div>
  `;

  mount.querySelectorAll('[data-route]').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.getAttribute('data-route')));
  });
  mount.querySelector('#logout-btn-desktop')?.addEventListener('click', signOut);
  mount.querySelector('#logout-btn-mobile')?.addEventListener('click', signOut);

  const contentMount = mount.querySelector('#app-main');
  return renderContent(contentMount, params);
}

// ---------------------------------------------------------------------------
// Auth-state guard
// ---------------------------------------------------------------------------

function guardRoute() {
  const routeName = currentRouteName();
  const isPublic = PUBLIC_ROUTES.has(routeName);

  if (!currentSession && !isPublic) {
    navigate('auth', true);
  } else if (currentSession && isPublic) {
    navigate('sections', true);
  }
}

async function boot() {
  const { data } = await supabase.auth.getSession();
  currentSession = data.session;

  supabase.auth.onAuthStateChange((_event, session) => {
    const hadSession = !!currentSession;
    currentSession = session;
    const hasSession = !!currentSession;
    if (hadSession !== hasSession) {
      navigate(hasSession ? 'sections' : 'auth', true);
    }
  });

  window.addEventListener('hashchange', guardRoute);
  guardRoute();
  startRouter();
}

boot();
