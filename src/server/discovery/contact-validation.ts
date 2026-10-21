import { normalizePhone, type PhoneRegion } from './phone';
/**
 * Advanced Contact Data Validation
 * Filters out fake, placeholder, and low-quality email/phone data.
 * Used as final validation layer before storing lead contact info.
 */

// ============================================
// EMAIL VALIDATION
// ============================================

/**
 * Comprehensive email validation - syntax, domain quality, and anti-fake patterns.
 * Returns true only if email appears to be a real, reachable business contact.
 */
export function isValidBusinessEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;

  const lower = email.toLowerCase().trim();

  // 1. Basic syntax validation
  const emailRegex = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!emailRegex.test(lower)) return false;

  // 2. Extract domain
  const domain = lower.split('@')[1];
  if (!domain) return false;

  // 3. Reject generic mailboxes (not personal contacts)
  const genericPrefixes = /^(no-?reply|info|contact|hello|support|admin|help|sales|marketing|press|media|hr|careers|jobs|team|billing|accounts|webmaster|postmaster|abuse|service|customerservice|privacy|legal|compliance)@/i;
  if (genericPrefixes.test(lower)) return false;

  // 4. Reject placeholder/test domains
  const placeholderDomains = [
    'example.com', 'example.org', 'example.net',
    'test.com', 'test.org', 'testing.com',
    'localhost', 'yourdomain.com', 'domain.com',
    'email.com', 'mail.com', 'tempmail.com',
    'sample.com', 'demo.com', 'placeholder.com',
  ];
  if (placeholderDomains.some(pd => domain.endsWith(pd))) return false;

  // 5. Reject temporary/disposable email domains (common ones)
  const disposableDomains = [
    'mailinator.com', 'guerrillamail.com', '10minutemail.com',
    'throwaway.email', 'yopmail.com', 'temp-mail.org',
    'maildrop.cc', 'trashmail.com', 'getnada.com',
  ];
  if (disposableDomains.some(dd => domain.endsWith(dd))) return false;

  // 6. Reject emails with suspicious patterns
  if (lower.includes('noreply')) return false;
  if (lower.includes('donotreply')) return false;
  if (/\d{8,}@/.test(lower)) return false; // Long number sequences as username
  if (lower.split('@')[0].length < 2) return false; // Too short username

  // 7. Reject common fake patterns
  const fakePrefixes = ['fake', 'test', 'dummy', 'sample', 'placeholder', 'none', 'na', 'n/a'];
  const username = lower.split('@')[0];
  if (fakePrefixes.some(fp => username.includes(fp))) return false;

  // 8. Reject image file extensions (sometimes scraped as emails)
  if (/\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i.test(lower)) return false;

  // 9. Domain quality checks
  const tld = domain.split('.').pop();
  if (!tld || tld.length < 2) return false;

  // Reject very suspicious TLDs commonly used for spam/fake emails
  const spamTlds = ['xyz', 'top', 'tk', 'ml', 'ga', 'cf', 'gq'];
  if (spamTlds.includes(tld)) return false;

  return true;
}

/**
 * Additional check: email belongs to the correct company domain.
 * Useful when we know the company domain and want to verify the email matches.
 */
export function emailMatchesDomain(email: string, expectedDomain: string): boolean {
  if (!email || !expectedDomain) return false;

  const emailDomain = email.toLowerCase().split('@')[1];
  const normalizedExpected = expectedDomain.toLowerCase().replace(/^www\./, '');

  // Exact match or subdomain match
  return emailDomain === normalizedExpected || emailDomain.endsWith(`.${normalizedExpected}`);
}

// ============================================
// PHONE NUMBER VALIDATION
// ============================================

/**
 * Check if phone appears with generic business context keywords.
 * These indicate it's a general contact line, not a decision-maker's direct number.
 */
function hasGenericBusinessContext(phone: string, contextText?: string): boolean {
  if (!contextText) return false;

  const lowerContext = contextText.toLowerCase();
  const genericKeywords = [
    'customer service', 'customer support', 'support line', 'help desk',
    'sales inquiries', 'general inquiries', 'main office', 'reception',
    'toll free', 'toll-free', 'contact form', 'contact us',
    'for inquiries', 'business inquiries', 'press inquiries',
  ];

  return genericKeywords.some(keyword => lowerContext.includes(keyword));
}

/**
 * Comprehensive phone validation - format, length, country code, anti-fake patterns.
 * Returns true only if phone appears to be a real, reachable number.
 *
 * @param phone - Phone number to validate
 * @param contextText - Optional surrounding text for context-aware validation
 */
