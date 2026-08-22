export type ActivityTableConfig = {
  tableName: string;
  userColumn: string;
  timestampColumn: string;
};

export const DEFAULT_ACTIVITY_CONFIG: ActivityTableConfig = {
  tableName: 'hubspot_contact_logs',
  userColumn: 'user_id',
  timestampColumn: 'created_at',
};

export const ACTIVITY_CONFIG_ROW_ID = 'default';

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSqlIdentifier(value: string, label: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `${label} must be a valid identifier (letters, numbers, underscore; cannot start with a number)`
    );
  }
}

export function getExternalSupabaseCredentials(): {
  url: string;
  serviceKey: string;
} | null {
  const url = Deno.env.get('EXTERNAL_SUPABASE_URL');
  const serviceKey = Deno.env.get('EXTERNAL_SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return null;
  return { url: url.replace(/\/$/, ''), serviceKey };
}

function configFromEnv(): ActivityTableConfig {
  return {
    tableName:
      Deno.env.get('EXTERNAL_ACTIVITY_TABLE_NAME') ||
      DEFAULT_ACTIVITY_CONFIG.tableName,
    userColumn:
      Deno.env.get('EXTERNAL_ACTIVITY_USER_COLUMN') ||
      DEFAULT_ACTIVITY_CONFIG.userColumn,
    timestampColumn:
      Deno.env.get('EXTERNAL_ACTIVITY_TIMESTAMP_COLUMN') ||
      DEFAULT_ACTIVITY_CONFIG.timestampColumn,
  };
}

export function normalizeActivityConfig(
  input?: Partial<ActivityTableConfig> | null
): ActivityTableConfig {
  const tableName = (input?.tableName || DEFAULT_ACTIVITY_CONFIG.tableName).trim();
  const userColumn = (input?.userColumn || DEFAULT_ACTIVITY_CONFIG.userColumn).trim();
  const timestampColumn = (
    input?.timestampColumn || DEFAULT_ACTIVITY_CONFIG.timestampColumn
  ).trim();

  assertSqlIdentifier(tableName, 'tableName');
  assertSqlIdentifier(userColumn, 'userColumn');
  assertSqlIdentifier(timestampColumn, 'timestampColumn');

  return { tableName, userColumn, timestampColumn };
}

export async function loadActivityConfig(
  overrides?: Partial<ActivityTableConfig>
): Promise<ActivityTableConfig> {
  if (overrides?.tableName || overrides?.userColumn || overrides?.timestampColumn) {
    return normalizeActivityConfig({
      tableName: overrides.tableName,
      userColumn: overrides.userColumn,
      timestampColumn: overrides.timestampColumn,
    });
  }

  const creds = getExternalSupabaseCredentials();
  if (creds) {
    const stored = await fetchStoredActivityConfig(creds.url, creds.serviceKey);
    if (stored) return stored;
  }

  return normalizeActivityConfig(configFromEnv());
}

async function fetchStoredActivityConfig(
  baseUrl: string,
  serviceKey: string
): Promise<ActivityTableConfig | null> {
  try {
    const url =
      `${baseUrl}/rest/v1/whatsync_activity_config?id=eq.${ACTIVITY_CONFIG_ROW_ID}&select=table_name,user_column,timestamp_column&limit=1`;

    const res = await fetch(url, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) return null;

    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;

    const row = rows[0];
    if (!row?.table_name || !row?.user_column) return null;

    return normalizeActivityConfig({
      tableName: row.table_name,
      userColumn: row.user_column,
      timestampColumn: row.timestamp_column || DEFAULT_ACTIVITY_CONFIG.timestampColumn,
    });
  } catch {
    return null;
  }
}

export async function saveActivityConfigToDb(
  config: ActivityTableConfig
): Promise<ActivityTableConfig> {
  const normalized = normalizeActivityConfig(config);
  const creds = getExternalSupabaseCredentials();
  if (!creds) {
    throw new Error('External database is not configured on the server');
  }

  await validateActivityTableAccess(creds.url, creds.serviceKey, normalized);

  const url = `${creds.url}/rest/v1/whatsync_activity_config?id=eq.${ACTIVITY_CONFIG_ROW_ID}`;
  const body = {
    id: ACTIVITY_CONFIG_ROW_ID,
    table_name: normalized.tableName,
    user_column: normalized.userColumn,
    timestamp_column: normalized.timestampColumn,
    updated_at: new Date().toISOString(),
  };

  const patchRes = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });

  if (patchRes.ok) {
    const patched = await patchRes.json();
    if (Array.isArray(patched) && patched.length > 0) {
      return normalized;
    }
  }

  const insertRes = await fetch(`${creds.url}/rest/v1/whatsync_activity_config`, {
    method: 'POST',
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });

  if (!insertRes.ok) {
    const errText = await insertRes.text();
    throw new Error(
      `Failed to save activity configuration: ${errText || insertRes.statusText}`
    );
  }

  return normalized;
}

