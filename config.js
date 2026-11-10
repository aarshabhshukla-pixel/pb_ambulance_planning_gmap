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
  SUPABASE_URL: 'https://dfyxldsojpgasuxejyja.supabase.co',        // e.g. 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRmeXhsZHNvanBnYXN1eGVqeWphIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQyOTAzNDEsImV4cCI6MjEwOTg2NjM0MX0.ZXR4q-u46zmM0KJvVNyCeYFmeWjZi63LS3CbQ2x3akI',   // the "anon public" key (long text starting with eyJ...)

  // Road routing for the Route deployment module (pick at least one)
  ORS_API_KEY: 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjIyOGVjMGYxYmRkZDQ1N2ZiNTUyOTJkODMwNDdkMGM5IiwiaCI6Im11cm11cjY0In0=',         // openrouteservice.org free key (recommended, no card needed)
  OLA_MAPS_API_KEY: 'wd-N7yDEjeJKHOyuRc_KLdGD-ygkfp',    // maps.olakrutrim.com key (optional)

  // Google Maps for the Radius coverage module (optional)
  GOOGLE_MAPS_API_KEY: 'AIzaSyCNRWwgj0P5NfF0R7Aad4Zg02kmYPx4Kbw', // restricted to your Vercel site

  // Organisation name shown on the team page and exports
  ORG_NAME: 'PB Health'
};
