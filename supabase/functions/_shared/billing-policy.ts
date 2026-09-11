export const PLAN_KEYS = ['Starter', 'Team', 'Business'] as const;
export type PlanKey = typeof PLAN_KEYS[number];
export function isPlan(value: unknown): value is PlanKey {
  return typeof value === 'string' && (PLAN_KEYS as readonly string[]).includes(value);
}
export function canManageBilling(role: string, status: string) {
  return status === 'Active' && ['Owner', 'Billing'].includes(role);
}
export function hasPaidAccess(status: string, periodEnd: string | null, now = Date.now()) {
  return ['active', 'trialing'].includes(status) && !!periodEnd && new Date(periodEnd).getTime() > now;
}
export function canMutateCrm(role: string, status: string) {
  return status === 'Active' && ['Owner', 'Admin', 'Member'].includes(role);
}
