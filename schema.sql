-- ============================================================================
-- class-manager — Supabase schema, RLS policies, and Storage policies
-- Run this once in the Supabase SQL Editor (Project → SQL Editor → New query)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. TABLES
-- ----------------------------------------------------------------------------

create table if not exists public.sections (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.students (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  section_id  uuid not null references public.sections(id) on delete cascade,
  name        text not null,
  photo_url   text,
  created_at  timestamptz not null default now()
);

create table if not exists public.attendance_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  student_id  uuid not null references public.students(id) on delete cascade,
  date        date not null default current_date,
  status      text not null default 'present'
              check (status in ('present', 'absent', 'late', 'excused')),
  notes       text,
  created_at  timestamptz not null default now(),
  -- one record per student per day — lets the attendance sheet "auto-save"
  -- via upsert(on_conflict: student_id,date) instead of duplicating rows
  unique (student_id, date)
);

-- An assessment is one gradable item for a section: a quiz, exam, summative
-- task, or activity. Teacher creates as many as she wants, per section.
create table if not exists public.assessments (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  section_id  uuid not null references public.sections(id) on delete cascade,
  title       text not null,
  category    text not null default 'other'
              check (category in ('quiz', 'exam', 'summative', 'activity', 'other')),
  max_score   numeric not null check (max_score > 0),
  date        date not null default current_date,
  created_at  timestamptz not null default now()
);

-- One score per student per assessment.
create table if not exists public.scores (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  assessment_id  uuid not null references public.assessments(id) on delete cascade,
  student_id     uuid not null references public.students(id) on delete cascade,
  score          numeric not null check (score >= 0),
  created_at     timestamptz not null default now(),
  unique (assessment_id, student_id)
);

-- category_weights — per-section weight (%) assigned to each assessment
-- category. Categories with no row here fall back to an equal-split default
-- shown client-side (js/grades.js) until the teacher saves their own scheme.
create table if not exists public.category_weights (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  section_id  uuid not null references public.sections(id) on delete cascade,
  category    text not null check (category in ('quiz', 'exam', 'summative', 'activity', 'other')),
  weight      numeric(5,2) not null default 0 check (weight >= 0 and weight <= 100),
  created_at  timestamptz not null default now(),
  -- one weight row per category per section — upsert on (section_id, category)
  unique (section_id, category)
);

-- ----------------------------------------------------------------------------
-- 2. INDEXES
-- ----------------------------------------------------------------------------

create index if not exists idx_sections_user_id            on public.sections (user_id);
create index if not exists idx_students_user_id            on public.students (user_id);
create index if not exists idx_students_section_id         on public.students (section_id);
create index if not exists idx_attendance_user_id           on public.attendance_records (user_id);
create index if not exists idx_attendance_student_id        on public.attendance_records (student_id);
create index if not exists idx_attendance_date              on public.attendance_records (date);
create index if not exists idx_attendance_student_date      on public.attendance_records (student_id, date);
create index if not exists idx_assessments_section_id       on public.assessments (section_id);
create index if not exists idx_scores_assessment_id         on public.scores (assessment_id);
create index if not exists idx_scores_student_id            on public.scores (student_id);
create index if not exists idx_category_weights_user_id     on public.category_weights (user_id);
create index if not exists idx_category_weights_section_id  on public.category_weights (section_id);

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — enable + policies
--    Every table is scoped strictly to auth.uid() = user_id. No shared data.
-- ----------------------------------------------------------------------------

alter table public.sections            enable row level security;
alter table public.students            enable row level security;
alter table public.attendance_records  enable row level security;
alter table public.assessments         enable row level security;
alter table public.scores              enable row level security;
alter table public.category_weights    enable row level security;

-- sections -------------------------------------------------------------------
drop policy if exists "sections_select_own" on public.sections;
create policy "sections_select_own"
  on public.sections for select
  using (auth.uid() = user_id);

drop policy if exists "sections_insert_own" on public.sections;
create policy "sections_insert_own"
  on public.sections for insert
  with check (auth.uid() = user_id);

drop policy if exists "sections_update_own" on public.sections;
create policy "sections_update_own"
  on public.sections for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "sections_delete_own" on public.sections;
create policy "sections_delete_own"
  on public.sections for delete
  using (auth.uid() = user_id);

