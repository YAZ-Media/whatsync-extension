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

import { sendResendEmail } from '../_shared/notifications.ts';
import { signInviteToken } from '../_shared/invites.ts';

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

  if (!res.ok) throw new HttpError(500, 'Failed to load HubSpot connection');

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
// Sidebar fields — canonical catalog (the exact keys the Chrome extension
// gates on). One entry per key; locked keys are always enabled.
// ---------------------------------------------------------------------------

type SidebarFieldType = 'contact_info' | 'action' | 'section';

interface SidebarCatalogEntry {
  field_key: string;
  field_label: string;
  field_type: SidebarFieldType;
  is_locked: boolean;
}

const SIDEBAR_CATALOG: SidebarCatalogEntry[] = [
  // Contact fields
  { field_key: 'firstname_lastname', field_label: 'Contact Name', field_type: 'contact_info', is_locked: true },
  { field_key: 'phone', field_label: 'Phone', field_type: 'contact_info', is_locked: true },
  { field_key: 'email', field_label: 'Email', field_type: 'contact_info', is_locked: false },
  { field_key: 'company', field_label: 'Company', field_type: 'contact_info', is_locked: false },
  { field_key: 'jobtitle', field_label: 'Job Title', field_type: 'contact_info', is_locked: false },
  { field_key: 'hubspot_owner_id', field_label: 'Contact Owner', field_type: 'contact_info', is_locked: false },
  { field_key: 'lifecyclestage', field_label: 'Lifecycle Stage', field_type: 'contact_info', is_locked: false },
  { field_key: 'hs_lead_status', field_label: 'Lead Status', field_type: 'contact_info', is_locked: false },
  { field_key: 'createdate', field_label: 'Create Date', field_type: 'contact_info', is_locked: false },
  // Quick actions
  { field_key: 'action_note', field_label: 'Note', field_type: 'action', is_locked: false },
  { field_key: 'action_email', field_label: 'Email', field_type: 'action', is_locked: false },
  { field_key: 'action_log_whatsapp', field_label: 'Log WhatsApp Message', field_type: 'action', is_locked: false },
  { field_key: 'action_task', field_label: 'Task', field_type: 'action', is_locked: false },
  { field_key: 'action_meeting', field_label: 'Meeting', field_type: 'action', is_locked: false },
  { field_key: 'action_ticket', field_label: 'Create Ticket', field_type: 'action', is_locked: false },
  { field_key: 'send_template', field_label: 'Send Template', field_type: 'action', is_locked: false },
  // Sections
  { field_key: 'section_activity', field_label: 'Recent Activity', field_type: 'section', is_locked: false },
  { field_key: 'section_notes', field_label: 'Notes', field_type: 'section', is_locked: false },
  { field_key: 'section_tickets', field_label: 'Tickets', field_type: 'section', is_locked: false },
  { field_key: 'section_tasks', field_label: 'Tasks', field_type: 'section', is_locked: false },
  { field_key: 'section_deals', field_label: 'Deals', field_type: 'section', is_locked: false },
];

async function getSidebarFields(userId: string): Promise<unknown> {
  const prefsRes = await db(
    `hubspot_sidebar_fields?user_id=eq.${userId}&select=field_key,is_enabled`,
  );

  if (!prefsRes.ok) {
    throw new HttpError(500, 'Failed to load sidebar field configuration');
  }

  const prefs: { field_key: string; is_enabled: boolean }[] = await prefsRes.json();
  const prefMap = new Map(prefs.map((p) => [p.field_key, p.is_enabled]));

  // Flat array — one entry per canonical key. Default true; locked always true.
  const fields = SIDEBAR_CATALOG.map((f) => ({
    field_key: f.field_key,
    field_type: f.field_type,
    is_enabled: f.is_locked ? true : prefMap.get(f.field_key) ?? true,
  }));

  // Backward-compat grouped shape alongside the canonical flat `fields` array.
  const grouped = SIDEBAR_CATALOG.map((f) => ({
    field_key: f.field_key,
    field_label: f.field_label,
    field_type: f.field_type,
    is_locked: f.is_locked,
    is_enabled: f.is_locked ? true : prefMap.get(f.field_key) ?? true,
  }));

  return {
    fields,
    contactFields: grouped.filter((f) => f.field_type === 'contact_info'),
    actionFields: grouped.filter((f) => f.field_type === 'action'),
    sectionFields: grouped.filter((f) => f.field_type === 'section'),
  };
}

