# Roll Call — class-manager

Attendance tracker for a teacher with multiple sections. Vanilla HTML/CSS/JS
SPA (no framework, no build step) backed by Supabase. Deploys as-is to
Netlify.

## Project structure

```
class-manager/
├── index.html          # single HTML shell — router swaps #view's contents
├── schema.sql           # run once in Supabase SQL Editor
├── css/
│   └── styles.css       # design tokens + all styles (auth, shell, sections, modal)
├── js/
│   ├── supabaseClient.js  # Supabase client — fill in URL + anon key here
│   ├── router.js          # tiny hash-based router, no page reloads
│   ├── toast.js           # small notification helper
│   ├── modal.js            # reusable modal (add/edit forms, confirmations)
│   ├── auth.js              # login / sign-up view + logic
│   ├── sections.js          # sections list: add / edit / delete, student counts
│   └── app.js                # entry point: session check, routes, app shell
└── assets/               # (empty — for any static images/icons)
```

The Students view is stubbed in `app.js` (reachable by clicking a section
card) — that's the next build step. Attendance and History are stubbed too.

## One-time setup

1. **Run the schema.** Open your Supabase project → SQL Editor → paste in
   the full contents of `schema.sql` → Run. This creates the three tables,
   turns on RLS with owner-only policies, creates the `student-photos`
   storage bucket, and adds storage RLS policies.

2. **Turn off email confirmation.** Dashboard → Authentication → Providers →
   Email → turn off **Confirm email**. This can't be done via SQL. Without
   this step, `signUp()` won't return a session immediately and users will
   have to confirm via email before their first login.

3. **Add your credentials.** Open `js/supabaseClient.js` and replace:
   ```js
   const SUPABASE_URL = 'YOUR_SUPABASE_PROJECT_URL';
   const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
   ```
   with the values from Project Settings → API.

4. **Run locally.** This is a static site with ES modules, so it needs to be
   served over HTTP (not opened as a `file://` URL). Any static server works,
   e.g. from inside `class-manager/`:
   ```
   npx serve .
   ```

5. **Deploy to Netlify.** Drag the `class-manager/` folder into Netlify, or
   connect the repo with build command left blank and publish directory set
   to `class-manager` (or the repo root, depending on where you place it).

## Notes on the photo storage convention

The `student-photos` bucket is **private** — access is gated by Storage RLS
policies that check the file path's first folder segment against
`auth.uid()`. When you build the student photo upload (students.js), upload
each file to a path like:

```
{user_id}/{student_id}.jpg
```

and store that **path** (not a public URL) in `students.photo_url`. To
display a photo, generate a short-lived signed URL client-side with:

```js
const { data } = await supabase.storage
  .from('student-photos')
  .createSignedUrl(path, 60 * 60); // 1 hour
```

## What's built so far

- [x] Database schema + RLS (`schema.sql`)
- [x] Storage bucket + RLS
- [x] Project file structure
- [x] Sign up / log in (no email confirmation, friendly validation errors)
- [x] Session-aware routing (auth guard, redirect on login/logout)
- [x] Responsive app shell (sidebar nav on tablet/desktop, bottom tabs on phone)
- [x] Sections CRUD (add / edit / delete, student counts, links to Students view)
- [ ] Students CRUD + photo upload/resize
- [ ] Daily attendance sheet + auto-save
- [ ] History view
