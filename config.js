// Cloud library settings. The publishable key is meant to be public: every row and file is
// protected by per-person rules in the database (see supabase/setup.sql).
export const CONFIG = {
  supabaseUrl: 'https://ixfusgtcorctjgzjylaj.supabase.co',
  supabaseAnonKey: 'sb_publishable_5XiaUirw_wLmm6lk67ltyA_wnBRSNdj',
  // Cloudflare Worker that stores song files in R2 (see cloudflare/worker.js). Empty = files stay in Supabase.
  filesUrl: '',
};
