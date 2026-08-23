import { createClient } from "npm:@supabase/supabase-js@2";
import {
  getExternalSupabaseCredentials,
  loadActivityConfig,
  assertSqlIdentifier,
} from "../_shared/activityConfig.ts";
import {
  authenticateRequest,
  fetchUserProfileRole,
} from "../_shared/auth.ts";
import {
  fetchUserProfile,
  sendUserNotificationIfEnabled,
  notifyTeamActivity,
  sendResendEmail,
} from "../_shared/notifications.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DEFAULT_ALLOWED_PROPERTIES = [
  "firstname_lastname",
  "phone",
  "email",
  "company",
  "jobtitle",
  "lifecyclestage",
  "hs_lead_status",
];

function ok(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(msg: string) {
  return ok({ error: msg });
}

function getExternalClient() {
  const creds = getExternalSupabaseCredentials();
  if (!creds) return null;
  return createClient(creds.url, creds.serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function mergeSettings(
  workspace: Record<string, unknown> | null,
  hubspot: Record<string, unknown> | null,
  profileCompany?: string | null
) {
  const retentionDays =
    hubspot?.data_retention_days ??
    workspace?.retention_days ??
    365;

  return {
    workspace_name: workspace?.workspace_name || profileCompany || "",
    timezone: workspace?.timezone || "America/New_York",
    region: workspace?.region || "US",
    retention_days: Number(retentionDays) || 365,
    mask_phone_numbers: hubspot?.mask_phone_numbers ?? workspace?.mask_phone ?? true,
    redact_media_files: hubspot?.redact_media_files ?? workspace?.mask_media ?? false,
    allowed_properties: Array.isArray(workspace?.allowed_properties)
      ? workspace.allowed_properties
      : DEFAULT_ALLOWED_PROPERTIES,
    weekly_digest: workspace?.weekly_digest ?? true,
    failure_alerts: workspace?.failure_alerts ?? true,
    team_activity: workspace?.team_activity ?? false,
    last_weekly_digest_at: workspace?.last_weekly_digest_at ?? null,
  };
}

async function fetchHubspotSettings(ext: ReturnType<typeof getExternalClient>, userId: string) {
  if (!ext) return null;
  const res = await ext
    .from("hubspot_integration_settings")
    .select("mask_phone_numbers,redact_media_files,data_retention_days")
    .eq("user_id", userId)
    .maybeSingle();
  if (res.error) return null;
  return res.data;
}

async function syncHubspotPrivacySettings(
  ext: ReturnType<typeof getExternalClient>,
  userId: string,
  settings: {
    retention_days: number;
    mask_phone_numbers: boolean;
    redact_media_files: boolean;
  }
) {
  if (!ext) return;

  const payload = {
    user_id: userId,
    data_retention_days: settings.retention_days,
    mask_phone_numbers: settings.mask_phone_numbers,
    redact_media_files: settings.redact_media_files,
    updated_at: new Date().toISOString(),
  };

  const updateRes = await ext
    .from("hubspot_integration_settings")
    .update({
      data_retention_days: payload.data_retention_days,
      mask_phone_numbers: payload.mask_phone_numbers,
      redact_media_files: payload.redact_media_files,
      updated_at: payload.updated_at,
    })
    .eq("user_id", userId)
    .select("user_id")
    .maybeSingle();

  if (updateRes.error || !updateRes.data) {
    await ext.from("hubspot_integration_settings").upsert(payload, { onConflict: "user_id" });
  }
}

async function purgeExpiredActivityLogs(userId: string, retentionDays: number) {
  if (!retentionDays || retentionDays >= 99999) {
    return { purged: 0, skipped: true };
  }

  const creds = getExternalSupabaseCredentials();
  if (!creds) return { purged: 0, error: "no_database" };

  const config = await loadActivityConfig();
  assertSqlIdentifier(config.tableName, "tableName");
  assertSqlIdentifier(config.userColumn, "userColumn");
  assertSqlIdentifier(config.timestampColumn, "timestampColumn");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffIso = cutoff.toISOString();

  const url = new URL(`${creds.url}/rest/v1/${config.tableName}`);
  url.searchParams.set(config.userColumn, `eq.${userId}`);
  url.searchParams.set(config.timestampColumn, `lt.${cutoffIso}`);

  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      Prefer: "return=representation",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    console.warn("purgeExpiredActivityLogs failed:", text);
    return { purged: 0, error: text };
  }

  const deleted = await res.json();
  return { purged: Array.isArray(deleted) ? deleted.length : 0 };
}

async function exportWorkspaceData(userId: string) {
  const ext = getExternalClient();
  if (!ext) throw new Error("External database not configured");

  const safeSelect = async (
    table: string,
    select: string,
    filter?: (q: ReturnType<typeof ext.from>) => ReturnType<typeof ext.from>
  ) => {
    try {
      let q = ext.from(table).select(select).eq("user_id", userId);
      if (filter) q = filter(q);
      const res = await q;
      if (res.error) {
        console.warn(`export: ${table}`, res.error.message);
        return [];
      }
      return res.data || [];
    } catch (e) {
      console.warn(`export: ${table}`, e);
      return [];
    }
  };

  const [workspaceSettings, hubspotSettings, templates, automations, sidebarFields, contactLogs, profile, connection] =
    await Promise.all([
      ext.from("workspace_settings").select("*").eq("user_id", userId).maybeSingle(),
      ext.from("hubspot_integration_settings").select(
        "auto_sync_contacts,auto_create_companies,enrich_before_create,attach_message_history,contact_owner_assignment,default_pipeline_id,default_stage_id,mask_phone_numbers,redact_media_files,data_retention_days,field_mappings,updated_at"
      ).eq("user_id", userId).maybeSingle(),
      safeSelect("message_templates", "*"),
      safeSelect("automations", "*"),
      safeSelect("hubspot_sidebar_fields", "*"),
      safeSelect(
        "hubspot_contact_logs",
        "id,activity_type,title,description,hubspot_object_type,created_at,updated_at",
        (q) => q.order("created_at", { ascending: false }).limit(5000) as typeof q
      ),
      fetchUserProfile(userId),
      ext.from("hubspot_connections").select("portal_id,status,created_at,updated_at,token_expires_at").eq("user_id", userId).maybeSingle(),
    ]);

  return {
    exported_at: new Date().toISOString(),
    user_id: userId,
    profile,
    workspace_settings: workspaceSettings.data,
    hubspot_integration_settings: hubspotSettings.data,
    hubspot_connection: connection.data,
    message_templates: templates,
    automations,
    sidebar_fields: sidebarFields,
    activity_logs: contactLogs,
  };
}

async function runWeeklyDigestForUser(userId: string) {
  const ext = getExternalClient();
  if (!ext) throw new Error("External database not configured");

  const settingsRes = await ext.from("workspace_settings").select("*").eq("user_id", userId).maybeSingle();
  const settings = settingsRes.data;
  if (!settings || settings.weekly_digest === false) {
    return { sent: false, reason: "disabled" };
  }

  const lastSent = settings.last_weekly_digest_at
    ? new Date(String(settings.last_weekly_digest_at)).getTime()
    : 0;
  const weekMs = 7 * 24 * 60 * 60 * 1000;
  if (lastSent && Date.now() - lastSent < weekMs - 60_000) {
    return { sent: false, reason: "already_sent_this_week" };
  }

  const since = new Date(Date.now() - weekMs).toISOString();
  const logsRes = await ext
    .from("hubspot_contact_logs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", since);

  const activityCount = logsRes.count ?? 0;
  const profile = await fetchUserProfile(userId);
  const email = profile?.email?.trim();
  if (!email) return { sent: false, reason: "no_email" };

  const workspaceName = settings.workspace_name || profile?.first_name || "your workspace";
  const sendResult = await sendResendEmail({
    to: email,
    subject: `WhatSync weekly digest – ${activityCount} activities`,
    html: `
      <h2>Weekly digest for ${workspaceName}</h2>
      <p>In the last 7 days you logged <strong>${activityCount}</strong> HubSpot activities via WhatSync.</p>
      <p>Open your dashboard to review sync activity and templates.</p>
    `,
  });

  if (!sendResult.ok) return { sent: false, reason: sendResult.error };

  await ext
    .from("workspace_settings")
    .update({ last_weekly_digest_at: new Date().toISOString() })
    .eq("user_id", userId);

  return { sent: true, activityCount };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const ext = getExternalClient();
    if (!ext) {
      return err("External Supabase not configured");
    }

    const { action, data: requestData } = await req.json();
    let data = requestData || {};
    console.log(`Settings action: ${action}`, JSON.stringify(data));

    if (data?.userId) {
      const auth = await authenticateRequest(req, String(data.userId));
      if (!auth.ok) {
        return new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      data = { ...data, userId: auth.userId };
    }

    switch (action) {
      case "getSettings": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");

        const [workspaceRes, hubspotSettings, profile] = await Promise.all([
          ext.from("workspace_settings").select("*").eq("user_id", userId).maybeSingle(),
          fetchHubspotSettings(ext, userId),
          fetchUserProfile(userId),
        ]);

        if (workspaceRes.error && workspaceRes.error.code !== "PGRST116") {
          console.error("getSettings error:", workspaceRes.error);
        }

        return ok({
          settings: mergeSettings(
            workspaceRes.data,
            hubspotSettings,
            profile?.company
          ),
        });
      }

      case "getPrivacySettings": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");

        const [workspaceRes, hubspotSettings] = await Promise.all([
          ext.from("workspace_settings").select("mask_phone,mask_media,allowed_properties").eq("user_id", userId).maybeSingle(),
          fetchHubspotSettings(ext, userId),
        ]);

        const merged = mergeSettings(workspaceRes.data, hubspotSettings);
        return ok({
          privacy: {
            mask_phone: merged.mask_phone_numbers,
            mask_media: merged.redact_media_files,
            allowed_properties: merged.allowed_properties,
            data_retention_days: merged.retention_days,
          },
        });
      }

      case "saveSettings": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");

        const settings = data?.settings;
        if (!settings) throw new Error("settings object is required");

        const profile = await fetchUserProfileRole(userId);
        const role = (profile?.role ?? "Member").toString().trim();
        const canManageWorkspace = ["Owner", "Admin"].includes(role);

        if (canManageWorkspace) {
          const retentionDays = Number(settings.retention_days ?? 365);

          const payload = {
            user_id: userId,
            workspace_name: settings.workspace_name ?? null,
            timezone: settings.timezone ?? "America/New_York",
            region: settings.region ?? "US",
            retention_days: retentionDays,
            mask_phone: settings.mask_phone_numbers ?? true,
            mask_media: settings.redact_media_files ?? false,
            allowed_properties: settings.allowed_properties ?? DEFAULT_ALLOWED_PROPERTIES,
            weekly_digest: settings.weekly_digest ?? true,
            failure_alerts: settings.failure_alerts ?? true,
            team_activity: settings.team_activity ?? false,
            updated_at: new Date().toISOString(),
          };

          const upsertRes = await ext
            .from("workspace_settings")
            .upsert(payload, { onConflict: "user_id" })
            .select()
            .single();

          if (upsertRes.error) {
            throw new Error("Failed to save settings: " + upsertRes.error.message);
          }

          await syncHubspotPrivacySettings(ext, userId, {
            retention_days: retentionDays,
            mask_phone_numbers: Boolean(settings.mask_phone_numbers),
            redact_media_files: Boolean(settings.redact_media_files),
          });

          const purgeResult = await purgeExpiredActivityLogs(userId, retentionDays);

          return ok({
            success: true,
            settings: mergeSettings(upsertRes.data, {
              data_retention_days: retentionDays,
              mask_phone_numbers: settings.mask_phone_numbers,
              redact_media_files: settings.redact_media_files,
            }),
            purge: purgeResult,
          });
        }

        // Members may only update their personal notification preferences
        const existingRes = await ext
          .from("workspace_settings")
          .select("*")
          .eq("user_id", userId)
          .maybeSingle();

        const existing = existingRes.data;
        const notificationPayload = {
          user_id: userId,
          workspace_name: existing?.workspace_name ?? null,
          timezone: existing?.timezone ?? "America/New_York",
          region: existing?.region ?? "US",
          retention_days: existing?.retention_days ?? 365,
          mask_phone: existing?.mask_phone ?? true,
          mask_media: existing?.mask_media ?? false,
          allowed_properties: existing?.allowed_properties ?? DEFAULT_ALLOWED_PROPERTIES,
          weekly_digest: settings.weekly_digest ?? existing?.weekly_digest ?? true,
          failure_alerts: settings.failure_alerts ?? existing?.failure_alerts ?? true,
          team_activity: settings.team_activity ?? existing?.team_activity ?? false,
          updated_at: new Date().toISOString(),
        };

        const upsertRes = await ext
          .from("workspace_settings")
          .upsert(notificationPayload, { onConflict: "user_id" })
          .select()
          .single();

        if (upsertRes.error) {
          throw new Error("Failed to save notification settings: " + upsertRes.error.message);
        }

        const hubspotSettings = await fetchHubspotSettings(ext, userId);
        return ok({
          success: true,
          settings: mergeSettings(upsertRes.data, hubspotSettings),
        });
      }

      case "exportWorkspaceData": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");
        const exportData = await exportWorkspaceData(userId);
        return ok({ export: exportData });
      }

      case "reportSyncFailure": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");
        // Escape before interpolating into the email HTML — message/context are
        // caller-supplied text, never markup.
        const esc = (v: string) =>
          v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const message = esc(String(data?.message || "A sync operation failed").slice(0, 500));
        const context = esc(String(data?.context || "HubSpot sync").slice(0, 120));

        const result = await sendUserNotificationIfEnabled(userId, "failure_alert", {
          subject: `WhatSync sync failure: ${context}`,
          html: `<p>A WhatSync sync operation failed.</p><p><strong>Context:</strong> ${context}</p><p><strong>Details:</strong> ${message}</p>`,
        });

        return ok({ success: true, notification: result });
      }

      case "runWeeklyDigest": {
        const userId = data?.userId;
        if (!userId) throw new Error("userId is required");
        const result = await runWeeklyDigestForUser(userId);
        return ok({ success: true, ...result });
      }

      case "runWeeklyDigestAll": {
        // Fleet-wide digest is for the scheduler only: the bearer must be the
        // service-role key (a public anon key must not be able to trigger
        // emails to every user).
        const bearer = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
        const creds = getExternalSupabaseCredentials();
        if (!creds || !bearer || bearer !== creds.serviceKey) {
          return new Response(JSON.stringify({ error: "Forbidden" }), {
            status: 403,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const res = await ext.from("workspace_settings").select("user_id,weekly_digest").eq("weekly_digest", true);
        if (res.error) throw new Error(res.error.message);
        const rows = res.data || [];
        const results = [];
        for (const row of rows) {
          results.push({
            user_id: row.user_id,
            ...(await runWeeklyDigestForUser(row.user_id)),
          });
        }
        return ok({ success: true, results });
      }

      case "notifyTeamActivity": {
        const { actorUserId, title, body } = data || {};
        if (!actorUserId || !title) throw new Error("actorUserId and title are required");
        // The actor must be the authenticated user (this action bypassed the
        // userId auth gate above because it uses a different field name).
        const auth = await authenticateRequest(req, String(actorUserId));
        if (!auth.ok) {
          return new Response(JSON.stringify({ error: auth.error }), {
            status: auth.status,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const esc = (v: string) =>
          v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await notifyTeamActivity({
          actorUserId,
          title: esc(String(title).slice(0, 200)),
          body: esc(String(body || "").slice(0, 1000)),
        });
        return ok({ success: true });
      }

      default:
        throw new Error(`Unknown settings action: ${action}`);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    console.error("Settings function error:", msg);
    return err(msg);
  }
});
