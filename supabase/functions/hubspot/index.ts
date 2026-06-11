// Supabase Edge Function: hubspot
//
// Multi-tenant HubSpot proxy for the WhatSync extension.
//
// SECURITY MODEL
//   - Every request must carry a Supabase JWT (Authorization: Bearer <jwt>)
//     issued by the EXTERNAL Supabase project (the auth + data project).
//   - The user is derived from the JWT — never from the request payload.
//   - Each user's HubSpot OAuth tokens live in public.hubspot_connections and
//     are read with the service-role key. Tokens are refreshed automatically
//     when they are about to expire.
//
// REQUIRED SECRETS (set on this project: Dashboard → Edge Functions → Secrets)
//   EXTERNAL_SUPABASE_URL               URL of the auth/data Supabase project
//   EXTERNAL_SUPABASE_SERVICE_ROLE_KEY  service-role key of that project
//   HUBSPOT_CLIENT_ID                   HubSpot OAuth app client id
//   HUBSPOT_CLIENT_SECRET               HubSpot OAuth app client secret
//
// DEPLOY
//   supabase functions deploy hubspot --project-ref <edge-project-ref>

const EXTERNAL_SUPABASE_URL = Deno.env.get('EXTERNAL_SUPABASE_URL') ?? '';
const SERVICE_ROLE_KEY = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') ?? '';
const HUBSPOT_CLIENT_ID = Deno.env.get('HUBSPOT_CLIENT_ID') ?? '';
const HUBSPOT_CLIENT_SECRET = Deno.env.get('HUBSPOT_CLIENT_SECRET') ?? '';

const HUBSPOT_API = 'https://api.hubapi.com';
const TOKEN_REFRESH_LEEWAY_MS = 2 * 60 * 1000; // refresh when <2 min left

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// External Supabase helpers (auth + database, via service role)
// ---------------------------------------------------------------------------

async function getAuthenticatedUserId(req: Request): Promise<string> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new HttpError(401, 'Missing Authorization header');

  const res = await fetch(`${EXTERNAL_SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new HttpError(401, 'Invalid or expired session');
  const user = await res.json();
  if (!user?.id) throw new HttpError(401, 'Invalid session');
  return user.id as string;
}

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

// ---------------------------------------------------------------------------
// Per-user HubSpot token management
// ---------------------------------------------------------------------------

interface HubSpotConnection {
  id: string;
  user_id: string;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  status: string;
}

async function getHubSpotToken(userId: string): Promise<string> {
  const res = await db(
    `hubspot_connections?user_id=eq.${userId}&select=id,user_id,access_token,refresh_token,expires_at,status&limit=1`,
  );
  if (!res.ok) {
    // Surface WHY so a misconfigured secret is obvious from the response/logs:
    //   db 401  -> EXTERNAL_SUPABASE_SERVICE_ROLE_KEY is wrong/not the service_role key
    //   db 404  -> EXTERNAL_SUPABASE_URL points at the wrong project
    const body = await res.text().catch(() => '');
    console.error('[hubspot] hubspot_connections read failed', res.status, body.slice(0, 200));
    throw new HttpError(500, `Failed to load HubSpot connection (db ${res.status})`);
  }
  const rows: HubSpotConnection[] = await res.json();
  const conn = rows[0];

  if (!conn || conn.status === 'not_connected' || !conn.access_token) {
    throw new HttpError(403, 'HubSpot account is not connected');
  }

  const expiresAt = conn.expires_at ? new Date(conn.expires_at).getTime() : 0;
  if (expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) {
    return conn.access_token;
  }

  // Token expired (or about to) — refresh it
  if (!conn.refresh_token) {
    throw new HttpError(403, 'HubSpot session expired — please reconnect your account');
  }
  const refreshRes = await fetch(`${HUBSPOT_API}/oauth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: HUBSPOT_CLIENT_ID,
      client_secret: HUBSPOT_CLIENT_SECRET,
      refresh_token: conn.refresh_token,
    }),
  });
  if (!refreshRes.ok) {
    // Mark the connection so the dashboard can prompt a reconnect
    await db(`hubspot_connections?id=eq.${conn.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'expired' }),
    });
    throw new HttpError(403, 'HubSpot session expired — please reconnect your account');
  }
  const tokens = await refreshRes.json();
  const newExpiresAt = new Date(Date.now() + (tokens.expires_in ?? 1800) * 1000).toISOString();
  await db(`hubspot_connections?id=eq.${conn.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? conn.refresh_token,
      expires_at: newExpiresAt,
      status: 'connected',
    }),
  });
  return tokens.access_token as string;
}