-- students ---------------------------------------------------------------------
drop policy if exists "students_select_own" on public.students;
create policy "students_select_own"
  on public.students for select
  using (auth.uid() = user_id);

drop policy if exists "students_insert_own" on public.students;
create policy "students_insert_own"
  on public.students for insert
  with check (auth.uid() = user_id);

drop policy if exists "students_update_own" on public.students;
create policy "students_update_own"
  on public.students for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "students_delete_own" on public.students;
create policy "students_delete_own"
  on public.students for delete
  using (auth.uid() = user_id);

-- attendance_records -----------------------------------------------------------
drop policy if exists "attendance_select_own" on public.attendance_records;
create policy "attendance_select_own"
  on public.attendance_records for select
  using (auth.uid() = user_id);

drop policy if exists "attendance_insert_own" on public.attendance_records;
create policy "attendance_insert_own"
  on public.attendance_records for insert
  with check (auth.uid() = user_id);

drop policy if exists "attendance_update_own" on public.attendance_records;
create policy "attendance_update_own"
  on public.attendance_records for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "attendance_delete_own" on public.attendance_records;
create policy "attendance_delete_own"
  on public.attendance_records for delete
  using (auth.uid() = user_id);

-- assessments ------------------------------------------------------------------
-- NOTE: applied in Supabase as a single "for all" policy rather than four
-- separate select/insert/update/delete policies (functionally equivalent).
drop policy if exists "Users manage their own assessments" on public.assessments;
create policy "Users manage their own assessments"
  on public.assessments for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- scores -------------------------------------------------------------------
drop policy if exists "Users manage their own scores" on public.scores;
create policy "Users manage their own scores"
  on public.scores for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- category_weights -----------------------------------------------------------
drop policy if exists "category_weights_select_own" on public.category_weights;
create policy "category_weights_select_own"
  on public.category_weights for select
  using (auth.uid() = user_id);

drop policy if exists "category_weights_insert_own" on public.category_weights;
create policy "category_weights_insert_own"
  on public.category_weights for insert
  with check (auth.uid() = user_id);

drop policy if exists "category_weights_update_own" on public.category_weights;
create policy "category_weights_update_own"
  on public.category_weights for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "category_weights_delete_own" on public.category_weights;
create policy "category_weights_delete_own"
  on public.category_weights for delete
  using (auth.uid() = user_id);

-- ----------------------------------------------------------------------------
-- 4. STORAGE — "student-photos" bucket + RLS-style policies on storage.objects
--
--    Convention: every uploaded file's path MUST start with the uploader's
--    auth.uid(), e.g.  {user_id}/{student_id}.jpg
--    This lets us gate access by reading the first path segment
--    (storage.foldername(name))[1] and comparing it to auth.uid().
--    The client-side upload code (js/students.js) follows this convention.
-- ----------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('student-photos', 'student-photos', false)
on conflict (id) do nothing;

drop policy if exists "student_photos_select_own" on storage.objects;
create policy "student_photos_select_own"
  on storage.objects for select
  using (
    bucket_id = 'student-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "student_photos_insert_own" on storage.objects;
create policy "student_photos_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'student-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "student_photos_update_own" on storage.objects;
create policy "student_photos_update_own"
  on storage.objects for update
  using (
    bucket_id = 'student-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  )
  with check (
    bucket_id = 'student-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "student_photos_delete_own" on storage.objects;
create policy "student_photos_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'student-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

-- ============================================================================
-- 5. MANUAL DASHBOARD STEPS (cannot be done via SQL) — do these once:
--
--    a) Authentication → Providers → Email → turn ON "Confirm email"
--       (sign-up now requires a 6-digit code before the account is usable)
--
--    b) Authentication → Email Templates → "Confirm signup" → edit the body
--       to show {{ .Token }}, e.g.:
--       "Your Roll Call confirmation code is {{ .Token }}"
--
--    c) Authentication → Email Templates → "Reset Password" → same edit:
--       "Your Roll Call password reset code is {{ .Token }}"
--
--    Without (a), sign-up returns a session immediately and no OTP screen
--    appears. Without (b)/(c), the emails still send, but show a clickable
--    link instead of a 6-digit code for the person to type in the app.
-- ============================================================================