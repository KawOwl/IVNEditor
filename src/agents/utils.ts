/**
 * Shared utilities for AI agent response parsing.
 */

/**
 * Extract JSON from a text response that may contain markdown fences or extra text.
 */
export function extractJSON(text: string): string {
  // Try to extract from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) return fenceMatch[1].trim();

  // Try to find a JSON object directly
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) return jsonMatch[0];

  // Try to find a JSON array
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];

  return text.trim();
}
