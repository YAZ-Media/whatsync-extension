import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { authenticateRequest } from "../_shared/auth.ts";
import { signStatePayload, verifyStatePayload } from "../_shared/invites.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

const DEFAULT_FIELD_MAPPINGS = [
  { source: 'phone', target: 'phone', enabled: true },
  { source: 'contact_name', target: 'firstname', enabled: true, splitName: true },
  { source: 'last_message_date', target: 'notes_last_contacted', enabled: false },
  { source: 'email', target: 'email', enabled: true },
  { source: 'company', target: 'company', enabled: true },
  { source: 'job_title', target: 'jobtitle', enabled: true },
];

const ALLOWED_FIELD_SOURCES = new Set([
  'phone',
  'contact_name',
  'last_message_date',
  'email',
  'company',
  'job_title',
]);

function normalizeFieldMappings(raw: unknown) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_FIELD_MAPPINGS.map((m) => ({ ...m }));
  }

  const bySource = new Map<string, Record<string, unknown>>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const source = String((item as { source?: string }).source || '');
    const target = String((item as { target?: string }).target || '').trim();
    if (!ALLOWED_FIELD_SOURCES.has(source) || !target || !/^[a-z0-9_]+$/i.test(target)) continue;
    bySource.set(source, item as Record<string, unknown>);
  }

  return DEFAULT_FIELD_MAPPINGS.map((fallback) => {
    const existing = bySource.get(fallback.source);
    if (!existing) return { ...fallback };
    return {
      source: fallback.source,
      target: String(existing.target || fallback.target),
      enabled: existing.enabled !== false,
      ...(fallback.source === 'contact_name'
        ? { splitName: existing.splitName !== false }
        : {}),
    };
  });
}

// Helper to get external Supabase client config
function getExternalSupabaseConfig() {
  const url = Deno.env.get('EXTERNAL_SUPABASE_URL');
  const serviceKey = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    throw new Error('External Supabase not configured');
  }
  return { url: url.replace(/\/$/, ''), serviceKey };
}

// Helper to make REST API calls to external Supabase
async function externalQuery(
  table: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  options: {
    select?: string;
    filters?: Record<string, string>;
    body?: Record<string, unknown>;
    upsert?: boolean;
  } = {}
) {
  const { url, serviceKey } = getExternalSupabaseConfig();
  const endpoint = new URL(`${url}/rest/v1/${table}`);
  
  if (options.select) {
    endpoint.searchParams.set('select', options.select);
  }
  if (options.filters) {
    for (const [key, value] of Object.entries(options.filters)) {
      endpoint.searchParams.set(key, value);
    }
  }

  const headers: Record<string, string> = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
  
  if (options.upsert) {
    headers['Prefer'] = 'resolution=merge-duplicates,return=representation';
  } else if (method === 'POST' || method === 'PATCH') {
    headers['Prefer'] = 'return=representation';
  }

  const res = await fetch(endpoint.toString(), {
    method,
    headers,
    ...(options.body && { body: JSON.stringify(options.body) }),
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data, text };
}

// The user's identity comes from the validated JWT — never from the request
// body alone. When the body carries a userId it must match the token subject.
// (Previously the body userId was trusted unauthenticated, which let anyone
// with the public anon key act on any account.)

// Refresh HubSpot tokens if expired
async function refreshTokensIfNeeded(userId: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date } | null> {
  const { data } = await externalQuery('hubspot_connections', 'GET', {
    select: 'access_token,refresh_token,expires_at,status',
    filters: { user_id: `eq.${userId}` },
  });

  if (!Array.isArray(data) || data.length === 0) return null;
  const conn = data[0];
  
  if (conn.status !== 'active' || !conn.access_token || !conn.refresh_token) return null;

  const expiresAt = new Date(conn.expires_at);
  const now = new Date();
  
  // If token expires in more than 5 minutes, return existing token
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return {
      accessToken: conn.access_token,
      refreshToken: conn.refresh_token,
      expiresAt,
    };
  }

  // Refresh the token
  console.log(`Refreshing HubSpot token for user ${userId}`);
  
  const clientId = Deno.env.get('HUBSPOT_CLIENT_ID');
  const clientSecret = Deno.env.get('HUBSPOT_CLIENT_SECRET');
  
  if (!clientId || !clientSecret) {
    throw new Error('HubSpot OAuth not configured');
  }

  const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: conn.refresh_token,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    console.error('Token refresh failed:', errText);
    
    // Update status to error
    await externalQuery('hubspot_connections', 'PATCH', {
      filters: { user_id: `eq.${userId}` },
      body: { status: 'error', updated_at: new Date().toISOString() },
    });
    
    return null;
  }

  const tokens = await tokenRes.json();
  const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

  // Update tokens in database
  await externalQuery('hubspot_connections', 'PATCH', {
    filters: { user_id: `eq.${userId}` },
    body: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: newExpiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    },
  });

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: newExpiresAt,
  };
}

