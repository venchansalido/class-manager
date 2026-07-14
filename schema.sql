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

-- ----------------------------------------------------------------------------
-- 3. ROW LEVEL SECURITY — enable + policies
--    Every table is scoped strictly to auth.uid() = user_id. No shared data.
-- ----------------------------------------------------------------------------

alter table public.sections            enable row level security;
alter table public.students            enable row level security;
alter table public.attendance_records  enable row level security;

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
