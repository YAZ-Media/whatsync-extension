// External Supabase — auth + database (user_profiles, sidebar_fields, logs, etc.)
const SUPABASE_CONFIG = {
  url: 'https://ogsvchujqpayuckxuwdf.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nc3ZjaHVqcXBheXVja3h1d2RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNzU3MzIsImV4cCI6MjA5NTk1MTczMn0.naUOzsjvZk5BT6kUM-eV1g4JxPhBogkBu8gb1Rg0Z8M',
  redirectUrl: 'https://ogsvchujqpayuckxuwdf.supabase.co/auth/v1/callback'
};

// Harmony/Lovable project — edge functions only
const EDGE_FUNCTIONS_CONFIG = {
  url: 'https://dizxmubrpwwfrjepcttb.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRpenhtdWJycHd3ZnJqZXBjdHRiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0OTUxMTksImV4cCI6MjA4NDA3MTExOX0.zYzUmVLjM3Ml7z5EKjwjA9oE4ohnuqCbCV_4n1jgGBs'
};

// HubSpot Configuration
const HUBSPOT_CONFIG = {
  edgeFunctionUrl: `${EDGE_FUNCTIONS_CONFIG.url}/functions/v1/hubspot`,
  apiUrl: 'https://api.hubapi.com'
};

// Session Configuration (automatic logout after prolonged inactivity)
const SESSION_CONFIG = {
  // Max session duration from last login. After this period, user is auto-logged out.
  timeoutMs: 6 * 60 * 60 * 1000, // 6 hours
  // How often background script checks for session expiration (alarm interval)
  checkIntervalMs: 5 * 60 * 1000 // 5 minutes
};