// ---------------------------------------------------------------------------
// HubSpot API helper
// ---------------------------------------------------------------------------

async function hubspot(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${HUBSPOT_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { raw: text };
  }
  if (!res.ok) {
    const message =
      (parsed as { message?: string })?.message ?? `HubSpot API error (${res.status})`;
    throw new HttpError(res.status, message);
  }
  return parsed;
}

// Fetch objects associated with a contact (tickets, deals, notes, tasks)
async function getContactAssociations(
  token: string,
  contactId: string,
  objectType: string,
  properties: string[],
): Promise<{ results: unknown[] }> {
  const assoc = (await hubspot(
    token,
    'GET',
    `/crm/v4/objects/contacts/${contactId}/associations/${objectType}`,
  )) as { results?: Array<{ toObjectId: number | string }> };
  const ids = (assoc.results ?? []).map((r) => String(r.toObjectId));
  if (ids.length === 0) return { results: [] };

  const batch = (await hubspot(token, 'POST', `/crm/v3/objects/${objectType}/batch/read`, {
    inputs: ids.map((id) => ({ id })),
    properties,
  })) as { results?: unknown[] };
  return { results: batch.results ?? [] };
}

// ---------------------------------------------------------------------------
// Activity logging into the external database
// ---------------------------------------------------------------------------

async function insertActivityLog(userId: string, row: Record<string, unknown>): Promise<unknown> {
  const res = await db('hubspot_contact_logs', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ ...row, user_id: userId }),
  });
  if (!res.ok) {
    throw new HttpError(500, `Failed to write activity log (${res.status})`);
  }
  const rows = await res.json();
  return { success: true, log: rows[0] ?? null };
}

function buildLogRow(
  activityType: string,
  objectType: string,
  title: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    activity_type: activityType,
    hubspot_object_type: objectType,
    hubspot_object_id: data.objectId ?? data.noteId ?? data.ticketId ?? data.taskId ?? data.dealId ?? null,
    hubspot_contact_id: data.hubspotContactId ?? data.contactId ?? null,
    phone_number: data.phoneNumber ?? null,
    first_name: data.firstName ?? null,
    last_name: data.lastName ?? null,
    email: data.email ?? null,
    company: data.company ?? null,
    job_title: data.jobTitle ?? null,
    title,
    description: data.description ?? null,
    metadata: data.metadata ?? {},
  };
}

// ---------------------------------------------------------------------------
// Sidebar field preferences
// ---------------------------------------------------------------------------

async function getSidebarFields(userId: string): Promise<unknown> {
  const [catalogRes, prefsRes] = await Promise.all([
    db('sidebar_fields?select=field_key,field_label,field_type,icon,is_locked,sort_order&order=sort_order.asc'),
    db(`hubspot_sidebar_fields?user_id=eq.${userId}&select=field_key,field_type,is_enabled`),
  ]);
  if (!catalogRes.ok || !prefsRes.ok) {
    throw new HttpError(500, 'Failed to load sidebar field configuration');
  }
  const catalog = await catalogRes.json();
  const prefs = await prefsRes.json();
  const prefMap = new Map(prefs.map((p: { field_key: string; is_enabled: boolean }) => [p.field_key, p.is_enabled]));

  const withEnabled = catalog.map((f: { field_key: string; is_locked: boolean; field_type: string }) => ({
    ...f,
    is_enabled: f.is_locked ? true : prefMap.get(f.field_key) ?? true,
  }));

  return {
    contactFields: withEnabled.filter((f: { field_type: string }) => f.field_type === 'contact_info'),
    actionFields: withEnabled.filter((f: { field_type: string }) => f.field_type === 'action'),
  };
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

const TICKET_PROPERTIES = ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'createdate'];
const DEAL_PROPERTIES = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'createdate'];
const TASK_PROPERTIES = ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_timestamp'];
const NOTE_PROPERTIES = ['hs_note_body', 'hs_createdate', 'hs_lastmodifieddate'];

