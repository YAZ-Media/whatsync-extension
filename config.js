// External Supabase — auth + database (user_profiles, sidebar_fields, logs, etc.)
const SUPABASE_CONFIG = {
  url: 'https://ogsvchujqpayuckxuwdf.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M',
  redirectUrl: 'https://ogsvchujqpayuckxuwdf.supabase.co/auth/v1/callback'
};

// Harmony/Lovable project — edge functions only
const EDGE_FUNCTIONS_CONFIG = {
  url: 'https://ogsvchujqpayuckxuwdf.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpenhtdWJycHd3ZnJqZXBjdHRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTUxMTksImV4cCI6MjA4NDA3MTExOX0.zYzUmVLjM3Ml7z5EKjwjA9oE4ohnuqCbCV_4n1jgGBs'
};

// HubSpot Configuration
const HUBSPOT_CONFIG = {
  edgeFunctionUrl: `${EDGE_FUNCTIONS_CONFIG.url}/functions/v1/hubspot`,
  apiUrl: 'https://api.hubapi.com'
};

// Session Configuration.
// The session is persistent — users stay logged in as long as their Supabase
// refresh token is valid (it auto-renews on use). There is NO wall-clock logout;
// the background proactively refreshes the access token before it expires, and
// only signs the user out if the refresh token itself is rejected.
const SESSION_CONFIG = {
  // Refresh the access token this long before it expires.
  refreshLeewayMs: 10 * 60 * 1000, // 10 minutes
  // How often the background checks whether a refresh is due.
  checkIntervalMs: 30 * 60 * 1000 // 30 minutes
};
