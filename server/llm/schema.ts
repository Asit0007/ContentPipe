/**
 * Gemini's `responseSchema` constrains decoding, so a schema-shaped answer was guaranteed. The other
 * providers in the chain (DeepSeek, Grok, Groq, ...) only offer `json_object` mode: valid JSON, no
 * promise about its shape. Two pieces close that gap:
 *
 *   toJsonSchema        the Gemini-format schemas in schemas.ts -> plain JSON Schema, which goes into
 *                       the prompt so the model knows the shape it is being held to;
 *   validateAgainstSchema  a local check of what came back, because downstream code trusts the shape.
 *
 * Only the keywords schemas.ts actually uses are handled: type, properties, required, items, enum,
 * minItems, maxItems, description. `propertyOrdering` is Gemini-only and is dropped.
 */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minItems?: number;
  maxItems?: number;
  description?: string;
};

export function toJsonSchema(schema: any, opts: { descriptions?: boolean } = {}): JsonSchema {
  if (!schema || typeof schema !== 'object') return {};
  const out: JsonSchema = {};
  if (typeof schema.type === 'string') out.type = schema.type.toLowerCase();
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toJsonSchema(v, opts);
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = toJsonSchema(schema.items, opts);
  if (Array.isArray(schema.enum)) out.enum = schema.enum;
  if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
  if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
  if (opts.descriptions !== false && typeof schema.description === 'string') out.description = schema.description;
  return out;
}

/** Human-readable problems, empty when `value` conforms. Capped so a bad answer can't flood a repair prompt. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, maxProblems = 12): string[] {
  const problems: string[] = [];
  walk(value, schema, '$', problems, maxProblems);
  return problems;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function walk(value: unknown, s: JsonSchema, path: string, out: string[], max: number): void {
  if (out.length >= max) return;

  if (s.type) {
    const actual = typeOf(value);
    const ok =
      s.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
      : s.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : actual === s.type;
    if (!ok) {
      out.push(`${path}: expected ${s.type}, got ${actual}`);
      return; // children of a wrong-typed node are noise
    }
  }

  if (s.enum && !s.enum.includes(value as never)) {
    out.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
    return;
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) out.push(`${path}: needs at least ${s.minItems} items, has ${value.length}`);
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) out.push(`${path}: allows at most ${s.maxItems} items, has ${value.length}`);
    if (s.items) value.forEach((item, i) => walk(item, s.items!, `${path}[${i}]`, out, max));
    return;
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of s.required ?? []) {
      if (!(key in obj) || obj[key] === undefined || obj[key] === null) out.push(`${path}.${key}: required but missing`);
    }
    if (s.properties) {
      for (const [key, sub] of Object.entries(s.properties)) {
        if (key in obj && obj[key] !== undefined && obj[key] !== null) walk(obj[key], sub, `${path}.${key}`, out, max);
      }
    }
  }
}
