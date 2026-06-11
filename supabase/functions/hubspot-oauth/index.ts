// Supabase Edge Function: hubspot-oauth
//
// Per-user HubSpot OAuth: connect, store tokens, report status, disconnect.
// Tokens are written to the EXTERNAL project's public.hubspot_connections so the
// `hubspot` function can use them per user. This is the piece that makes the
// integration multi-tenant — each WhatSync user connects their own HubSpot.
//
// REQUIRED SECRETS (edge project: dizxmubrpwwfrjepcttb)
//   EXTERNAL_SUPABASE_URL               https://ogsvchujqpayuckxuwdf.supabase.co
//   EXTERNAL_SUPABASE_SERVICE_ROLE_KEY  ogsvc service_role key (the rotated one)
//   HUBSPOT_CLIENT_ID                   HubSpot public app client id
//   HUBSPOT_CLIENT_SECRET               HubSpot public app client secret
//   HUBSPOT_REDIRECT_URI                this function's public URL (see runbook),
//                                       e.g. https://dizxmubrpwwfrjepcttb.supabase.co/functions/v1/hubspot-oauth
//   HUBSPOT_SCOPES                      space-separated, must match the app exactly
//   APP_DASHBOARD_URL                   where to send the browser after connect,
//                                       e.g. https://whatsync.io/settings
//
// FLOW
//   1. Dashboard (authenticated) calls action:"authorize" -> returns a HubSpot
//      authorize URL carrying a random `state` we mapped to the user.
//   2. User approves on HubSpot; HubSpot redirects (GET) to this function with
//      ?code=&state=. We exchange the code, fetch the portal id, store tokens
//      for the mapped user, delete the state, and 302 the browser back to the
//      dashboard.
//   3. action:"status" / "disconnect" manage the connection for the user.

const EXTERNAL_SUPABASE_URL = Deno.env.get('EXTERNAL_SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') ?? '';
const HUBSPOT_CLIENT_ID = Deno.env.get('HUBSPOT_CLIENT_ID') ?? '';
const HUBSPOT_CLIENT_SECRET = Deno.env.get('HUBSPOT_CLIENT_SECRET') ?? '';
const HUBSPOT_REDIRECT_URI = Deno.env.get('HUBSPOT_REDIRECT_URI') ?? '';
const HUBSPOT_SCOPES = Deno.env.get('HUBSPOT_SCOPES') ??
  'oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.companies.write crm.objects.deals.read crm.objects.deals.write crm.objects.owners.read tickets';
const APP_DASHBOARD_URL = Deno.env.get('APP_DASHBOARD_URL') ?? 'https://whatsync.io/settings';

const HUBSPOT_AUTHORIZE = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN = 'https://api.hubapi.com/oauth/v1/token';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url, ...CORS_HEADERS } });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// External Supabase (service role)
// ---------------------------------------------------------------------------

