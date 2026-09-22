export type HubSpotValidationDetails = {
  provider: 'hubspot';
  validation: boolean;
  objectType?: string;
  category?: string;
  subCategory?: string;
  correlationId?: string;
  requiredProperties: string[];
  errors?: Array<Record<string, unknown>>;
};

const PROPERTY_NAME = /^[A-Za-z0-9_]+$/;

function addProperty(target: Set<string>, value: unknown): void {
  const candidate = String(value ?? '').trim();
  if (PROPERTY_NAME.test(candidate)) target.add(candidate);
}

function scanRequiredMessage(target: Set<string>, value: unknown): void {
  if (typeof value !== 'string') return;
  const patterns = [
    /Property\s+['"`]([A-Za-z0-9_]+)['"`]\s+is required\b/gi,
    /\b([A-Za-z][A-Za-z0-9_]*)\s+is required because of a conditional property rule\b/gi,
    /A value for\s+['"`]?([A-Za-z][A-Za-z0-9_]*)['"`]?\s+must be provided\b/gi,
    /Missing required propert(?:y|ies)\s*:?\s*['"`]?([A-Za-z][A-Za-z0-9_]*)['"`]?/gi,
    /Required propert(?:y|ies)\s*:?\s*['"`]?([A-Za-z][A-Za-z0-9_]*)['"`]?/gi,
    /Required propert(?:y|ies)\s*:?\s*['"`\[]?([A-Za-z0-9_,\s'"`.-]+)\]?/gi,
    /Missing required propert(?:y|ies)\s*:?\s*['"`\[]?([A-Za-z0-9_,\s'"`.-]+)\]?/gi,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      for (const part of match[1].split(',')) addProperty(target, part.replace(/[\s'"`.-]+$/g, '').replace(/^[\s'"`.-]+/g, ''));
    }
  }
}

/** Extract only property internal names from HubSpot's validation response. */
export function extractHubSpotRequiredProperties(payload: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5 || value == null) return;
    if (typeof value === 'string') {
      scanRequiredMessage(found, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    for (const key of ['requiredProperties', 'missingRequiredProperties', 'conditionalRequiredProperties', 'missingProperties']) {
      const names = record[key];
      if (Array.isArray(names)) names.forEach((name) => addProperty(found, name));
      else addProperty(found, names);
    }
    const requiredSignal = [record.category, record.subCategory, record.code, record.error]
      .some((entry) => /required/i.test(String(entry ?? ''))) || /required/i.test(String(record.message ?? ''));
    if (requiredSignal) {
      addProperty(found, record.propertyName);
      addProperty(found, record.name);
      addProperty(found, record.property);
      const context = record.context && typeof record.context === 'object'
        ? record.context as Record<string, unknown>
        : null;
      for (const key of ['propertyName', 'propertyNames', 'requiredProperties', 'missingRequiredProperties']) {
        const contextProperties = context?.[key];
        if (Array.isArray(contextProperties)) contextProperties.forEach((name) => addProperty(found, name));
        else addProperty(found, contextProperties);
      }
    }
    for (const child of Object.values(record)) visit(child, depth + 1);
  };
  visit(payload);
  return [...found];
}

function safeErrorList(value: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const safe = value.slice(0, 20).map((item) => {
    const input = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const output: Record<string, unknown> = {};
    for (const key of ['message', 'category', 'subCategory', 'code', 'name', 'propertyName']) {
      if (typeof input[key] === 'string') output[key] = String(input[key]).slice(0, 1000);
    }
    return output;
  });
  return safe.length ? safe : undefined;
}

export function buildHubSpotValidationDetails(payload: unknown, path: string): HubSpotValidationDetails {
  const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const objectMatch = path.match(/\/crm\/objects\/(?:v3|\d{4}-\d{2})\/([^/?]+)/);
  const requiredProperties = extractHubSpotRequiredProperties(payload);
  return {
    provider: 'hubspot',
    validation: requiredProperties.length > 0,
    ...(objectMatch?.[1] ? { objectType: decodeURIComponent(objectMatch[1]) } : {}),
    ...(typeof input.category === 'string' ? { category: input.category } : {}),
    ...(typeof input.subCategory === 'string' ? { subCategory: input.subCategory } : {}),
    ...(typeof input.correlationId === 'string' ? { correlationId: input.correlationId } : {}),
    requiredProperties,
    ...(safeErrorList(input.errors) ? { errors: safeErrorList(input.errors) } : {}),
  };
}
