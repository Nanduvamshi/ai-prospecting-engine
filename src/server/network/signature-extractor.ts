/**
 * Contact Graph — email-signature extractor.
 *
 * Given the raw text of an email body, asks Claude Haiku to identify the
 * sender's contact signature (if present) and return structured fields.
 * Refuses to fabricate — returns null when no signature is obviously present.
 *
 * This module is the data-ingestion surface that legal review must clear
 * before it runs in production. It is safe to import without side effects
 * (pure functions + Claude calls), but callers should check
 * `isContactGraphEnabled()` before invoking.
 */

import { getProviderRouter } from '@/server/ai/providers';
import { isContactGraphEnabled } from './config';
import type { ExtractedSignature } from './types';

const SIGNATURE_BLOCK_CLIPS = [
  // Common signature delimiters, in priority order
  /\n--\s*\n/,
  /\n_+\n/,
  /\n-+\n/,
  /\bBest regards?[,\s]/i,
  /\bSent from my (iPhone|iPad|BlackBerry|mobile)/i,
  /\bSincerely[,\s]/i,
  /\bThanks[,!\s]/i,
  /\bCheers[,\s]/i,
  /\bRegards[,\s]/i,
];

/**
 * Narrow the email body to the likely-signature tail section.
 * Avoids feeding entire email threads (including quoted replies) to Claude.
 */
function clipToSignatureRegion(body: string): string {
  if (!body) return '';
  let clipped = body;

  // Strip quoted-reply history (lines starting with > or "On DATE, X wrote:")
  clipped = clipped.replace(/\nOn .{10,100}wrote:[\s\S]*$/im, '');
  clipped = clipped
    .split('\n')
    .filter(line => !line.trimStart().startsWith('>'))
    .join('\n');

  // Find the last signature delimiter in the remaining body
  let bestIdx = -1;
  for (const pattern of SIGNATURE_BLOCK_CLIPS) {
    const m = clipped.match(pattern);
    if (m && m.index !== undefined && m.index > bestIdx) {
      bestIdx = m.index;
    }
  }

  if (bestIdx >= 0) {
    clipped = clipped.slice(bestIdx);
  }

  // Always cap at last 2000 chars regardless — signatures never exceed that
  return clipped.slice(-2000).trim();
}

/**
 * Extract a structured signature from the tail of an email body.
 * Returns null if no signature is detected with confidence.
 *
 * Behavior on failure:
 *   - No Claude model configured → returns null
 *   - Claude returns invalid JSON → returns null
 *   - Feature flag disabled → returns null immediately (no Claude call)
 */
export async function extractSignature(
  emailBody: string,
  senderEmail: string,
): Promise<ExtractedSignature | null> {
  if (!isContactGraphEnabled()) return null;
  if (!senderEmail || !emailBody) return null;

  const clipped = clipToSignatureRegion(emailBody);
  if (clipped.length < 20) return null;

  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 400,
      messages: [{
        role: 'user',
        content: `Extract the sender's contact signature from this email tail.
Return ONLY valid JSON — no markdown, no prose.

Rules:
- If there is no clear signature (e.g., this is just a casual reply), return:
  {"hasSignature": false}
- DO NOT infer / invent fields. Only extract what is clearly written.
- The signature should belong to the person whose email is: ${senderEmail}
- If another person's contact info appears (e.g., someone they're forwarding about), ignore it.

Schema when a signature is present:
{
  "hasSignature": true,
  "name": "string or null",
  "title": "string or null",
  "company": "string or null",
  "phone": "string or null (include country code if written)",
  "linkedinUrl": "full LinkedIn URL or null",
  "confidence": 0.0-1.0 — how confident you are this is a real signature (not a random paragraph)
}

EMAIL TAIL:
${clipped}`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') return null;
    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    if (!parsed.hasSignature) return null;
    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;
    if (confidence < 0.5) return null; // Drop low-confidence guesses

    // Sanity: if nothing meaningful was extracted, skip
    const hasMeaningfulField = parsed.name || parsed.title || parsed.company || parsed.phone || parsed.linkedinUrl;
    if (!hasMeaningfulField) return null;

    return {
      email: senderEmail,
      name: typeof parsed.name === 'string' ? parsed.name.trim() : undefined,
      title: typeof parsed.title === 'string' ? parsed.title.trim() : undefined,
      company: typeof parsed.company === 'string' ? parsed.company.trim() : undefined,
      phone: typeof parsed.phone === 'string' ? parsed.phone.trim() : undefined,
      linkedinUrl: typeof parsed.linkedinUrl === 'string' ? parsed.linkedinUrl.trim() : undefined,
      extractorConfidence: confidence,
    };
  } catch (err) {
    console.error('[contact-graph/signature-extractor] Claude call failed:', err);
    return null;
  }
}