// ---------------------------------------------------------------------------
// Team management (org-scoped, role-gated)
// ---------------------------------------------------------------------------

const TEAM_PROFILE_COLUMNS =
  'id,user_id,first_name,last_name,email,company,role,status,last_active,extension_version,enforce_2fa,organization_id,created_at,updated_at';

interface TeamProfile {
  id: string;
  user_id: string;
  email: string | null;
  role: string | null;
  status: string | null;
  organization_id: string | null;
  [key: string]: unknown;
}

function escapeHtmlText(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function getProfileRow(userId: string): Promise<TeamProfile | null> {
  const res = await db(
    `user_profiles?user_id=eq.${userId}&select=${TEAM_PROFILE_COLUMNS}&limit=1`,
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as TeamProfile[];
  return rows[0] ?? null;
}

function profileOrgId(profile: TeamProfile | null, fallbackUserId: string): string {
  return String(profile?.organization_id || profile?.user_id || fallbackUserId);
}

/** Actor must be an active Owner/Admin. Returns their profile + org id. */
async function requireTeamManager(userId: string): Promise<{ profile: TeamProfile; orgId: string }> {
  const profile = await getProfileRow(userId);
  if (!profile) throw new HttpError(403, 'Profile not found');
  const role = String(profile.role || 'Member');
  const status = String(profile.status || 'Active');
  if (status !== 'Active' || !['Owner', 'Admin'].includes(role)) {
    throw new HttpError(403, 'Only Owners and Admins can manage the team');
  }
  return { profile, orgId: profileOrgId(profile, userId) };
}

const TEAM_ROLES = new Set(['Owner', 'Admin', 'Member', 'Billing', 'Read-only']);
const TEAM_STATUSES = new Set(['Active', 'Pending', 'Suspended']);
const INVITABLE_ROLES = new Set(['Admin', 'Member', 'Billing', 'Read-only']);

async function getTeamMembers(userId: string): Promise<unknown> {
  const me = await getProfileRow(userId);
  const orgId = profileOrgId(me, userId);
  const res = await db(
    `user_profiles?organization_id=eq.${orgId}&select=${TEAM_PROFILE_COLUMNS}&order=created_at.asc`,
  );
  if (!res.ok) throw new HttpError(500, 'Failed to load team members');
  return { members: await res.json() };
}

async function updateTeamMember(userId: string, data: Record<string, unknown>): Promise<unknown> {
  const targetUserId = String(data.targetUserId ?? '');
  if (!targetUserId) throw new HttpError(400, 'Missing required field: targetUserId');

  const { profile: me, orgId } = await requireTeamManager(userId);
  const target = await getProfileRow(targetUserId);
  if (!target || profileOrgId(target, targetUserId) !== orgId) {
    throw new HttpError(404, 'Team member not found in your organization');
  }

  // Admins cannot modify Owners; nobody can demote or suspend themselves.
  const targetRole = String(target.role || 'Member');
  if (String(me.role) === 'Admin' && targetRole === 'Owner') {
    throw new HttpError(403, 'Admins cannot modify an Owner');
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (data.role !== undefined) {
    const role = String(data.role);
    if (!TEAM_ROLES.has(role)) throw new HttpError(400, `Invalid role: ${role}`);
    if (targetUserId === userId && role !== String(me.role)) {
      throw new HttpError(400, 'You cannot change your own role');
    }
    patch.role = role;
  }
  if (data.status !== undefined) {
    const status = String(data.status);
    if (!TEAM_STATUSES.has(status)) throw new HttpError(400, `Invalid status: ${status}`);
    if (targetUserId === userId && status !== 'Active') {
      throw new HttpError(400, 'You cannot suspend yourself');
    }
    patch.status = status;
  }
  if (data.enforce_2fa !== undefined) {
    patch.enforce_2fa = Boolean(data.enforce_2fa);
  }
  if (Object.keys(patch).length === 1) {
    throw new HttpError(400, 'No valid updates provided');
  }

  const res = await db(`user_profiles?user_id=eq.${targetUserId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new HttpError(500, `Failed to update team member (${res.status})`);
  const rows = await res.json();
  return { success: true, profile: rows[0] ?? null };
}

async function inviteTeamMember(userId: string, data: Record<string, unknown>): Promise<unknown> {
  const email = String(data.email ?? '').trim().toLowerCase();
  const role = String(data.role ?? 'Member');
  const appUrlRaw = String(data.appUrl ?? 'https://whatsync.io');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, 'A valid email address is required');
  }
  if (!INVITABLE_ROLES.has(role)) {
    throw new HttpError(400, `Cannot invite with role: ${role}`);
  }
  const appUrl = /^https:\/\/[a-z0-9.-]+/i.test(appUrlRaw) || /^http:\/\/localhost(:\d+)?$/i.test(appUrlRaw)
    ? appUrlRaw.replace(/\/+$/, '')
    : 'https://whatsync.io';

  const { profile: me, orgId } = await requireTeamManager(userId);

  // Don't invite someone who's already in the org.
  const existingRes = await db(
    `user_profiles?email=eq.${encodeURIComponent(email)}&select=user_id,organization_id&limit=1`,
  );
  if (existingRes.ok) {
    const rows = (await existingRes.json()) as TeamProfile[];
    if (rows[0] && profileOrgId(rows[0], String(rows[0].user_id)) === orgId) {
      throw new HttpError(400, 'This person is already a member of your team');
    }
  }

  // Signed token — role and organization are only honored at signup when the
  // signature verifies, so the link parameters cannot be forged.
  const token = await signInviteToken({ email, role, organizationId: orgId, invitedBy: userId });
  const inviteUrl = `${appUrl}/auth?invite=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}&role=${encodeURIComponent(role)}`;

  const inviterName = [me.first_name, me.last_name].filter(Boolean).join(' ') || me.email || 'A teammate';
  const sendResult = await sendResendEmail({
    to: email,
    subject: `You're invited to join ${escapeHtmlText(String(inviterName))}'s WhatSync workspace`,
    html: `
      <h2>You've been invited to WhatSync</h2>
      <p>${escapeHtmlText(String(inviterName))} invited you to join their workspace as <strong>${escapeHtmlText(role)}</strong>.</p>
      <p><a href="${inviteUrl}">Accept the invitation</a> (link expires in 7 days).</p>
      <p>If the button doesn't work, copy this link into your browser:<br>${inviteUrl}</p>
    `,
  });

  if (!sendResult.ok) {
    return {
      success: true,
      inviteUrl,
      warning: `Invitation created, but the email could not be sent (${sendResult.error || 'email service unavailable'}). Share this link directly: ${inviteUrl}`,
    };
  }

  return { success: true, inviteUrl };
}

async function saveSidebarFields(
  userId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const incoming = Array.isArray(data.fields) ? data.fields : [];
  if (incoming.length === 0) {
    throw new HttpError(400, 'fields array is required');
  }

  const valid = new Map(SIDEBAR_CATALOG.map((f) => [f.field_key, f]));

  const rows = incoming
    .map((f) => {
      const entry = f as { field_key?: unknown; field_type?: unknown; is_enabled?: unknown };
      const key = String(entry.field_key ?? '');
      const catalogEntry = valid.get(key);
      if (!catalogEntry) return null; // ignore unknown keys
      return {
        user_id: userId,
        field_key: key,
        field_type: catalogEntry.field_type,
        // Locked keys are always enabled regardless of what was posted.
        is_enabled: catalogEntry.is_locked ? true : Boolean(entry.is_enabled),
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) {
    throw new HttpError(400, 'No valid fields to save');
  }

  const res = await db('hubspot_sidebar_fields?on_conflict=user_id,field_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });

  if (!res.ok) {
    throw new HttpError(500, `Failed to save sidebar fields (${res.status}): ${await res.text()}`);
  }

  return { success: true, savedCount: rows.length };
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

// Merge a contact's engagement timeline (notes, tasks, calls, emails, meetings)
// into one list, most recent first.
async function getContactEngagementTimeline(
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

// ---------------------------------------------------------------------------
// Automations engine — evaluate user-defined rules and run HubSpot actions.
// Conditions are AND'd; each is { field, operator, value }. Actions are
// { type, config }. All HubSpot-native; no third-party integrations.
// ---------------------------------------------------------------------------

function evalAutomationCondition(actual: string, operator: string, value?: string): boolean {
  const a = (actual ?? '').toString();
  const v = (value ?? '').toString();
  switch (operator) {
    case 'eq': return a.toLowerCase() === v.toLowerCase();
    case 'neq': return a.toLowerCase() !== v.toLowerCase();
    case 'contains': return a.toLowerCase().includes(v.toLowerCase());
    case 'exists': return a.trim() !== '';
    case 'not_exists': return a.trim() === '';
    case 'gt': return parseFloat(a) > parseFloat(v);
    case 'lt': return parseFloat(a) < parseFloat(v);
    default: return false;
  }
}

async function executeAutomationAction(
  token: string,
  act: { type?: string; config?: Record<string, unknown> },
  contactId: string,
): Promise<void> {
  const cfg = act.config || {};
  const str = (k: string, d = '') => (cfg[k] == null ? d : String(cfg[k]));
  const assoc = (typeId: number) =>
    contactId
      ? [{ to: { id: contactId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] }]
      : undefined;

  switch (act.type) {
    case 'create_task': {
      const dueDays = Number(cfg.dueInDays ?? 0) || 0;
      await hubspot(token, 'POST', '/crm/v3/objects/tasks', {
        properties: {
          hs_task_subject: str('subject', 'Follow up'),
          hs_task_body: str('body'),
          hs_task_status: 'NOT_STARTED',
          hs_task_priority: str('priority', 'MEDIUM'),
          hs_timestamp: Date.now() + dueDays * 86400000,
        },
        associations: assoc(204),
      });
      break;
    }
    case 'create_note': {
      await hubspot(token, 'POST', '/crm/v3/objects/notes', {
        properties: { hs_note_body: str('body'), hs_timestamp: Date.now() },
        associations: assoc(202),
      });
      break;
    }
    case 'update_property': {
      const property = str('property');
      if (property && contactId) {
        await hubspot(token, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, {
          properties: { [property]: str('value') },
        });
      }
      break;
    }
    case 'create_deal': {
      const props: Record<string, unknown> = { dealname: str('dealname', 'New deal') };
      if (cfg.amount) props.amount = str('amount');
      if (cfg.pipeline) props.pipeline = str('pipeline');
      if (cfg.stage) props.dealstage = str('stage');
      await hubspot(token, 'POST', '/crm/v3/objects/deals', { properties: props, associations: assoc(3) });
      break;
    }
    case 'create_ticket': {
      await hubspot(token, 'POST', '/crm/v3/objects/tickets', {
        properties: {
          subject: str('subject', 'New ticket'),
          content: str('content'),
          hs_ticket_priority: str('priority', 'MEDIUM'),
        },
        associations: assoc(16),
      });
      break;
    }
    default:
      break;
  }
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

    case 'saveSidebarFields':
      return saveSidebarFields(userId, data);

    // ----- Team management (org-scoped; identity from the JWT) -----
    case 'getTeamMembers':
      return getTeamMembers(userId);
    case 'updateTeamMember':
      return updateTeamMember(userId, data);
    case 'inviteTeamMember':
      return inviteTeamMember(userId, data);

    // ----- Automations (per-user, stored in the external DB) -----
    case 'getAutomations': {
      const res = await db(
        `automations?user_id=eq.${userId}` +
        `&select=id,user_id,name,description,enabled,trigger,conditions,actions,is_prebuilt,created_at,updated_at` +
        `&order=created_at.desc`,
      );
      if (!res.ok) throw new HttpError(500, `Failed to load automations (${res.status})`);
      return { automations: await res.json() };
    }

    case 'createAutomation': {
      const { name, description, trigger, conditions, actions } = data as Record<string, unknown>;
      if (!name || !trigger) throw new HttpError(400, 'Missing required fields: name, trigger');
      const res = await db('automations', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          name,
          description: description ?? null,
          trigger,
          conditions: Array.isArray(conditions) ? conditions : [],
          actions: Array.isArray(actions) ? actions : [],
          enabled: true,
          is_prebuilt: false,
        }),
      });
      if (!res.ok) throw new HttpError(500, `Failed to create automation (${res.status})`);
      const rows = await res.json();
      return { automation: rows[0] ?? null };
    }

    case 'updateAutomation': {
      const d = data as Record<string, unknown>;
      const automationId = d.automationId as string | undefined;
      if (!automationId) throw new HttpError(400, 'Missing required field: automationId');
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      for (const k of ['name', 'description', 'trigger', 'conditions', 'actions', 'enabled']) {
        if (d[k] !== undefined) patch[k] = d[k];
      }
      const res = await db(
        `automations?id=eq.${encodeURIComponent(automationId)}&user_id=eq.${userId}`,
        { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) },
      );
      if (!res.ok) throw new HttpError(500, `Failed to update automation (${res.status})`);
      const rows = await res.json();
      return { automation: rows[0] ?? null };
    }

    case 'deleteAutomation': {
      const automationId = (data as { automationId?: string }).automationId;
      if (!automationId) throw new HttpError(400, 'Missing required field: automationId');
      const res = await db(
        `automations?id=eq.${encodeURIComponent(automationId)}&user_id=eq.${userId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new HttpError(500, `Failed to delete automation (${res.status})`);
      return { success: true };
    }

    // Evaluate this user's enabled automations for a trigger and execute matching
    // actions. Fired by the extension on real events (contact matched, note/
    // ticket/task/deal created). Conditions are checked against the contact's
    // live HubSpot properties.
    case 'evaluateAutomations': {
      const triggerType = String((data as { triggerType?: string }).triggerType || '');
      const context = (((data as { context?: Record<string, unknown> }).context) || {}) as Record<string, unknown>;
      if (!triggerType) return { success: true, ran: 0, executed: 0, total: 0 };

      const aRes = await db(
        `automations?user_id=eq.${userId}&enabled=eq.true&trigger=eq.${encodeURIComponent(triggerType)}` +
        `&select=id,name,conditions,actions`,
      );
      if (!aRes.ok) throw new HttpError(500, `Failed to load automations (${aRes.status})`);
      const autos = (await aRes.json()) as Array<{ id: string; name: string; conditions: unknown; actions: unknown }>;
      // `total` lets the extension back off from firing high-frequency message
      // triggers when the user has no automations for that trigger at all.
      if (!autos.length) return { success: true, ran: 0, executed: 0, total: 0 };

      const token = await getHubSpotToken(userId);
      const contactId = String(context.contactId ?? context.id ?? '');

      // Pull the contact's live properties for any field a condition references.
      const fields = new Set<string>(['email', 'phone', 'firstname', 'lastname', 'company', 'jobtitle', 'lifecyclestage', 'hs_lead_status']);
      for (const a of autos) {
        for (const c of (Array.isArray(a.conditions) ? a.conditions : []) as Array<{ field?: string }>) {
          if (c?.field) fields.add(c.field);
        }
      }
      let props: Record<string, unknown> = {};
      if (contactId) {
        try {
          const c = (await hubspot(token, 'GET', `/crm/v3/objects/contacts/${contactId}?properties=${[...fields].join(',')}`)) as { properties?: Record<string, unknown> };
          props = c.properties || {};
        } catch (_) { /* contact may not exist yet */ }
      }
      const valueOf = (f?: string) => {
        if (!f) return '';
        const v = props[f] ?? context[f];
        return v == null ? '' : String(v);
      };

      let ran = 0, executed = 0;
      for (const a of autos) {
        const conds = (Array.isArray(a.conditions) ? a.conditions : []) as Array<{ field?: string; operator?: string; value?: string }>;
        const pass = conds.every((c) => evalAutomationCondition(valueOf(c.field), c.operator || 'exists', c.value));
        if (!pass) continue;
        ran++;
        const actions = (Array.isArray(a.actions) ? a.actions : []) as Array<{ type?: string; config?: Record<string, unknown> }>;
        for (const act of actions) {
          try { await executeAutomationAction(token, act, contactId); executed++; }
          catch (e) { console.error('[automations] action failed', a.id, act?.type, (e as Error).message); }
        }
      }
      return { success: true, ran, executed, total: autos.length };
    }

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

    case 'getUserActivityLogs': {
      const limit = Math.min(Number((data as { limit?: number }).limit ?? 100), 500);
      const res = await db(
        `hubspot_contact_logs?user_id=eq.${userId}&select=*&order=created_at.desc&limit=${limit}`,
      );
      if (!res.ok) throw new HttpError(500, 'Failed to load activity logs');
      const logs = await res.json();
      return { logs };
    }

    case 'getCurrentUserProfile': {
      const res = await db(
        `user_profiles?user_id=eq.${userId}&select=*&limit=1`,
      );
      if (!res.ok) {
        // Fall back to email match if id-keyed lookup is not supported
        return { profile: null };
      }
      const rows = await res.json();
      return { profile: rows[0] ?? null };
    }

    case 'getTemplates': {
      const res = await db(
        `message_templates?user_id=eq.${userId}&select=*&order=created_at.desc`,
      );
      if (!res.ok) throw new HttpError(500, 'Failed to load templates');
      const templates = await res.json();
      return { templates };
    }

    case 'createTemplate': {
      const payload = {
        user_id: userId,
        name: String(data.name ?? ''),
        content: String(data.content ?? ''),
        category: String(data.category ?? 'General'),
        variables: (data.variables as unknown) ?? [],
      };
      const res = await db('message_templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new HttpError(500, `Failed to create template: ${await res.text()}`);
      const rows = await res.json();
      return { template: rows[0] };
    }

    case 'updateTemplate': {
      const templateId = String(data.templateId ?? '');
      if (!templateId) throw new HttpError(400, 'templateId is required');
      const updates: Record<string, unknown> = {};
      if (data.name !== undefined) updates.name = data.name;
      if (data.content !== undefined) updates.content = data.content;
      if (data.category !== undefined) updates.category = data.category;
      if (data.variables !== undefined) updates.variables = data.variables;
      updates.updated_at = new Date().toISOString();
      const res = await db(
        `message_templates?id=eq.${templateId}&user_id=eq.${userId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify(updates),
        },
      );
      if (!res.ok) throw new HttpError(500, `Failed to update template: ${await res.text()}`);
      const rows = await res.json();
      return { template: rows[0] };
    }

    case 'deleteTemplate': {
      const templateId = String(data.templateId ?? '');
      if (!templateId) throw new HttpError(400, 'templateId is required');
      const res = await db(
        `message_templates?id=eq.${templateId}&user_id=eq.${userId}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new HttpError(500, `Failed to delete template: ${await res.text()}`);
      return { success: true };
    }
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

    // Patch a contact's properties (inline edits from the sidebar, e.g.
    // lifecycle stage / lead status). Read-only properties are stripped so a
    // stale field can never reject the whole request.
    case 'updateContact': {
      const { contactId } = data as { contactId?: string | number };
      if (!contactId) throw new HttpError(400, 'Missing required field: contactId');
      const properties = (data.properties as Record<string, unknown>) ?? {};
      const patch: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        if (READ_ONLY_PROPERTIES.has(key)) continue;
        if (value === undefined || value === null) continue;
        patch[key] = value;
      }
      if (Object.keys(patch).length === 0) throw new HttpError(400, 'No writable properties provided');
      return hubspot(token, 'PATCH', `/crm/v3/objects/contacts/${contactId}`, { properties: patch });
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
      // Sanitize: drop read-only properties (createdate) and empty values so
      // the create never fails on a partially-filled form.
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
      // Map the extension's flat payload to real hs_task_* property names —
      // HubSpot rejects unknown property names, so a raw pass-through failed.
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

    // ----- Pipelines (tickets / deals) -----
    // Drives real pipeline + stage dropdowns in the create-ticket / create-deal
    // forms instead of hard-coded ids that don't exist in most portals.
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

    // ----- Engagement timeline -----
    // The contact's real HubSpot activity (notes, tasks, calls, emails,
    // meetings) merged into one list for the sidebar's Recent Activity section.
    case 'getContactActivities': {
      const contactId = String(data.contactId ?? '');
      if (!contactId) return { activities: [] };
      const limit = Math.min(Number(data.limit) || 20, 50);
      return getContactEngagementTimeline(token, contactId, limit);
    }

    // ----- Property enumeration options (dropdowns) -----
    // Returns the real, user-configured options for an enum property (e.g. a
    // contact's lifecyclestage / hs_lead_status, or a deal's dealstage), so the
    // extension's create form and labels reflect the customer's own values.
    case 'getContactPropertyOptions':
    case 'getPropertyOptions': {
      const objectType = String((data as { objectType?: string }).objectType || 'contacts');
      const property = String((data as { property?: string }).property || '');
      if (!property) return { options: [] };
      const prop = (await hubspot(
        token,
        'GET',
        `/crm/v3/properties/${encodeURIComponent(objectType)}/${encodeURIComponent(property)}`,
      )) as { options?: Array<{ label: string; value: string; hidden?: boolean }> };
      // HubSpot returns options already in display order; just drop hidden ones.
      const options = (prop.options || [])
        .filter((o) => o && o.hidden !== true)
        .map((o) => ({ value: o.value, label: o.label }));
      return { options };
    }

    // ----- Dashboard aggregates -----

    case 'getDashboardStats': {
      const countFor = async (objectType: string): Promise<number> => {
        try {
          const res = (await hubspot(token, 'POST', `/crm/v3/objects/${objectType}/search`, {
            limit: 1,
            properties: ['hs_object_id'],
          })) as { total?: number };
          return typeof res?.total === 'number' ? res.total : 0;
        } catch (_e) {
          return 0;
        }
      };

      const [contactsCount, dealsCount, ticketsCount, companiesCount] = await Promise.all([
        countFor('contacts'),
        countFor('deals'),
        countFor('tickets'),
        countFor('companies'),
      ]);

      return { contactsCount, dealsCount, ticketsCount, companiesCount };
    }

    case 'getRecentHubSpotActivity': {
      const limit = Math.min(Number((data as { limit?: number }).limit ?? 10), 50);

      const searchRecent = async (
        objectType: 'contacts' | 'deals' | 'tickets' | 'companies',
        properties: string[],
      ): Promise<Array<{ id: string; properties: Record<string, string> }>> => {
        try {
          const res = (await hubspot(token, 'POST', `/crm/v3/objects/${objectType}/search`, {
            limit,
            sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }],
            properties,
          })) as { results?: Array<{ id: string; properties: Record<string, string> }> };
          return res.results ?? [];
        } catch (_e) {
          return [];
        }
      };

      const [contacts, deals, tickets, companies] = await Promise.all([
        searchRecent('contacts', ['firstname', 'lastname', 'email', 'phone', 'createdate']),
        searchRecent('deals', ['dealname', 'amount', 'dealstage', 'createdate']),
        searchRecent('tickets', ['subject', 'content', 'hs_pipeline_stage', 'createdate']),
        searchRecent('companies', ['name', 'domain', 'createdate']),
      ]);

      type Item = {
        id: string;
        type: 'contact_created' | 'deal_created' | 'ticket_created' | 'company_created';
        title: string;
        description: string;
        timestamp: string;
        hubspotId: string;
      };

      const items: Item[] = [];

      for (const c of contacts) {
        const p = c.properties ?? {};
        const name = [p.firstname, p.lastname].filter(Boolean).join(' ').trim();
        items.push({
          id: `hs-contact-${c.id}`,
          type: 'contact_created',
          title: name ? `Contact: ${name}` : 'New Contact',
          description: [p.email, p.phone].filter(Boolean).join(' • '),
          timestamp: p.createdate ?? new Date().toISOString(),
          hubspotId: c.id,
        });
      }
      for (const d of deals) {
        const p = d.properties ?? {};
        items.push({
          id: `hs-deal-${d.id}`,
          type: 'deal_created',
          title: p.dealname ? `Deal: ${p.dealname}` : 'New Deal',
          description: p.amount ? `Amount: ${p.amount}` : '',
          timestamp: p.createdate ?? new Date().toISOString(),
          hubspotId: d.id,
        });
      }
      for (const t of tickets) {
        const p = t.properties ?? {};
        items.push({
          id: `hs-ticket-${t.id}`,
          type: 'ticket_created',
          title: p.subject ? `Ticket: ${p.subject}` : 'New Ticket',
          description: p.content ?? '',
          timestamp: p.createdate ?? new Date().toISOString(),
          hubspotId: t.id,
        });
      }
      for (const co of companies) {
        const p = co.properties ?? {};
        items.push({
          id: `hs-company-${co.id}`,
          type: 'company_created',
          title: p.name ? `Company: ${p.name}` : 'New Company',
          description: p.domain ?? '',
          timestamp: p.createdate ?? new Date().toISOString(),
          hubspotId: co.id,
        });
      }

      items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      return { items: items.slice(0, limit) };
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
      // Return 200 with error in body so supabase-js doesn't treat it as a non-2xx failure
      return json({ error: error.message, status: error.status, notConnected: error.status === 403 }, 200);
    }

    console.error('Edge function error:', error);
    return json({ error: error instanceof Error ? error.message : 'Internal error', status: 500 }, 200);
  }
});
