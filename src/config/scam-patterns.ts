/** Deterministic scam signals used only for automatic rejection of imports. */
export const SCAM_PATTERNS = [
  /\b(?:pay|send|deposit)\b.{0,35}\b(?:upfront|advance|training|crypto|cryptocurrency)\b/i,
  /\b(?:crypto|cryptocurrency|bitcoin)\b.{0,35}\b(?:fee|payment|deposit|wallet)\b/i,
  /\bguaranteed\b.{0,30}\b(?:income|earnings|salary)\b.{0,30}\bno experience\b/i,
  /\b(?:telegram|whatsapp|signal)\b.{0,40}\b(?:apply|contact|message)\b/i,
  /\b(?:bit\.ly|tinyurl\.com|t\.co|shorturl\.at)\//i,
] as const;

export function matchesScamPattern(text: string): boolean {
  return SCAM_PATTERNS.some((pattern) => pattern.test(text));
}
