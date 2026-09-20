const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

type DatabaseRequest = (path: string, init?: RequestInit) => Promise<Response>;

type HubSpotWebhookEvent = {
  portalId?: number | string;
  objectId?: number | string;
  subscriptionType?: string;
  eventType?: string;
};

const HUBSPOT_URI_DECODE: Record<string, string> = {
  "%21": "!",
  "%24": "$",
  "%27": "'",
  "%28": "(",
  "%29": ")",
  "%2A": "*",
  "%2C": ",",
  "%2F": "/",
  "%3A": ":",
  "%3B": ";",
  "%3F": "?",
  "%40": "@",
};

function signatureUri(uri: string): string {
  return uri.replace(
    /%[0-9a-f]{2}/gi,
    (encoded) => HUBSPOT_URI_DECODE[encoded.toUpperCase()] ?? encoded,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function isHubSpotWebhookRequest(request: Request): boolean {
  return request.headers.has("x-hubspot-signature-v3") ||
    request.headers.has("x-hubspot-request-timestamp") ||
    request.headers.has("x-hubspot-signature");
}

export async function verifyHubSpotSignatureV3(
  request: Request,
  rawBody: string,
  clientSecret: string,
  now = Date.now(),
): Promise<boolean> {
  const signature = request.headers.get("x-hubspot-signature-v3") ?? "";
  const timestampHeader = request.headers.get("x-hubspot-request-timestamp") ??
    "";
  const timestamp = Number(timestampHeader);
  if (!signature || !timestampHeader || !Number.isFinite(timestamp)) {
    return false;
  }
  if (Math.abs(now - timestamp) > MAX_SIGNATURE_AGE_MS) return false;

  const source = `${request.method}${
    signatureUri(request.url)
  }${rawBody}${timestampHeader}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(source),
  );
  return constantTimeEqual(bytesToBase64(new Uint8Array(digest)), signature);
}

async function workspaceUsersForPortal(
  portalId: string,
  databaseRequest: DatabaseRequest,
): Promise<Set<string>> {
  const connectionResponse = await databaseRequest(
    `hubspot_connections?portal_id=eq.${
      encodeURIComponent(portalId)
    }&select=user_id`,
  );
  if (!connectionResponse.ok) {
    throw new Error(
      `Could not resolve HubSpot portal (${connectionResponse.status})`,
    );
  }

  const connectedUsers = (await connectionResponse.json()) as Array<
    { user_id?: string }
  >;
  const userIds = new Set(
    connectedUsers.map((row) => row.user_id).filter((id): id is string =>
      Boolean(id)
    ),
  );

  for (const connectedUserId of [...userIds]) {
    const profileResponse = await databaseRequest(
      `user_profiles?user_id=eq.${connectedUserId}&select=organization_id&limit=1`,
    );
    if (!profileResponse.ok) {
      throw new Error(
        `Could not resolve workspace (${profileResponse.status})`,
      );
    }
    const profiles = (await profileResponse.json()) as Array<
      { organization_id?: string | null }
    >;
    const organizationId = profiles[0]?.organization_id;
    if (!organizationId) continue;

    const membersResponse = await databaseRequest(
      `user_profiles?organization_id=eq.${organizationId}&select=user_id`,
    );
    if (!membersResponse.ok) {
      throw new Error(
        `Could not resolve workspace members (${membersResponse.status})`,
      );
    }
    const members = (await membersResponse.json()) as Array<
      { user_id?: string }
    >;
    for (const member of members) {
      if (member.user_id) userIds.add(member.user_id);
    }
  }

  return userIds;
}

async function purgeContactActivity(
  portalId: string,
  contactId: string,
  databaseRequest: DatabaseRequest,
): Promise<number> {
  const userIds = await workspaceUsersForPortal(portalId, databaseRequest);
  for (const userId of userIds) {
    const paths = [
      `hubspot_contact_logs?user_id=eq.${userId}&hubspot_contact_id=eq.${
        encodeURIComponent(contactId)
      }`,
      `hubspot_contact_logs?user_id=eq.${userId}&hubspot_object_type=eq.contact&hubspot_object_id=eq.${
        encodeURIComponent(contactId)
      }`,
    ];
    for (const path of paths) {
      const response = await databaseRequest(path, {
        method: "DELETE",
        headers: { Prefer: "return=minimal" },
      });
      if (!response.ok) {
        throw new Error(
          `Could not remove contact activity (${response.status})`,
        );
      }
    }
  }
  return userIds.size;
}

function webhookResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export async function handleHubSpotWebhook(
  request: Request,
  clientSecret: string,
  databaseRequest: DatabaseRequest,
): Promise<Response> {
  if (!clientSecret) {
    return webhookResponse({ error: "Webhook is not configured" }, 503);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
    return webhookResponse({ error: "Payload too large" }, 413);
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return webhookResponse({ error: "Payload too large" }, 413);
  }
  if (!(await verifyHubSpotSignatureV3(request, rawBody, clientSecret))) {
    return webhookResponse({ error: "Invalid webhook signature" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return webhookResponse({ error: "Invalid JSON payload" }, 400);
  }
  const events =
    (Array.isArray(parsed) ? parsed : [parsed]) as HubSpotWebhookEvent[];
  if (events.length > 1000) {
    return webhookResponse({ error: "Too many events" }, 413);
  }

  const deletions = new Map<string, { portalId: string; contactId: string }>();
  for (const event of events) {
    const eventType = event?.subscriptionType ?? event?.eventType;
    const portalId = String(event?.portalId ?? "");
    const contactId = String(event?.objectId ?? "");
    if (eventType !== "contact.privacyDeletion") continue;
    if (!/^\d+$/.test(portalId) || !/^\d+$/.test(contactId)) continue;
    deletions.set(`${portalId}:${contactId}`, { portalId, contactId });
  }

  let affectedWorkspaceUsers = 0;
  for (const deletion of deletions.values()) {
    affectedWorkspaceUsers += await purgeContactActivity(
      deletion.portalId,
      deletion.contactId,
      databaseRequest,
    );
  }

  console.info("[hubspot-webhook] privacy deletion processed", {
    events: events.length,
    deletions: deletions.size,
    affectedWorkspaceUsers,
  });
  return webhookResponse({ received: true }, 200);
}