// Create an HMAC-signed state for OAuth (unsigned base64 was forgeable, which
// allowed linking an attacker's HubSpot portal to a victim's account).
async function createOAuthState(userId: string): Promise<string> {
  return await signStatePayload({
    userId,
    timestamp: Date.now(),
    nonce: crypto.randomUUID(),
  });
}

// Verify + decode OAuth state
async function decodeOAuthState(state: string): Promise<{ userId: string; timestamp: number } | null> {
  const decoded = await verifyStatePayload<{ userId?: string; timestamp?: number }>(state);
  if (!decoded?.userId || !decoded?.timestamp) return null;
  // Validate timestamp (10 minute expiry — the user completes HubSpot's consent screen in between)
  if (Date.now() - decoded.timestamp > 10 * 60 * 1000) {
    console.error('OAuth state expired');
    return null;
  }
  return { userId: String(decoded.userId), timestamp: Number(decoded.timestamp) };
}

type HubSpotOwner = { id: string; email?: string };

async function fetchHubSpotOwners(accessToken: string): Promise<HubSpotOwner[]> {
  const owners: HubSpotOwner[] = [];
  let after: string | undefined;

  do {
    const url = new URL(`${HUBSPOT_API_BASE}/crm/v3/owners`);
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after', after);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error('Failed to fetch HubSpot owners:', errText);
      break;
    }

    const json = await res.json();
    const results = Array.isArray(json?.results) ? json.results : [];
    for (const owner of results) {
      if (owner?.archived) continue;
      if (owner?.id != null) {
        owners.push({ id: String(owner.id), email: owner.email });
      }
    }
    after = json?.paging?.next?.after;
  } while (after);

  owners.sort((a, b) => a.id.localeCompare(b.id));
  return owners;
}

