import schema from "../../docs/operator-action.schema.json" with { type: "json" };

interface Rule {
  $ref?: string;
  type?: string;
  const?: unknown;
  enum?: unknown[];
  oneOf?: Rule[];
  required?: string[];
  properties?: Record<string, Rule>;
  additionalProperties?: boolean;
  items?: Rule;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
}

// Only the keywords used by the vendored schema, not a general JSON Schema
// engine. Contract bounds are checked before traversing the action objects.
function matches(value: unknown, rule: Rule): boolean {
  if (rule.$ref) {
    const name = rule.$ref.replace(/^#\/\$defs\//, "");
    const ref = (schema.$defs as Record<string, Rule>)[name];
    return !!ref && matches(value, ref);
  }
  if (rule.oneOf && rule.oneOf.filter((r) => matches(value, r)).length !== 1) return false;
  if (Object.hasOwn(rule, "const") && value !== rule.const) return false;
  if (rule.enum && !rule.enum.includes(value)) return false;
  switch (rule.type) {
    case "null": return value === null;
    case "string": return typeof value === "string" && value.length >= (rule.minLength ?? 0) && value.length <= (rule.maxLength ?? Infinity) && (!rule.pattern || new RegExp(rule.pattern).test(value));
    case "integer": return Number.isSafeInteger(value) && (value as number) >= (rule.minimum ?? -Infinity) && (value as number) <= (rule.maximum ?? Infinity);
    case "array": return Array.isArray(value) && value.length >= (rule.minItems ?? 0) && value.length <= (rule.maxItems ?? Infinity) && value.every((v) => !rule.items || matches(v, rule.items));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const o = value as Record<string, unknown>;
      return (rule.required ?? []).every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => rule.properties?.[k] ? matches(o[k], rule.properties[k]) : rule.additionalProperties !== false);
    }
    default: return true;
  }
}

export function matchesActionSchema(value: unknown): boolean { return matches(value, schema as Rule); }
