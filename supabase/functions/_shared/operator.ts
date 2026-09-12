// Platform ownership is a server-managed UUID allowlist, never a workspace role.
export function isOperator(userId: string): boolean {
  return (Deno.env.get('BILLING_ADMIN_USER_IDS') || '').split(',').map(id => id.trim()).filter(Boolean).includes(userId);
}
