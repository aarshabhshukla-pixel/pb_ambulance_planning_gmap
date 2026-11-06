// =====================================================================
// Ambulance Planner – settings file
// Edit this ONE file on GitHub (pencil icon) to connect the app to your
// services, then commit. Vercel redeploys automatically.
// Every value here is a public/browser key: it is safe in this file
// as long as you set the restrictions described in the setup guide.
// Leave a value as '' to switch that feature off.
// =====================================================================
window.APP_CONFIG = {
  // Supabase (database + admin login). Supabase → Project Settings → API
  SUPABASE_URL: '',        // e.g. 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: '',   // the "anon public" key (long text starting with eyJ...)

  // Road routing for the Route deployment module (pick at least one)
  ORS_API_KEY: '',         // openrouteservice.org free key (recommended, no card needed)
  OLA_MAPS_API_KEY: '',    // maps.olakrutrim.com key (optional)

  // Google Maps for the Radius coverage module (optional)
  GOOGLE_MAPS_API_KEY: '', // restricted to your Vercel site

  // Organisation name shown on the team page and exports
  ORG_NAME: 'PB Health'
};