export function isValidBusinessPhone(phone: string, contextText?: string): boolean {
  if (!phone || typeof phone !== 'string') return false;

  const cleaned = phone.trim();
  const digits = cleaned.replace(/\D/g, '');

  // 1. Length validation (international phones: 10-15 digits)
  if (digits.length < 10 || digits.length > 15) return false;

  // 2. Reject obvious fake/test numbers
  const fakePatterns = [
    /^0{10,}$/, // All zeros
    /^1{10,}$/, // All ones
    /^9{10,}$/, // All nines
    /^(12345|123456|1234567|12345678|123456789|1234567890)/, // Sequential digits
    /^(555)555/, // North American fake prefix (555-555-xxxx)
    /^(000|111|222|333|444|666|777|888|999)/, // Repeating groups
  ];
  if (fakePatterns.some(pattern => pattern.test(digits))) return false;

  // 3. Reject placeholder patterns
  if (cleaned.toLowerCase().includes('xxx')) return false;
  if (cleaned.includes('000-000')) return false;
  if (/x{3,}/i.test(cleaned)) return false; // Multiple x's

  // 4. Indian phone number validation (if detected)
  if (digits.length === 10 && /^[6-9]/.test(digits)) {
    // Valid Indian mobile: starts with 6, 7, 8, or 9
    return true;
  }
  if ((digits.length === 12 || digits.length === 11) && digits.startsWith('91')) {
    // Indian number with country code
    const mobileDigits = digits.slice(-10);
    if (!/^[6-9]/.test(mobileDigits)) return false; // Invalid Indian mobile prefix
    return true;
  }

  // 5. North American validation (if detected)
  if (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) {
    const localDigits = digits.length === 11 ? digits.slice(1) : digits;
    const areaCode = localDigits.slice(0, 3);
    const exchange = localDigits.slice(3, 6);

    // Reject invalid area codes
    if (areaCode.startsWith('0') || areaCode.startsWith('1')) return false;
    // Reject 555 exchange (reserved for fake numbers in movies)
    if (exchange === '555') return false;

    // Reject common VoIP/business line area codes (not personal numbers)
    // These are typically contact form/support lines, not decision-maker direct lines
    const voipAreaCodes = [
      '800', '888', '877', '866', '855', '844', '833', // Toll-free
      '900', // Premium rate
    ];
    if (voipAreaCodes.includes(areaCode)) return false;

    return true;
  }

  // 6. Must have country code indicator for international
  if (digits.length > 11 && !cleaned.startsWith('+')) {
    // Long number without + is suspicious
    return false;
  }

  // 7. Reject numbers with too many repeating digits
  const digitCounts: Record<string, number> = {};
  for (const digit of digits) {
    digitCounts[digit] = (digitCounts[digit] || 0) + 1;
  }
  const maxRepeat = Math.max(...Object.values(digitCounts));
  if (maxRepeat > digits.length * 0.7) return false; // >70% same digit

  // 8. Context-aware check: reject if surrounded by generic business keywords
  if (contextText && hasGenericBusinessContext(phone, contextText)) {
    return false;
  }

  return true;
}

/**
 * Format phone number consistently (add country code if missing for known regions).
 */
export function formatPhoneNumber(phone: string): string {
  if (!phone) return '';

  const cleaned = phone.trim();
  const digits = cleaned.replace(/\D/g, '');

  // Indian mobile: 10 digits starting with 6-9, no country code
  if (digits.length === 10 && /^[6-9]/.test(digits) && !cleaned.includes('+')) {
    return `+91${digits}`;
  }

  // Already has + and valid length
  if (cleaned.startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return cleaned;
  }

  // Has country code but missing +
  if (digits.length === 12 && digits.startsWith('91')) {
    return `+${digits}`;
  }

  return cleaned;
}

// ============================================
// COMBINED VALIDATION
// ============================================

export interface ValidatedContact {
  email?: string;
  phone?: string;
  validationIssues?: string[];
}

/**
 * Validate and clean contact data in one pass.
 * Returns only valid data, with issues logged for debugging.
 */
export function validateContactData(
  rawEmail?: string,
  rawPhone?: string,
  /**
   * The company's domain, or several. More than one is common and legitimate:
   * a venue may have its own site while its staff mail sits on the parent
   * group's domain. Passing a single domain used to be safe only because
   * domain resolution almost never succeeded — once it did, correctly scraped
   * addresses started being discarded as mismatches.
   */
  companyDomain?: string | string[],
  /** Expected country, so a switchboard from an unrelated page is rejected. */
  region?: PhoneRegion,
): ValidatedContact {
  const result: ValidatedContact = { validationIssues: [] };
  const domains = (Array.isArray(companyDomain) ? companyDomain : [companyDomain])
    .filter((d): d is string => Boolean(d));

  // Validate email
  if (rawEmail) {
    const emailValid = isValidBusinessEmail(rawEmail);
    const domainMatch =
      domains.length === 0 || domains.some((d) => emailMatchesDomain(rawEmail, d));

    if (emailValid && domainMatch) {
      result.email = rawEmail.toLowerCase().trim();
    } else {
      if (!emailValid) result.validationIssues!.push(`Email failed validation: ${rawEmail}`);
      if (!domainMatch) result.validationIssues!.push(`Email domain mismatch: ${rawEmail} vs ${domains.join(', ')}`);
    }
  }

  // Validate phone
  if (rawPhone) {
    const e164 = normalizePhone(rawPhone, region);
    if (e164) {
      result.phone = e164;
    } else {
      result.validationIssues!.push(`Phone failed validation: ${rawPhone}`);
    }
  }

  if (result.validationIssues!.length === 0) {
    delete result.validationIssues;
  }

  return result;
}
