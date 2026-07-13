// js/supabaseClient.js
//
// Single shared Supabase client for the whole app.
// Fill in your Project URL and anon/public key below — both are found in
// Supabase Dashboard → Project Settings → API. The anon key is safe to
// expose in client-side code; RLS policies are what actually protect data.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hoageozdpcftsoqtkvlm.supabase.co'; // e.g. https://xxxxxxxx.supabase.co
const SUPABASE_ANON_KEY = 'sb_publishable_jJUsak_to7rlxIKWhfBa0g_4-NpojCK';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
  },
});

export const STORAGE_BUCKET = 'student-photos';
