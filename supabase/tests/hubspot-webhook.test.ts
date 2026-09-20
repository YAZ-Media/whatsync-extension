import { handleHubSpotWebhook } from "../functions/_shared/hubspotWebhook.ts";

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

async function sign(
  secret: string,
  method: string,
  uri: string,
  body: string,
  timestamp: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${method}${uri}${body}${timestamp}`),
    ),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function signedRequest(
  body: string,
  secret = "fixture-secret",
  timestamp = String(Date.now()),
): Promise<Request> {
  const uri = "https://example.supabase.co/functions/v1/hubspot";
  const signature = await sign(secret, "POST", uri, body, timestamp);
  return new Request(uri, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hubspot-request-timestamp": timestamp,
      "x-hubspot-signature-v3": signature,
    },
    body,
  });
}

Deno.test("signed privacy deletion purges contact activity for the whole workspace", async () => {
  const body = JSON.stringify([{
    portalId: 12345,
    objectId: 67890,
    subscriptionType: "contact.privacyDeletion",
  }]);
  const requests: Array<{ path: string; method: string }> = [];
  const databaseRequest = async (path: string, init: RequestInit = {}) => {
    requests.push({ path, method: init.method ?? "GET" });
    if (path.startsWith("hubspot_connections?")) {
      return Response.json([{ user_id: "owner-id" }]);
    }
    if (path.startsWith("user_profiles?user_id=")) {
      return Response.json([{ organization_id: "workspace-id" }]);
    }
    if (path.startsWith("user_profiles?organization_id=")) {
      return Response.json([{ user_id: "owner-id" }, { user_id: "member-id" }]);
    }
    if (path.startsWith("hubspot_contact_logs?")) {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected database request: ${path}`);
  };

  const response = await handleHubSpotWebhook(
    await signedRequest(body),
    "fixture-secret",
    databaseRequest,
  );
  equal(response.status, 200);
  equal(await response.json(), { received: true });
  equal(requests.filter((request) => request.method === "DELETE").length, 4);
  equal(
    requests.every((request) =>
      !request.path.includes("email") && !request.path.includes("phone_number")
    ),
    true,
  );
});

Deno.test("forged or stale HubSpot webhooks are rejected before database access", async () => {
  const body = JSON.stringify([{
    portalId: 12345,
    objectId: 67890,
    subscriptionType: "contact.privacyDeletion",
  }]);
  let databaseCalls = 0;
  const databaseRequest = async () => {
    databaseCalls++;
    return Response.json([]);
  };

  const forged = await signedRequest(body, "wrong-secret");
  equal(
    (await handleHubSpotWebhook(forged, "fixture-secret", databaseRequest))
      .status,
    401,
  );

  const staleTimestamp = String(Date.now() - 6 * 60 * 1000);
  const stale = await signedRequest(body, "fixture-secret", staleTimestamp);
  equal(
    (await handleHubSpotWebhook(stale, "fixture-secret", databaseRequest))
      .status,
    401,
  );
  equal(databaseCalls, 0);
});
