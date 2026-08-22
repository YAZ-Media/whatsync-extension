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

  // 'active' is the connected state written by hubspot-oauth's oauthCallback.
  // Anything else (not_connected, error, revoked, expired) means reconnect.
  if (!conn || conn.status !== 'active' || !conn.access_token) {
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
      body: JSON.stringify({ status: 'error' }),
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
      status: 'active',
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

const TICKET_PROPERTIES = ['subject', 'content', 'hs_pipeline', 'hs_pipeline_stage', 'hs_ticket_priority', 'hubspot_owner_id', 'createdate'];
const DEAL_PROPERTIES = ['dealname', 'amount', 'dealstage', 'pipeline', 'closedate', 'createdate', 'deal_currency_code'];
const TASK_PROPERTIES = ['hs_task_subject', 'hs_task_body', 'hs_task_status', 'hs_task_priority', 'hs_task_type', 'hs_timestamp'];
const NOTE_PROPERTIES = ['hs_note_body', 'hs_createdate', 'hs_lastmodifieddate'];

// HubSpot calculated/read-only properties that must never be sent on create/update —
// including any of them makes HubSpot reject the entire request (READ_ONLY_VALUE).
const READ_ONLY_PROPERTIES = new Set([
  'createdate', 'hs_createdate', 'lastmodifieddate', 'hs_lastmodifieddate', 'hs_object_id',
  'notes_last_contacted', 'notes_last_updated', 'notes_next_activity_date',
  'num_contacted_notes', 'num_notes', 'hubspot_owner_assigneddate',
]);

// Drop read-only properties and empty values so a partial form never breaks a create.
function sanitizeProperties(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (READ_ONLY_PROPERTIES.has(key)) continue;
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out;
}

// Map the extension's flat task payload to real HubSpot task property names.
// The client sends { subject, body, status, type, priority, dueDate, ownerId, contactId };
// HubSpot only accepts hs_task_* property names, so a raw pass-through fails validation.
function buildTaskProperties(data: Record<string, unknown>): Record<string, unknown> {
  const src = (data.properties as Record<string, unknown>) ?? data;
  const props: Record<string, unknown> = {};

  const subject = src.hs_task_subject ?? src.subject ?? src.taskName ?? src.name;
  if (subject) props.hs_task_subject = String(subject);

  const body = src.hs_task_body ?? src.body ?? src.notes;
  if (body) props.hs_task_body = String(body);

  const status = src.hs_task_status ?? src.status;
  props.hs_task_status = String(status || 'NOT_STARTED').toUpperCase();

  const VALID_TASK_TYPES = new Set(['TODO', 'CALL', 'EMAIL']);
  const type = String(src.hs_task_type ?? src.type ?? 'TODO').toUpperCase();
  props.hs_task_type = VALID_TASK_TYPES.has(type) ? type : 'TODO';

  const priority = src.hs_task_priority ?? src.priority;
  if (priority) {
    const p = String(priority).toUpperCase();
    if (['LOW', 'MEDIUM', 'HIGH'].includes(p)) props.hs_task_priority = p;
  }

  const due = src.hs_timestamp ?? src.dueDate;
  if (due) {
    const dueMs = typeof due === 'number' ? due : new Date(String(due)).getTime();
    if (!Number.isNaN(dueMs)) props.hs_timestamp = new Date(dueMs).toISOString();
  }
  if (!props.hs_timestamp) props.hs_timestamp = new Date().toISOString();

  const owner = src.hubspot_owner_id ?? src.ownerId ?? src.assignedTo;
  if (owner && String(owner) !== 'unassigned') props.hubspot_owner_id = String(owner);

  return props;
}

async function associateToContact(
  token: string,
  objectType: string,
  objectId: string,
  contactId: string,
): Promise<void> {
  // v4 default association covers the HUBSPOT_DEFINED type for each object pair.
  await hubspot(
    token,
    'PUT',
    `/crm/v4/objects/${objectType}/${objectId}/associations/default/contacts/${contactId}`,
  );
}

// Merge a contact's engagement timeline (notes, tasks, calls, emails, meetings)
// into one list, most recent first.
async function getContactActivities(
  token: string,
  contactId: string,
  limit: number,
): Promise<{ activities: unknown[] }> {
  const kinds: Array<{ objectType: string; type: string; titleProps: string[]; tsProps: string[] }> = [
    { objectType: 'notes', type: 'note', titleProps: ['hs_note_body'], tsProps: ['hs_timestamp', 'hs_createdate'] },
    { objectType: 'tasks', type: 'task', titleProps: ['hs_task_subject', 'hs_task_body'], tsProps: ['hs_timestamp', 'hs_createdate'] },
    { objectType: 'calls', type: 'call', titleProps: ['hs_call_title', 'hs_call_body'], tsProps: ['hs_timestamp', 'hs_createdate'] },
    { objectType: 'emails', type: 'email', titleProps: ['hs_email_subject'], tsProps: ['hs_timestamp', 'hs_createdate'] },
    { objectType: 'meetings', type: 'meeting', titleProps: ['hs_meeting_title'], tsProps: ['hs_meeting_start_time', 'hs_timestamp', 'hs_createdate'] },
  ];

  const results = await Promise.all(
    kinds.map(async (kind) => {
      try {
        const props = [...new Set([...kind.titleProps, ...kind.tsProps])];
        const { results } = await getContactAssociations(token, contactId, kind.objectType, props);
        return (results as Array<{ id?: string; properties?: Record<string, string>; createdAt?: string }>).map((obj) => {
          const p = obj.properties ?? {};
          let title = '';
          for (const key of kind.titleProps) {
            if (p[key]) { title = p[key]; break; }
          }
          // Strip HTML and collapse whitespace for a compact timeline label.
          title = title.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
          let timestamp: string | null = null;
          for (const key of kind.tsProps) {
            if (p[key]) { timestamp = p[key]; break; }
          }
          return {
            id: obj.id ?? null,
            type: kind.type,
            title: title || null,
            timestamp: timestamp ?? obj.createdAt ?? null,
          };
        });
      } catch {
        return []; // one unavailable engagement type must not sink the timeline
      }
    }),
  );

  const merged = results.flat();
  merged.sort((a, b) => {
    const ta = a.timestamp ? new Date(String(a.timestamp)).getTime() : 0;
    const tb = b.timestamp ? new Date(String(b.timestamp)).getTime() : 0;
    return tb - ta;
  });
  return { activities: merged.slice(0, limit) };
}

// Evaluate the user's active automations for a trigger. Executes the simple,
// safe action types (create_task / create_note) against the matched contact and
// reports everything else back as matched-but-manual.
async function evaluateAutomations(
  userId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const triggerType = String(data.triggerType ?? '');
  const context = (data.context as Record<string, unknown>) ?? {};

  const res = await db(
    `automations?user_id=eq.${userId}&is_active=eq.true&select=id,name,trigger_type,trigger_config,action_type,action_config`,
  );
  if (!res.ok) return { success: true, total: 0, matched: [] };
  const all = (await res.json()) as Array<{
    id: string; name: string; trigger_type: string;
    action_type: string; action_config: Record<string, unknown>;
  }>;

  const matched = all.filter((a) => a.trigger_type === triggerType);
  // `total` lets the client stop firing per-message triggers when the user has
  // no automations configured at all.
  if (matched.length === 0) return { success: true, total: all.length, matched: [] };

  const contactId = context.contactId ? String(context.contactId) : null;
  const executed: Array<{ id: string; action: string; ok: boolean }> = [];

  let token: string | null = null;
  for (const automation of matched) {
    let ok = false;
    try {
      if (contactId && (automation.action_type === 'create_task' || automation.action_type === 'create_note')) {
        token = token ?? (await getHubSpotToken(userId));
        const cfg = automation.action_config ?? {};
        if (automation.action_type === 'create_task') {
          const created = (await hubspot(token, 'POST', '/crm/v3/objects/tasks', {
            properties: buildTaskProperties({
              subject: cfg.subject ?? `Automation: ${automation.name}`,
              body: cfg.body ?? '',
              priority: cfg.priority,
            }),
          })) as { id?: string };
          if (created?.id) await associateToContact(token, 'tasks', String(created.id), contactId);
        } else {
          const created = (await hubspot(token, 'POST', '/crm/v3/objects/notes', {
            properties: {
              hs_note_body: String(cfg.body ?? `Automation "${automation.name}" fired.`),
              hs_timestamp: Date.now(),
            },
          })) as { id?: string };
          if (created?.id) await associateToContact(token, 'notes', String(created.id), contactId);
        }
        ok = true;
      }
    } catch (e) {
      console.warn('[hubspot] automation execution failed:', automation.id, (e as Error)?.message);
    }
    executed.push({ id: automation.id, action: automation.action_type, ok });
  }

  return { success: true, total: all.length, matched: matched.map((m) => m.id), executed };
}

async function handleAction(
  action: string,
  data: Record<string, unknown>,
  userId: string,
): Promise<unknown> {
  // Pure-database actions don't need a HubSpot token
  switch (action) {
    case 'getSidebarFields':
      return getSidebarFields(userId);
    case 'getTemplates': {
      const res = await db(
        `message_templates?user_id=eq.${userId}&select=id,name,content,category,is_favorite,variables&order=is_favorite.desc,name.asc`,
      );
      if (!res.ok) throw new HttpError(500, 'Failed to load templates');
      return { templates: await res.json() };
    }
    case 'evaluateAutomations':
      return evaluateAutomations(userId, data);
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

    case 'updateContact': {
      const { contactId } = data as { contactId?: string | number };
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      const properties = (data.properties as Record<string, unknown>) ?? {};
      // Allow explicitly clearing an enum value ('' is valid on PATCH), but still
      // strip read-only properties that would reject the whole request.
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        if (READ_ONLY_PROPERTIES.has(key)) continue;
        if (value === undefined || value === null) continue;
        patch[key] = value;
      }
      if (Object.keys(patch).length === 0) throw new HttpError(400, 'No writable properties provided');
      return hubspot(token, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: patch });
    }

    // Enumeration options for any object's property (lifecyclestage, dealstage, ...).
    case 'getPropertyOptions': {
      const { property, objectType = 'contacts' } = data as { property?: string; objectType?: string };
      if (!property) throw new HttpError(400, 'Missing required field: property');
      const prop = (await hubspot(
        token,
        'GET',
        `/crm/v3/properties/${encodeURIComponent(String(objectType))}/${encodeURIComponent(String(property))}`,
      )) as { options?: Array<{ value: string; label: string; hidden?: boolean; displayOrder?: number }> };
      return { options: prop.options ?? [] };
    }

    // Pipelines (with stages) for tickets or deals — drives real dropdowns in the
    // create-ticket / create-deal forms instead of hard-coded guesses.
    case 'getPipelines': {
      const objectType = String((data as { objectType?: string }).objectType ?? 'tickets');
      if (!['tickets', 'deals'].includes(objectType)) {
        throw new HttpError(400, 'objectType must be tickets or deals');
      }
      const res = (await hubspot(token, 'GET', `/crm/v3/pipelines/${objectType}`)) as {
        results?: Array<{ id: string; label: string; displayOrder?: number; stages?: Array<{ id: string; label: string; displayOrder?: number }> }>;
      };
      const pipelines = (res.results ?? [])
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
        .map((p) => ({
          id: p.id,
          label: p.label,
          stages: (p.stages ?? [])
            .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))
            .map((s) => ({ id: s.id, label: s.label })),
        }));
      return { pipelines };
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
      const { contactId, note, noteBody, body, timestamp, createTodo, followUpType, followUpDate } =
        data as Record<string, unknown>;
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

      // Optional follow-up task ("Create a To-do/Call/Email task to follow up ...")
      // — the note modal's checkbox is a real promise, so honor it here.
      let followUpTask: unknown = null;
      if (createTodo === true) {
        try {
          const dueMs = followUpDate ? new Date(String(followUpDate)).getTime() : NaN;
          const fallbackDue = Date.now() + 3 * 24 * 60 * 60 * 1000; // ~3 days out
          followUpTask = await hubspot(token, 'POST', '/crm/v3/objects/tasks', {
            properties: buildTaskProperties({
              subject: 'Follow up on WhatsApp note',
              body: noteText.slice(0, 500),
              type: followUpType,
              dueDate: Number.isNaN(dueMs) ? fallbackDue : dueMs,
            }),
            associations: [
              {
                to: { id: String(contactId) },
                types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 204 }], // task → contact
              },
            ],
          });
        } catch (e) {
          console.warn('[hubspot] follow-up task creation failed (note was created):', (e as Error)?.message);
        }
      }
      return { success: true, data: result, followUpTask };
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
      // Sanitize: drop read-only properties (createdate) and empty values so the
      // create never fails on a partially-filled form.
      const properties = sanitizeProperties((data.properties as Record<string, unknown>) ?? data);
      if (!properties.subject) throw new HttpError(400, 'Missing required field: subject');
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
        await hubspot(token, method, path);
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

    case 'createDeal': {
      const properties = sanitizeProperties((data.properties as Record<string, unknown>) ?? {});
      if (!properties.dealname) throw new HttpError(400, 'Missing required field: dealname');
      const ownerId = data.ownerId ? String(data.ownerId) : null;
      if (ownerId && ownerId !== 'unassigned' && !properties.hubspot_owner_id) {
        properties.hubspot_owner_id = ownerId;
      }
      const contactId = data.contactId ? String(data.contactId) : null;
      const payload: Record<string, unknown> = { properties };
      if (contactId) {
        payload.associations = [
          {
            to: { id: contactId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 }], // deal → contact
          },
        ];
      }
      return hubspot(token, 'POST', '/crm/v3/objects/deals', payload);
    }

    case 'associateDeals':
    case 'disassociateDeals': {
      const contactId = String(data.contactId ?? '');
      const dealIds = (data.dealIds as Array<string | number>) ?? [];
      if (!contactId || dealIds.length === 0) {
        throw new HttpError(400, 'Missing required fields: contactId, dealIds');
      }
      const method = action === 'associateDeals' ? 'PUT' : 'DELETE';
      for (const dealId of dealIds) {
        const path = `/crm/v4/objects/contacts/${contactId}/associations/${
          method === 'PUT' ? 'default/' : ''
        }deals/${dealId}`;
        await hubspot(token, method, path);
      }
      return { success: true };
    }

    // ----- Tasks -----
    case 'createTask': {
      const properties = buildTaskProperties(data);
      if (!properties.hs_task_subject) throw new HttpError(400, 'Missing required field: task subject');
      const contactId = data.contactId ? String(data.contactId) : null;
      const payload: Record<string, unknown> = { properties };
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

    case 'getOwnerById': {
      const { ownerId } = data as { ownerId?: string | number };
      if (!ownerId) throw new HttpError(400, 'Missing required field: ownerId');
      try {
        const owner = await hubspot(token, 'GET', `/crm/v3/owners/${ownerId}`);
        return { owner };
      } catch {
        // Archived owners are only visible with archived=true.
        const owner = await hubspot(token, 'GET', `/crm/v3/owners/${ownerId}?archived=true`);
        return { owner };
      }
    }

    // ----- Engagement timeline -----
    case 'getContactActivities': {
      const contactId = String(data.contactId ?? '');
      if (!contactId) return { activities: [] };
      const limit = Math.min(Number(data.limit) || 20, 50);
      return getContactActivities(token, contactId, limit);
    }

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
