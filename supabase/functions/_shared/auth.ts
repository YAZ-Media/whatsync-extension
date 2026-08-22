import { createClient } from "npm:@supabase/supabase-js@2";

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; error: string; status: number };

function getExternalAuthClient() {
  const url = Deno.env.get("EXTERNAL_SUPABASE_URL");
  const serviceKey = Deno.env.get("EXTERNAL_SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return null;
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/**
 * Validates the Bearer JWT from the external Supabase auth project.
 * When expectedUserId is provided, the token subject must match.
 */
export async function authenticateRequest(
  req: Request,
  expectedUserId?: string | null
): Promise<AuthResult> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, error: "Missing or invalid Authorization header", status: 401 };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) {
    return { ok: false, error: "Missing or invalid Authorization header", status: 401 };
  }

  const client = getExternalAuthClient();
  if (!client) {
    return { ok: false, error: "External database not configured", status: 500 };
  }

  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);

  if (error || !user?.id) {
    return { ok: false, error: "Invalid or expired session", status: 401 };
  }

  if (expectedUserId && expectedUserId !== user.id) {
    return { ok: false, error: "userId does not match authenticated user", status: 403 };
  }

  return { ok: true, userId: user.id };
}

export async function fetchUserProfileRole(
  userId: string
): Promise<{ role: string; status: string; organization_id?: string | null } | null> {
  const client = getExternalAuthClient();
  if (!client) return null;

  const { data, error } = await client
    .from("user_profiles")
    .select("role,status,organization_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return null;
  return data;
}
