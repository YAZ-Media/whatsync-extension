// HMAC-signed team invite tokens.
//
// An invite link must not be forgeable: role and organization are only honored
// at signup when they arrive inside a token signed by the server. The signing
// key is derived from the service-role key (already present in every function's
// environment), so no extra secret needs to be provisioned.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InvitePayload {
  email: string;
  role: string;
  organizationId: string;
  invitedBy: string;
  exp: number;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getKey(): Promise<CryptoKey> {
  const secret = Deno.env.get('INVITE_SIGNING_SECRET') ||
    Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!secret) throw new Error('Invite signing secret not configured');
  const material = new TextEncoder().encode(`whatsync-invite:${secret}`);
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function signInviteToken(params: {
  email: string;
  role: string;
  organizationId: string;
  invitedBy: string;
}): Promise<string> {
  const payload: InvitePayload = {
    email: params.email.trim().toLowerCase(),
    role: params.role,
    organizationId: params.organizationId,
    invitedBy: params.invitedBy,
    exp: Date.now() + INVITE_TTL_MS,
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const key = await getKey();
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `${b64urlEncode(body)}.${b64urlEncode(sig)}`;
}

/** Returns the payload when the token is valid and unexpired, else null. */
export async function verifyInviteToken(token: string): Promise<InvitePayload | null> {
  try {
    const [bodyPart, sigPart] = String(token).split('.');
    if (!bodyPart || !sigPart) return null;
    const body = b64urlDecode(bodyPart);
    const sig = b64urlDecode(sigPart);
    const key = await getKey();
    const valid = await crypto.subtle.verify('HMAC', key, sig, body);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as InvitePayload;
    if (!payload?.email || !payload?.organizationId || !payload?.exp) return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Same construction, used to protect the HubSpot OAuth state parameter.
export async function signStatePayload(payload: Record<string, unknown>): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const key = await getKey();
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, body));
  return `${b64urlEncode(body)}.${b64urlEncode(sig)}`;
}

export async function verifyStatePayload<T = Record<string, unknown>>(
  token: string,
): Promise<T | null> {
  try {
    const [bodyPart, sigPart] = String(token).split('.');
    if (!bodyPart || !sigPart) return null;
    const body = b64urlDecode(bodyPart);
    const sig = b64urlDecode(sigPart);
    const key = await getKey();
    const valid = await crypto.subtle.verify('HMAC', key, sig, body);
    if (!valid) return null;
    return JSON.parse(new TextDecoder().decode(body)) as T;
  } catch {
    return null;
  }
}
