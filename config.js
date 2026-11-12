// =====================================================================
// Ambulance Planner – settings file
// Edit this ONE file on GitHub (pencil icon) to change a key, then commit.
// Vercel redeploys automatically. These are public browser keys, so it
// is normal that anyone can read this file.
// Leave a value as '' to switch that feature off.
// =====================================================================
window.APP_CONFIG = {
  // Supabase (database + admin login). Supabase → Project Settings → API
  SUPABASE_URL: 'https://dfyxldsojpgasuxejyja.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_T8INb9WhV38OsTk2oVFjRw_M6Ft4Ns4',

  // Road distances and routes (free, no card). Checked working on 12 Nov 2026.
  ORS_API_KEY: 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjIyOGVjMGYxYmRkZDQ1N2ZiNTUyOTJkODMwNDdkMGM5IiwiaCI6Im11cm11cjY0In0=',

  // Road times with traffic (free, no card). Checked working on 12 Nov 2026.
  TOMTOM_API_KEY: 'dHBYe5HLdHKWEhK6k42quBOeixVsr5wp',

  // Ola Maps: the key wd-N7yDEjeJKHOyuRc_KLdGD-ygkfp was refused by Ola ("Unauthorized")
  // on 12 Nov 2026. Paste a working key between the quotes to switch Ola on.
  OLA_MAPS_API_KEY: '',

  // Google Maps (Radius coverage only): the key AIzaSyCNRWwgj0P5NfF0R7Aad4Zg02kmYPx4Kbw
  // is refused until billing is enabled on its Google Cloud project.
  // After enabling billing, paste it between the quotes.
  GOOGLE_MAPS_API_KEY: '',

  // Organisation name shown on the team page and exports
  ORG_NAME: 'PB Health'
};