async function handleAction(
  action: string,
  data: Record<string, unknown>,
  userId: string,
): Promise<unknown> {
  // Pure-database actions don't need a HubSpot token
  switch (action) {
    case 'getSidebarFields':
      return getSidebarFields(userId);
    case 'logContactCreation':
      return insertActivityLog(userId, buildLogRow('contact_created', 'contact', String(data.title ?? 'Contact created'), data));
    case 'logNoteCreation':
      return insertActivityLog(userId, buildLogRow('note_created', 'note', String(data.title ?? 'Note added'), {
        ...data,
        metadata: { noteText: data.noteText ?? null, noteHtml: data.noteHtml ?? null },
        objectId: data.noteId ?? null,
      }));
    case 'logTicketCreation':
      return insertActivityLog(userId, buildLogRow('ticket_created', 'ticket', String(data.title ?? 'Ticket created'), data));
    case 'logTaskCreation':
      return insertActivityLog(userId, buildLogRow('task_created', 'task', String(data.title ?? 'Task created'), data));
    case 'logDealCreation':
      return insertActivityLog(userId, buildLogRow('deal_created', 'deal', String(data.title ?? 'Deal created'), data));
  }

  const token = await getHubSpotToken(userId);

  switch (action) {
    // ----- Contacts -----
    case 'createContact':
      return hubspot(token, 'POST', '/crm/v3/objects/contacts', {
        properties: (data.properties as Record<string, unknown>) ?? data,
      });

    case 'getContact': {
      const { contactId, properties = [] } = data as { contactId?: string; properties?: string[] };
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      const qs = properties.length ? `?properties=${properties.join(',')}` : '';
      return hubspot(token, 'GET', `/crm/v3/objects/contacts/${contactId}${qs}`);
    }

    case 'getContacts': {
      const { limit = 100, properties = [], associations = [] } = data as {
        limit?: number;
        properties?: string[];
        associations?: string[];
      };
      let qs = `?limit=${Math.min(Number(limit) || 100, 100)}`;
      if (properties.length) qs += `&properties=${properties.join(',')}`;
      if (associations.length) qs += `&associations=${associations.join(',')}`;
      return hubspot(token, 'GET', `/crm/v3/objects/contacts${qs}`);
    }

    case 'searchContacts': {
      const searchRequest = data.searchRequest;
      if (!searchRequest) throw new HttpError(400, 'Missing required field: searchRequest');
      return hubspot(token, 'POST', '/crm/v3/objects/contacts/search', searchRequest);
    }

    // ----- Companies -----
    case 'getCompany': {
      const { companyId } = data as { companyId?: string };
      if (!companyId) throw new HttpError(400, 'Missing required field: companyId');
      return hubspot(token, 'GET', `/crm/v3/objects/companies/${companyId}`);
    }

    case 'createCompany':
      return hubspot(token, 'POST', '/crm/v3/objects/companies', {
        properties: (data.properties as Record<string, unknown>) ?? data,
      });

    // ----- Notes -----
    case 'createNote': {
      const { contactId, note, noteBody, body, timestamp } = data as Record<string, unknown>;
      const noteText = String(note ?? noteBody ?? body ?? '').trim();
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      if (!noteText) throw new HttpError(400, 'Missing required field: note text');
      const result = await hubspot(token, 'POST', '/crm/v3/objects/notes', {
        properties: {
          hs_note_body: noteText,
          hs_timestamp: timestamp ?? Date.now(),
        },
        associations: [
          {
            to: { id: String(contactId) },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }], // note → contact
          },
        ],
      });
      return { success: true, data: result };
    }

    case 'getContactNotes': {
      const contactId = String(data.hubspotContactId ?? data.contactId ?? '');
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      return getContactAssociations(token, contactId, 'notes', NOTE_PROPERTIES);
    }

    // ----- Tickets -----
    case 'getTickets':
    case 'getAllTickets': {
      const contactId = data.contactId ? String(data.contactId) : null;
      if (contactId && action === 'getTickets') {
        return getContactAssociations(token, contactId, 'tickets', TICKET_PROPERTIES);
      }
      return hubspot(token, 'GET', `/crm/v3/objects/tickets?limit=100&properties=${TICKET_PROPERTIES.join(',')}`);
    }

    case 'searchTickets': {
      const { searchTerm, contactId } = data as { searchTerm?: string; contactId?: string };
      if (contactId) {
        return getContactAssociations(token, String(contactId), 'tickets', TICKET_PROPERTIES);
      }
      const searchRequest: Record<string, unknown> = {
        properties: TICKET_PROPERTIES,
        limit: 50,
      };
      if (searchTerm && searchTerm.trim()) {
        searchRequest.query = searchTerm.trim();
      }
      return hubspot(token, 'POST', '/crm/v3/objects/tickets/search', searchRequest);
    }

    case 'createTicket': {
      const properties = (data.properties as Record<string, unknown>) ?? data;
      const contactId = data.contactId ? String(data.contactId) : null;
      const payload: Record<string, unknown> = { properties };
      if (contactId) {
        payload.associations = [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 16 }], // ticket → contact
          },
        ];
      }
      return hubspot(token, 'POST', '/crm/v3/objects/tickets', payload);
    }

    case 'associateTickets':
    case 'disassociateTickets': {
      const contactId = String(data.contactId ?? '');
      const ticketIds = (data.ticketIds as Array<string | number>) ?? [];
      if (!contactId || ticketIds.length === 0) {
        throw new HttpError(400, 'Missing required fields: contactId, ticketIds');
      }
      const method = action === 'associateTickets' ? 'PUT' : 'DELETE';
      for (const ticketId of ticketIds) {
        const path = `/crm/v4/objects/contacts/${contactId}/associations/${
          method === 'PUT' ? 'default/' : ''
        }tickets/${ticketId}`;
        await hubspot(token, method, path, method === 'PUT' ? undefined : undefined);
      }
      return { success: true };
    }

    // ----- Deals -----
    case 'getDeals': {
      const contactId = data.contactId ? String(data.contactId) : null;
      if (contactId) {
        return getContactAssociations(token, contactId, 'deals', DEAL_PROPERTIES);
      }
      return hubspot(token, 'GET', `/crm/v3/objects/deals?limit=100&properties=${DEAL_PROPERTIES.join(',')}`);
    }

    // ----- Tasks -----
    case 'createTask': {
      const raw = (data.properties as Record<string, unknown>) ?? data;
      const contactId = data.contactId ? String(data.contactId) : null;
      const payload: Record<string, unknown> = { properties: raw };
      if (contactId) {
        payload.associations = [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }], // task → contact
          },
        ];
      }
      return hubspot(token, 'POST', '/crm/v3/objects/tasks', payload);
    }

    case 'getContactTasks': {
      const contactId = String(data.hubspotContactId ?? data.contactId ?? '');
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      return getContactAssociations(token, contactId, 'tasks', TASK_PROPERTIES);
    }

    // ----- Owners -----
    case 'getOwners':
      return hubspot(token, 'GET', '/crm/v3/owners?limit=100');

    default:
      throw new HttpError(400, `Unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!EXTERNAL_SUPABASE_URL || !SERVICE_ROLE_KEY) {
    console.error('Edge function misconfigured: EXTERNAL_SUPABASE_URL / SERVICE_ROLE_KEY missing');
    return json({ error: 'Service is not configured' }, 500);
  }

  try {
    const { action, data } = await req.json().catch(() => ({}));
    if (!action || typeof action !== 'string') {
      return json({ error: 'Missing required field: action' }, 400);
    }

    // Identity comes from the JWT only — payload userId values are ignored.
    const userId = await getAuthenticatedUserId(req);

    const result = await handleAction(action, (data as Record<string, unknown>) ?? {}, userId);
    return json(result ?? { success: true });
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.message }, error.status);
    }
    console.error('Edge function error:', error);
    return json({ error: 'Internal error' }, 500);
  }
});