export async function validateActivityTableAccess(
  baseUrl: string,
  serviceKey: string,
  config: ActivityTableConfig
): Promise<void> {
  const normalized = normalizeActivityConfig(config);
  const url = new URL(`${baseUrl}/rest/v1/${normalized.tableName}`);
  url.searchParams.set('select', '*');
  url.searchParams.set('limit', '1');

  const res = await fetch(url.toString(), {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!res.ok) {
    const errText = await res.text();
    let message = errText;
    try {
      const parsed = JSON.parse(errText);
      message = parsed?.message || parsed?.hint || errText;
    } catch {
      // keep raw text
    }
    throw new Error(
      `Cannot access table "${normalized.tableName}": ${message || res.statusText}`
    );
  }

  // Verify timestamp column if provided
  const orderUrl = new URL(`${baseUrl}/rest/v1/${normalized.tableName}`);
  orderUrl.searchParams.set('select', normalized.userColumn);
  orderUrl.searchParams.set('order', `${normalized.timestampColumn}.desc`);
  orderUrl.searchParams.set('limit', '1');

  const orderRes = await fetch(orderUrl.toString(), {
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
  });

  if (!orderRes.ok) {
    const errText = await orderRes.text();
    let message = errText;
    try {
      const parsed = JSON.parse(errText);
      message = parsed?.message || errText;
    } catch {
      // keep raw text
    }

    if (
      message.includes(`column ${normalized.tableName}.${normalized.timestampColumn}`) ||
      message.includes(`column ${normalized.timestampColumn}`)
    ) {
      throw new Error(
        `Timestamp column "${normalized.timestampColumn}" was not found on table "${normalized.tableName}"`
      );
    }
    if (
      message.includes(`column ${normalized.tableName}.${normalized.userColumn}`) ||
      message.includes(`column ${normalized.userColumn}`)
    ) {
      throw new Error(
        `User ID column "${normalized.userColumn}" was not found on table "${normalized.tableName}"`
      );
    }

    throw new Error(
      `Could not query table "${normalized.tableName}" with the provided columns: ${message}`
    );
  }
}

export async function postActivityLog(
  logEntry: Record<string, unknown>,
  config?: ActivityTableConfig
): Promise<{ ok: boolean; json: unknown; text: string; status: number }> {
  const creds = getExternalSupabaseCredentials();
  if (!creds) {
    throw new Error('External database not configured');
  }

  const resolved = config || await loadActivityConfig();
  const url = `${creds.url}/rest/v1/${resolved.tableName}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: creds.serviceKey,
      Authorization: `Bearer ${creds.serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(logEntry),
  });

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  return { ok: res.ok, json, text, status: res.status };
}

export function activityTableRestUrl(
  baseUrl: string,
  tableName: string,
  query?: Record<string, string>
): string {
  assertSqlIdentifier(tableName, 'tableName');
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/rest/v1/${tableName}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}
