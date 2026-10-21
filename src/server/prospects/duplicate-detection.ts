/**
 * Duplicate Detection for CRM Prospects
 *
 * Detects potential duplicate prospects by comparing:
 * - Email (exact match)
 * - Phone (normalized match)
 * - Name + Company (fuzzy match)
 */

export interface DuplicateMatch {
  prospectId: string;
  name: string;
  email?: string;
  phone?: string;
  companyName?: string;
  matchType: 'email' | 'phone' | 'name_company';
  confidence: number; // 0-100
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '').slice(-10); // Last 10 digits
}

function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

function normalizeString(str: string): string {
  return str.toLowerCase().trim().replace(/\s+/g, ' ');
}

function nameSimilarity(a: string, b: string): number {
  const na = normalizeString(a);
  const nb = normalizeString(b);
  if (na === nb) return 100;

  const tokensA = new Set(na.split(' ').filter(Boolean));
  const tokensB = new Set(nb.split(' ').filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  // One name being a token-level subset of the other — "Jon Smith" against
  // "Jon Michael Smith" — is a strong signal.
  //
  // This deliberately does NOT use raw substring containment
  // (`na.includes(nb)`). That would score any name that happened
  // to be a character prefix of another as an 80% match, which cleared the
  // threshold: "Jon Smith" matched "Jon Smithson", "Dan Lee" matched
  // "Dan Leeds", and on import those legitimate prospects were silently
  // skipped as duplicates. Requiring whole tokens keeps the intent and drops
  // the false positives.
  const subset =
    [...tokensA].every((t) => tokensB.has(t)) || [...tokensB].every((t) => tokensA.has(t));
  if (subset) return 80;

  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return Math.round((intersection.size / union.size) * 100);
}

/**
 * Find potential duplicates for a given prospect
 */
export function findDuplicates(
  target: { name?: string; email?: string; phone?: string; companyName?: string },
  prospects: Array<{ prospectId: string; name: string; email?: string; phone?: string; companyName?: string }>,
  excludeId?: string
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const seen = new Set<string>();

  for (const prospect of prospects) {
    if (prospect.prospectId === excludeId) continue;
    if (seen.has(prospect.prospectId)) continue;

    // Exact email match (highest confidence)
    if (target.email && prospect.email && normalizeEmail(target.email) === normalizeEmail(prospect.email)) {
      seen.add(prospect.prospectId);
      matches.push({
        prospectId: prospect.prospectId,
        name: prospect.name,
        email: prospect.email,
        phone: prospect.phone,
        companyName: prospect.companyName,
        matchType: 'email',
        confidence: 95,
      });
      continue;
    }

    // Phone match (high confidence)
    if (target.phone && prospect.phone) {
      const normalizedTarget = normalizePhone(target.phone);
      const normalizedProspect = normalizePhone(prospect.phone);
      if (normalizedTarget.length >= 7 && normalizedTarget === normalizedProspect) {
        seen.add(prospect.prospectId);
        matches.push({
          prospectId: prospect.prospectId,
          name: prospect.name,
          email: prospect.email,
          phone: prospect.phone,
          companyName: prospect.companyName,
          matchType: 'phone',
          confidence: 85,
        });
        continue;
      }
    }

    // Name + Company match (moderate confidence)
    if (target.name && prospect.name) {
      const similarity = nameSimilarity(target.name, prospect.name);
      if (similarity >= 80) {
        // If company also matches, higher confidence
        let confidence = similarity * 0.6;
        if (target.companyName && prospect.companyName) {
          const companySimilarity = nameSimilarity(target.companyName, prospect.companyName);
          if (companySimilarity >= 70) {
            confidence = Math.min(similarity * 0.5 + companySimilarity * 0.3 + 10, 90);
          }
        }

        if (confidence >= 50) {
          seen.add(prospect.prospectId);
          matches.push({
            prospectId: prospect.prospectId,
            name: prospect.name,
            email: prospect.email,
            phone: prospect.phone,
            companyName: prospect.companyName,
            matchType: 'name_company',
            confidence: Math.round(confidence),
          });
        }
      }
    }
  }

  return matches.sort((a, b) => b.confidence - a.confidence);
}
