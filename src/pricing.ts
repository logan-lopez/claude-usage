/** Pure, explicit (model, speed) lookup. Thinking is already in output tokens. */
import snapshot from "./pricing-snapshot.json";
export interface Rates {
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
}
export interface PriceInput {
  model: string | null;
  speed: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
}
export const pricingSnapshot = snapshot;
export function normalizeModel(model: string): string {
  // Dated API aliases only, never collapse context tiers or unrelated suffixes.
  return model.replace(/-\d{8}(?=\[|$)/, "");
}
export function estimateRequest(row: PriceInput): {
  usd: number | null;
  reason: string | null;
} {
  if (!row.model) return { usd: null, reason: "unknown model" };
  if (row.model.includes("[1m]"))
    return { usd: null, reason: "[1m] premium unknown" };
  const model = normalizeModel(row.model);
  const rates = (snapshot.models as Record<string, Record<string, Rates>>)[
    model
  ]?.[row.speed ?? "standard"];
  if (!rates)
    return {
      usd: null,
      reason: `no rate for ${model}/${row.speed ?? "standard"}`,
    };
  return {
    usd:
      (row.input_tokens * rates.input +
        row.output_tokens * rates.output +
        row.cache_creation_tokens * rates.cache_creation +
        row.cache_read_tokens * rates.cache_read) /
      1e6,
    reason: null,
  };
}
