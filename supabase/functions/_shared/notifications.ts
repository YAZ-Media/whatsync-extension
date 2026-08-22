import { getExternalSupabaseCredentials } from './activityConfig.ts';

export type NotificationKind = 'failure_alert' | 'team_activity' | 'weekly_digest';

function normalizeResendFrom(): string {
  const resendFromName = (Deno.env.get('RESEND_FROM_NAME') || 'WhatSync')
    .trim()
    .replace(/[<>]/g, '');
  const resendFrom = (Deno.env.get('RESEND_FROM') || '').trim();
  const resendFromEmailOnly = (Deno.env.get('RESEND_FROM_EMAIL') || '').trim();
  const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

  const normalize = (value: string): string | null => {
    if (!value) return null;
    if (value.includes('<')) {
      const m = value.match(/<([^>]+)>/);
      const inner = (m?.[1] || '').trim();
      return isEmail(inner) ? value : null;
    }
    return isEmail(value) ? `${resendFromName} <${value}>` : null;
  };

  return (
    normalize(resendFrom) ||
    normalize(resendFromEmailOnly) ||
    `${resendFromName} <noreply@resend.dev>`
  );
}

export async function fetchUserProfile(
  userId: string
): Promise<{ email: string | null; first_name?: string; last_name?: string; role?: string; company?: string } | null> {
  const creds = getExternalSupabaseCredentials();
  if (!creds) return null;

  const url = `${creds.url}/rest/v1/user_profiles?user_id=eq.${userId}&select=email,first_name,last_name,role,company&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function fetchWorkspaceSettings(userId: string): Promise<Record<string, unknown> | null> {
  const creds = getExternalSupabaseCredentials();
  if (!creds) return null;

  const url = `${creds.url}/rest/v1/workspace_settings?user_id=eq.${userId}&select=*&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

export async function sendResendEmail(params: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: boolean; error?: string }> {
  const resendApiKey = Deno.env.get('RESEND_API_KEY');
  if (!resendApiKey) {
    return { ok: false, error: 'Email service not configured' };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: normalizeResendFrom(),
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: text || res.statusText };
  }

  return { ok: true };
}

export async function sendUserNotificationIfEnabled(
  userId: string,
  kind: NotificationKind,
  content: { subject: string; html: string }
): Promise<{ sent: boolean; reason?: string }> {
  const [profile, settings] = await Promise.all([
    fetchUserProfile(userId),
    fetchWorkspaceSettings(userId),
  ]);

  const email = profile?.email?.trim();
  if (!email) return { sent: false, reason: 'no_email' };

  const enabled =
    kind === 'failure_alert'
      ? settings?.failure_alerts !== false
      : kind === 'team_activity'
        ? settings?.team_activity === true
        : settings?.weekly_digest !== false;

  if (!enabled) return { sent: false, reason: 'disabled' };

  const result = await sendResendEmail({ to: email, subject: content.subject, html: content.html });
  if (!result.ok) return { sent: false, reason: result.error };
  return { sent: true };
}

export async function notifyTeamActivity(params: {
  actorUserId: string;
  title: string;
  body: string;
}): Promise<void> {
  const creds = getExternalSupabaseCredentials();
  if (!creds) return;

  const profilesUrl = `${creds.url}/rest/v1/user_profiles?select=user_id,email,role&status=eq.Active`;
  const profilesRes = await fetch(profilesUrl, {
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!profilesRes.ok) return;

  const profiles = await profilesRes.json();
  if (!Array.isArray(profiles)) return;

  const adminIds = profiles
    .filter((p) => ['Owner', 'Admin'].includes(String(p.role || '')))
    .map((p) => p.user_id)
    .filter((id) => id && id !== params.actorUserId);

  if (adminIds.length === 0) return;

  const settingsUrl = `${creds.url}/rest/v1/workspace_settings?select=user_id,team_activity&user_id=in.(${adminIds.join(',')})&team_activity=eq.true`;
  const settingsRes = await fetch(settingsUrl, {
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
    },
  });

  let recipientIds = adminIds;
  if (settingsRes.ok) {
    const settingsRows = await settingsRes.json();
    if (Array.isArray(settingsRows) && settingsRows.length > 0) {
      recipientIds = settingsRows.map((r) => r.user_id).filter(Boolean);
    } else {
      // No explicit settings rows — default team_activity is false; skip unless we want to notify all admins
      recipientIds = [];
    }
  }

  await Promise.all(
    recipientIds.map((userId) =>
      sendUserNotificationIfEnabled(userId, 'team_activity', {
        subject: params.title,
        html: `<p>${params.body}</p>`,
      })
    )
  );
}