async function db(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${EXTERNAL_SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function getAuthenticatedUserId(req: Request): Promise<string> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new HttpError(401, 'Missing Authorization header');
  const res = await fetch(`${EXTERNAL_SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new HttpError(401, 'Invalid or expired session');
  const user = await res.json();
  if (!user?.id) throw new HttpError(401, 'Invalid session');
  return user.id as string;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function startAuthorize(userId: string, redirectTo: string | null): Promise<unknown> {
  if (!HUBSPOT_CLIENT_ID || !HUBSPOT_REDIRECT_URI) {
    throw new HttpError(500, 'HubSpot OAuth is not configured');
  }
  const state = crypto.randomUUID();
  const insert = await db('hubspot_oauth_states', {
    method: 'POST',
    body: JSON.stringify({ state, user_id: userId, redirect_to: redirectTo ?? null }),
  });
  if (!insert.ok) {
    const body = await insert.text().catch(() => '');
    console.error('[hubspot-oauth] state insert failed', insert.status, body.slice(0, 200));
    throw new HttpError(500, `Could not start OAuth (db ${insert.status})`);
  }

  const url = `${HUBSPOT_AUTHORIZE}?client_id=${encodeURIComponent(HUBSPOT_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(HUBSPOT_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(HUBSPOT_SCOPES)}` +
    `&state=${encodeURIComponent(state)}`;
  return { url };
}

async function handleCallback(code: string, state: string): Promise<Response> {
  const fail = (reason: string) =>
    redirect(`${APP_DASHBOARD_URL}?hubspot=error&reason=${encodeURIComponent(reason)}`);

  if (!code || !state) return fail('missing_code_or_state');

  // Resolve the state -> user mapping, then consume it.
  const stateRes = await db(`hubspot_oauth_states?state=eq.${encodeURIComponent(state)}&select=user_id,redirect_to&limit=1`);
  if (!stateRes.ok) return fail('state_lookup_failed');
  const stateRows = await stateRes.json();
  const stateRow = stateRows[0];
  if (!stateRow) return fail('invalid_state');
  const userId = stateRow.user_id as string;
  await db(`hubspot_oauth_states?state=eq.${encodeURIComponent(state)}`, { method: 'DELETE' });

  // Exchange the code for tokens.
  const tokenRes = await fetch(HUBSPOT_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      redirect_uri: HUBSPOT_REDIRECT_URI,
      code,
    }),
  });
  if (!tokenRes.ok) {
    console.error('[hubspot-oauth] token exchange failed', tokenRes.status, (await tokenRes.text()).slice(0, 200));
    return fail('token_exchange_failed');
  }
  const tokens = await tokenRes.json();

  // Identify the portal so we can show it and detect re-connects.
  let portalId: string | null = null;
  let scopes: string[] = [];
  try {
    const info = await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${tokens.access_token}`);
    if (info.ok) {
      const meta = await info.json();
      portalId = meta.hub_id != null ? String(meta.hub_id) : null;
      scopes = Array.isArray(meta.scopes) ? meta.scopes : [];
    }
  } catch (_) { /* non-fatal */ }

  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 1800) * 1000).toISOString();
  const row = {
    user_id: userId,
    portal_id: portalId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    scopes,
    status: 'connected',
    connected_at: new Date().toISOString(),
  };

  // Upsert on user_id (unique). PostgREST upsert via Prefer: resolution=merge-duplicates.
  const upsert = await db('hubspot_connections?on_conflict=user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!upsert.ok) {
    console.error('[hubspot-oauth] connection upsert failed', upsert.status, (await upsert.text()).slice(0, 200));
    return fail('store_failed');
  }

  const dest = stateRow.redirect_to || APP_DASHBOARD_URL;
  return redirect(`${dest}${dest.includes('?') ? '&' : '?'}hubspot=connected`);
}

async function getStatus(userId: string): Promise<unknown> {
  const res = await db(`hubspot_connections?user_id=eq.${userId}&select=portal_id,status,connected_at,expires_at,scopes&limit=1`);
  if (!res.ok) throw new HttpError(500, `Could not load connection (db ${res.status})`);
  const row = (await res.json())[0];
  if (!row || row.status !== 'connected') {
    return { status: 'not_connected' };
  }
  return {
    status: 'connected',
    portalId: row.portal_id,
    portal_id: row.portal_id,
    connectedAt: row.connected_at,
    connected_at: row.connected_at,
    scopes: row.scopes ?? [],
  };
}

async function disconnect(userId: string): Promise<unknown> {
  const res = await db(`hubspot_connections?user_id=eq.${userId}`, { method: 'DELETE' });
  if (!res.ok) throw new HttpError(500, `Could not disconnect (db ${res.status})`);
  return { status: 'not_connected' };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (!EXTERNAL_SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ error: 'Service is not configured' }, 500);
  }

  const url = new URL(req.url);

  // OAuth redirect from HubSpot: GET with ?code=&state= (no auth header).
  if (req.method === 'GET' && (url.searchParams.has('code') || url.searchParams.has('error'))) {
    if (url.searchParams.has('error')) {
      return redirect(`${APP_DASHBOARD_URL}?hubspot=error&reason=${encodeURIComponent(url.searchParams.get('error') || 'denied')}`);
    }
    try {
      return await handleCallback(url.searchParams.get('code') || '', url.searchParams.get('state') || '');
    } catch (e) {
      console.error('[hubspot-oauth] callback error', e);
      return redirect(`${APP_DASHBOARD_URL}?hubspot=error&reason=callback_exception`);
    }
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { action, data } = await req.json().catch(() => ({}));
    const userId = await getAuthenticatedUserId(req); // all POST actions require auth

    switch (action) {
      case 'authorize':
        return json(await startAuthorize(userId, data?.redirectTo ?? null));
      case 'status':
      case 'getConnection':
        return json(await getStatus(userId));
      case 'disconnect':
        return json(await disconnect(userId));
      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    console.error('[hubspot-oauth] error', error);
    return json({ error: 'Internal error' }, 500);
  }
});
