import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

if (!url || !key) {
  console.warn('[db] SUPABASE_URL / SUPABASE_KEY missing — DB calls will fail');
}

export const supabase = createClient(url || '', key || '', {
  auth: { persistSession: false },
});