async function getUserEmailForOwnerMatch(
  userId: string,
  creatorEmail?: string | null
): Promise<string | null> {
  const normalized = creatorEmail?.trim().toLowerCase();
  if (normalized) return normalized;

  const profileRes = await externalQuery('user_profiles', 'GET', {
    select: 'email',
    filters: { user_id: `eq.${userId}` },
  });

  if (profileRes.ok && Array.isArray(profileRes.data) && profileRes.data.length > 0) {
    const email = profileRes.data[0]?.email;
    if (typeof email === 'string' && email.trim()) {
      return email.trim().toLowerCase();
    }
  }

  return null;
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, data } = await req.json();
    console.log(`hubspot-oauth action: ${action}`);

    // Every action requires a valid session. When the body carries a userId it
    // must match the authenticated token subject.
    const auth = await authenticateRequest(req, (data?.userId as string) || null);
    if (!auth.ok) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: auth.status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const authedUserId = auth.userId;

    switch (action) {
      // ===== getConnectionAndSettings =====
      case 'getConnectionAndSettings': {
        const userId = authedUserId;

        // Get connection (non-sensitive fields only)
        const connRes = await externalQuery('hubspot_connections', 'GET', {
          select: 'status,portal_id,connected_at,updated_at',
          filters: { user_id: `eq.${userId}` },
        });

        let connection = { status: 'not_connected', portal_id: null, connected_at: null };
        if (connRes.ok && Array.isArray(connRes.data) && connRes.data.length > 0) {
          connection = connRes.data[0];
        }

        // Get or create settings
        const settingsRes = await externalQuery('hubspot_integration_settings', 'GET', {
          select: '*',
          filters: { user_id: `eq.${userId}` },
        });

        let settings;
        if (settingsRes.ok && Array.isArray(settingsRes.data) && settingsRes.data.length > 0) {
          settings = {
            ...settingsRes.data[0],
            field_mappings: normalizeFieldMappings(settingsRes.data[0].field_mappings),
          };
        } else {
          // Create default settings
          const defaultSettings = {
            user_id: userId,
            auto_sync_contacts: false,
            auto_create_companies: false,
            enrich_before_create: true,
            attach_message_history: false,
            default_pipeline_id: null,
            default_stage_id: null,
            contact_owner_assignment: 'round_robin',
            round_robin_owner_index: 0,
            mask_phone_numbers: true,
            redact_media_files: true,
            data_retention_days: 90,
            field_mappings: DEFAULT_FIELD_MAPPINGS,
          };
          
          const insertRes = await externalQuery('hubspot_integration_settings', 'POST', {
            body: defaultSettings,
          });
          
          if (insertRes.ok && Array.isArray(insertRes.data) && insertRes.data.length > 0) {
            settings = insertRes.data[0];
          } else {
            settings = defaultSettings;
          }
        }

        return new Response(
          JSON.stringify({ connection, settings }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== startOAuth =====
      case 'startOAuth': {
        const userId = authedUserId;

        const clientId = Deno.env.get('HUBSPOT_CLIENT_ID');
        const redirectUri = Deno.env.get('HUBSPOT_REDIRECT_URI');

        // HubSpot will reject installs if any "required scopes" (configured in the HubSpot app)
        // are missing from the `scope` query param. This list must match what the app requires.
        const requiredScopes = [
          'crm.objects.companies.read',
          'crm.objects.companies.write',
          'crm.objects.contacts.read',
          'crm.objects.contacts.write',
          'crm.objects.deals.read',
          'crm.objects.deals.write',
          'crm.objects.owners.read',
          'crm.schemas.companies.read',
          'crm.schemas.contacts.read',
          'crm.schemas.deals.read',
          'oauth',
          'tickets',
        ];
        const allowedSet = new Set(requiredScopes);

        const rawScopes = Deno.env.get('HUBSPOT_SCOPES') || requiredScopes.join(' ');

        // Normalize scopes: accept space-delimited, comma-delimited, or URL-encoded input.
        let decodedScopes = rawScopes;
        try {
          decodedScopes = decodeURIComponent(rawScopes);
        } catch {
          // ignore decoding errors
        }

        const requestedScopes = decodedScopes
          .replace(/\+/g, ' ')
          .replace(/[\[\],]/g, ' ')
          .replace(/^scope=/i, ' ')
          .split(/\s+/)
          .filter(Boolean);

        // Only send the allowed scopes to avoid HubSpot rejecting the request.
        const finalScopes = Array.from(
          new Set([...requiredScopes, ...requestedScopes.filter((s) => allowedSet.has(s))])
        ).join(' ');

        console.log('HubSpot OAuth scopes (raw):', rawScopes);
        console.log('HubSpot OAuth scopes (final):', finalScopes);

        if (!clientId || !redirectUri) {
          return new Response(
            JSON.stringify({ error: 'HubSpot OAuth not configured' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const state = await createOAuthState(userId);
        const authUrl = new URL('https://app.hubspot.com/oauth/authorize');
        authUrl.searchParams.set('client_id', clientId);
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', finalScopes);
        authUrl.searchParams.set('state', state);
        return new Response(
          JSON.stringify({ authUrl: authUrl.toString() }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== oauthCallback =====
      case 'oauthCallback': {
        const { code, state } = data || {};
        
        if (!code || !state) {
          return new Response(
            JSON.stringify({ error: 'Missing code or state' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const stateData = await decodeOAuthState(state);
        if (!stateData) {
          return new Response(
            JSON.stringify({ error: 'Invalid or expired state' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // The connection may only be attached to the account that started the flow.
        if (stateData.userId !== authedUserId) {
          return new Response(
            JSON.stringify({ error: 'OAuth state does not belong to this account' }),
            { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const clientId = Deno.env.get('HUBSPOT_CLIENT_ID');
        const clientSecret = Deno.env.get('HUBSPOT_CLIENT_SECRET');
        const redirectUri = Deno.env.get('HUBSPOT_REDIRECT_URI');

        if (!clientId || !clientSecret || !redirectUri) {
          return new Response(
            JSON.stringify({ error: 'HubSpot OAuth not configured' }),
            { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Exchange code for tokens
        const tokenRes = await fetch('https://api.hubapi.com/oauth/v1/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          }),
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          console.error('Token exchange failed:', errText);
          return new Response(
            JSON.stringify({ error: 'Failed to exchange authorization code' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const tokens = await tokenRes.json();
        const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

        // Get portal/account info
        let portalId = null;
        try {
          const infoRes = await fetch('https://api.hubapi.com/oauth/v1/access-tokens/' + tokens.access_token);
          if (infoRes.ok) {
            const info = await infoRes.json();
            portalId = info.hub_id?.toString() || null;
          }
        } catch (e) {
          console.error('Failed to get portal info:', e);
        }

        // Upsert connection
        const connectionData = {
          user_id: stateData.userId,
          portal_id: portalId,
          status: 'active',
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: expiresAt.toISOString(),
          scopes: tokens.scope?.split(' ') || [],
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };

        // Try update first, then insert if not exists
        const updateRes = await externalQuery('hubspot_connections', 'PATCH', {
          filters: { user_id: `eq.${stateData.userId}` },
          body: connectionData,
        });

        if (!updateRes.ok || (Array.isArray(updateRes.data) && updateRes.data.length === 0)) {
          await externalQuery('hubspot_connections', 'POST', {
            body: connectionData,
          });
        }

        return new Response(
          JSON.stringify({ success: true, portalId }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== testConnection =====
      case 'testConnection': {
        const userId = authedUserId;

        const tokenData = await refreshTokensIfNeeded(userId);
        if (!tokenData) {
          return new Response(
            JSON.stringify({ error: 'Not connected or token refresh failed', connected: false }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Test with a lightweight call
        const testRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/objects/contacts?limit=1`, {
          headers: {
            Authorization: `Bearer ${tokenData.accessToken}`,
            'Content-Type': 'application/json',
          },
        });

        if (testRes.ok) {
          // Update status to active
          await externalQuery('hubspot_connections', 'PATCH', {
            filters: { user_id: `eq.${userId}` },
            body: { status: 'active', updated_at: new Date().toISOString() },
          });

          return new Response(
            JSON.stringify({ success: true, connected: true }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        } else {
          const errText = await testRes.text();
          console.error('Test connection failed:', errText);
          
          await externalQuery('hubspot_connections', 'PATCH', {
            filters: { user_id: `eq.${userId}` },
            body: { status: 'error', updated_at: new Date().toISOString() },
          });

          return new Response(
            JSON.stringify({ success: false, connected: false, error: 'HubSpot API call failed' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }
      }

      // ===== disconnect =====
      case 'disconnect': {
        const userId = authedUserId;

        await externalQuery('hubspot_connections', 'PATCH', {
          filters: { user_id: `eq.${userId}` },
          body: {
            status: 'revoked',
            access_token: null,
            refresh_token: null,
            expires_at: null,
            updated_at: new Date().toISOString(),
          },
        });

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== updateSettings =====
      case 'updateSettings': {
        const userId = authedUserId;

        const settings = data?.settings;
        if (!settings || typeof settings !== 'object') {
          return new Response(
            JSON.stringify({ error: 'Settings object required' }),
            { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // Whitelist allowed fields
        const allowedFields = [
          'auto_sync_contacts',
          'auto_create_companies',
          'enrich_before_create',
          'attach_message_history',
          'default_pipeline_id',
          'default_stage_id',
          'contact_owner_assignment',
          'round_robin_owner_index',
          'mask_phone_numbers',
          'redact_media_files',
          'data_retention_days',
          'field_mappings',
        ];

        const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
        for (const field of allowedFields) {
          if (field in settings) {
            if (field === 'field_mappings') {
              updateData[field] = normalizeFieldMappings(settings[field]);
            } else {
              updateData[field] = settings[field];
            }
          }
        }

        const updateRes = await externalQuery('hubspot_integration_settings', 'PATCH', {
          filters: { user_id: `eq.${userId}` },
          body: updateData,
        });

        if (!updateRes.ok || (Array.isArray(updateRes.data) && updateRes.data.length === 0)) {
          // Row doesn't exist, create it
          await externalQuery('hubspot_integration_settings', 'POST', {
            body: { user_id: userId, ...updateData },
          });
        }

        // Keep workspace_settings in sync when privacy fields change from Integrations
        const workspacePatch: Record<string, unknown> = { updated_at: new Date().toISOString() };
        if ('mask_phone_numbers' in settings) {
          workspacePatch.mask_phone = settings.mask_phone_numbers;
        }
        if ('redact_media_files' in settings) {
          workspacePatch.mask_media = settings.redact_media_files;
        }
        if ('data_retention_days' in settings) {
          workspacePatch.retention_days = settings.data_retention_days;
        }
        if (Object.keys(workspacePatch).length > 1) {
          const wsRes = await externalQuery('workspace_settings', 'PATCH', {
            filters: { user_id: `eq.${userId}` },
            body: workspacePatch,
          });
          if (!wsRes.ok || (Array.isArray(wsRes.data) && wsRes.data.length === 0)) {
            await externalQuery('workspace_settings', 'POST', {
              body: { user_id: userId, ...workspacePatch },
            });
          }
        }

        return new Response(
          JSON.stringify({ success: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== getConnectionStatus (for extension) =====
      case 'getConnectionStatus': {
        const userId = authedUserId;

        const connRes = await externalQuery('hubspot_connections', 'GET', {
          select: 'status,portal_id,connected_at',
          filters: { user_id: `eq.${userId}` },
        });

        let status = 'not_connected';
        let portalId = null;
        let connectedAt = null;
        if (connRes.ok && Array.isArray(connRes.data) && connRes.data.length > 0) {
          status = connRes.data[0].status;
          portalId = connRes.data[0].portal_id;
          connectedAt = connRes.data[0].connected_at;
        }

        return new Response(
          JSON.stringify({ status, portalId, connectedAt, connected: status === 'active' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== getSyncSettings (for Chrome extension) =====
      // Extension calls this with { userId } to get the current sync preferences
      case 'getSyncSettings': {
        const userId = authedUserId;

        const settingsRes = await externalQuery('hubspot_integration_settings', 'GET', {
          select: 'auto_sync_contacts,auto_create_companies,enrich_before_create,attach_message_history,contact_owner_assignment,default_pipeline_id,default_stage_id,mask_phone_numbers,redact_media_files,data_retention_days,field_mappings',
          filters: { user_id: `eq.${userId}` },
        });

        let settings = {
          auto_sync_contacts: false,
          auto_create_companies: false,
          enrich_before_create: true,
          attach_message_history: false,
          contact_owner_assignment: 'round_robin',
          default_pipeline_id: null,
          default_stage_id: null,
          mask_phone_numbers: true,
          redact_media_files: true,
          data_retention_days: 90,
          field_mappings: DEFAULT_FIELD_MAPPINGS,
        };

        if (settingsRes.ok && Array.isArray(settingsRes.data) && settingsRes.data.length > 0) {
          settings = {
            ...settings,
            ...settingsRes.data[0],
            field_mappings: normalizeFieldMappings(settingsRes.data[0].field_mappings),
          };
        }

        return new Response(
          JSON.stringify({ success: true, settings }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== resolveContactOwner (for extension contact creation) =====
      case 'resolveContactOwner': {
        const userId = authedUserId;

        const settingsRes = await externalQuery('hubspot_integration_settings', 'GET', {
          select: 'contact_owner_assignment,round_robin_owner_index',
          filters: { user_id: `eq.${userId}` },
        });

        let assignment = 'round_robin';
        let roundRobinIndex = 0;
        if (settingsRes.ok && Array.isArray(settingsRes.data) && settingsRes.data.length > 0) {
          assignment = settingsRes.data[0].contact_owner_assignment || 'round_robin';
          roundRobinIndex = Number(settingsRes.data[0].round_robin_owner_index) || 0;
        }

        if (assignment === 'none') {
          return new Response(
            JSON.stringify({ success: true, ownerId: null, mode: 'none' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const tokenData = await refreshTokensIfNeeded(userId);
        if (!tokenData) {
          return new Response(
            JSON.stringify({ success: true, ownerId: null, mode: assignment, warning: 'HubSpot not connected' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const owners = await fetchHubSpotOwners(tokenData.accessToken);
        if (owners.length === 0) {
          return new Response(
            JSON.stringify({ success: true, ownerId: null, mode: assignment, warning: 'No HubSpot owners found' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        if (assignment === 'creator') {
          const email = await getUserEmailForOwnerMatch(userId, data?.creatorEmail as string | undefined);
          const match = email
            ? owners.find((o) => o.email?.toLowerCase() === email)
            : null;

          return new Response(
            JSON.stringify({
              success: true,
              ownerId: match?.id ?? null,
              mode: 'creator',
              warning: match ? undefined : 'No HubSpot owner matched your account email',
            }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        // round_robin
        const safeIndex = roundRobinIndex >= owners.length ? 0 : (roundRobinIndex < 0 ? 0 : roundRobinIndex);
        const selectedOwner = owners[safeIndex];
        const nextIndex = (safeIndex + 1) % owners.length;

        const indexUpdate = await externalQuery('hubspot_integration_settings', 'PATCH', {
          filters: { user_id: `eq.${userId}` },
          body: {
            round_robin_owner_index: nextIndex,
            updated_at: new Date().toISOString(),
          },
        });

        if (!indexUpdate.ok || (Array.isArray(indexUpdate.data) && indexUpdate.data.length === 0)) {
          await externalQuery('hubspot_integration_settings', 'POST', {
            body: {
              user_id: userId,
              contact_owner_assignment: 'round_robin',
              round_robin_owner_index: nextIndex,
              auto_sync_contacts: false,
              enrich_before_create: true,
              mask_phone_numbers: true,
              redact_media_files: true,
              data_retention_days: 90,
            },
          });
        }

        return new Response(
          JSON.stringify({
            success: true,
            ownerId: selectedOwner.id,
            mode: 'round_robin',
          }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== getDealPipelines (for dashboard + extension deal forms) =====
      case 'getDealPipelines': {
        const userId = authedUserId;

        const tokenData = await refreshTokensIfNeeded(userId);
        if (!tokenData) {
          return new Response(
            JSON.stringify({ success: true, pipelines: [], warning: 'HubSpot not connected' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const pipelinesRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/pipelines/deals`, {
          headers: { Authorization: `Bearer ${tokenData.accessToken}` },
        });

        if (!pipelinesRes.ok) {
          const errText = await pipelinesRes.text();
          console.error('Failed to fetch deal pipelines:', errText);
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to fetch deal pipelines', pipelines: [] }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const pipelinesJson = await pipelinesRes.json();
        const results = Array.isArray(pipelinesJson?.results) ? pipelinesJson.results : [];
        const pipelines = results.map((p: { id: string; label: string; stages?: Array<{ id: string; label: string; displayOrder?: number }> }) => ({
          id: String(p.id),
          label: p.label,
          stages: (p.stages || [])
            .map((s) => ({
              id: String(s.id),
              label: s.label,
              displayOrder: s.displayOrder ?? 0,
            }))
            .sort((a, b) => a.displayOrder - b.displayOrder),
        }));

        return new Response(
          JSON.stringify({ success: true, pipelines }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== getContactProperties (for field mapping UI) =====
      case 'getContactProperties': {
        const userId = authedUserId;

        const tokenData = await refreshTokensIfNeeded(userId);
        if (!tokenData) {
          return new Response(
            JSON.stringify({ success: true, properties: [], warning: 'HubSpot not connected' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const propsRes = await fetch(`${HUBSPOT_API_BASE}/crm/v3/properties/contacts`, {
          headers: { Authorization: `Bearer ${tokenData.accessToken}` },
        });

        if (!propsRes.ok) {
          const errText = await propsRes.text();
          console.error('Failed to fetch contact properties:', errText);
          return new Response(
            JSON.stringify({ success: false, error: 'Failed to fetch contact properties', properties: [] }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const propsJson = await propsRes.json();
        const results = Array.isArray(propsJson?.results) ? propsJson.results : [];
        const properties = results
          .filter((p: { name?: string; hidden?: boolean; calculated?: boolean }) =>
            p.name && !p.hidden && !p.calculated
          )
          .map((p: { name: string; label?: string }) => ({
            name: String(p.name),
            label: String(p.label || p.name),
          }))
          .sort((a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label));

        return new Response(
          JSON.stringify({ success: true, properties }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // ===== getOwners (HubSpot users/owners list) =====
      case 'getOwners': {
        const userId = authedUserId;

        const tokenData = await refreshTokensIfNeeded(userId);
        if (!tokenData) {
          return new Response(
            JSON.stringify({ success: true, owners: [], warning: 'HubSpot not connected' }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
          );
        }

        const owners: Array<{ id: string; email: string; firstName: string; lastName: string; fullName: string }> = [];
        let after: string | undefined = undefined;
        try {
          for (let i = 0; i < 10; i++) {
            const url = new URL(`${HUBSPOT_API_BASE}/crm/v3/owners`);
            url.searchParams.set('limit', '100');
            url.searchParams.set('archived', 'false');
            if (after) url.searchParams.set('after', after);
            const res = await fetch(url.toString(), {
              headers: { Authorization: `Bearer ${tokenData.accessToken}` },
            });
            if (!res.ok) {
              const errText = await res.text();
              console.error(`Failed to fetch owners [${res.status}]:`, errText);
              break;
            }

            const json = await res.json();
            const results = Array.isArray(json?.results) ? json.results : [];
            for (const o of results) {
              const firstName = String(o.firstName || '').trim();
              const lastName = String(o.lastName || '').trim();
              const email = String(o.email || '').trim();
              const fullName = [firstName, lastName].filter(Boolean).join(' ') || email || `Owner ${o.id}`;
              owners.push({ id: String(o.id), email, firstName, lastName, fullName });
            }
            after = json?.paging?.next?.after;
            if (!after) break;
          }
        } catch (err) {
          console.error('Error fetching owners:', err);
        }

        owners.sort((a, b) => a.fullName.localeCompare(b.fullName));

        return new Response(
          JSON.stringify({ success: true, owners }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }



      default:
        return new Response(
          JSON.stringify({ error: `Unknown action: ${action}` }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Error in hubspot-oauth function:', errorMessage);
    return new Response(
      JSON.stringify({ error: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
