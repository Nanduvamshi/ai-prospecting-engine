/**
 * Lead Scoring Engine
 *
 * Configurable rule-based scoring for contacts and prospects.
 * Score range: 0-100.
 *
 * Rules are organized into categories:
 * - Engagement: email opens, replies, website visits
 * - Firmographic: company size, industry match, job title
 * - Behavioral: activity frequency, recency
 * - Channel: multi-channel engagement bonus
 */

export interface ScoringRule {
  id: string;
  category: 'engagement' | 'firmographic' | 'behavioral' | 'channel';
  label: string;
  description: string;
  points: number;
  condition: (data: ScoringData) => boolean;
}

export interface ScoringData {
  // Contact/Prospect fields
  name?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  jobTitle?: string;
  industry?: string;
  website?: string;
  status?: string;

  // Activity metrics
  totalActivities?: number;
  emailCount?: number;
  callCount?: number;
  meetingCount?: number;
  noteCount?: number;
  whatsappCount?: number;
  lastActivityDate?: string;

  // Deal metrics
  dealCount?: number;
  wonDealCount?: number;
  totalRevenue?: number;

  // Engagement
  emailOpened?: boolean;
  emailReplied?: boolean;
  websiteVisited?: boolean;
  chatbotInteracted?: boolean;

  // Channel presence
  hasEmail?: boolean;
  hasPhone?: boolean;
  hasLinkedIn?: boolean;
  hasWhatsApp?: boolean;
}

// Default scoring rules
export const DEFAULT_SCORING_RULES: ScoringRule[] = [
  // Engagement rules
  {
    id: 'email_provided',
    category: 'engagement',
    label: 'Email provided',
    description: 'Contact has a valid email address',
    points: 5,
    condition: (d) => !!(d.email && d.email.includes('@')),
  },
  {
    id: 'phone_provided',
    category: 'engagement',
    label: 'Phone provided',
    description: 'Contact has a phone number',
    points: 5,
    condition: (d) => !!d.phone,
  },
  {
    id: 'email_opened',
    category: 'engagement',
    label: 'Opened email',
    description: 'Opened at least one email',
    points: 10,
    condition: (d) => !!d.emailOpened,
  },
  {
    id: 'email_replied',
    category: 'engagement',
    label: 'Replied to email',
    description: 'Replied to at least one email',
    points: 15,
    condition: (d) => !!d.emailReplied,
  },
  {
    id: 'website_visited',
    category: 'engagement',
    label: 'Visited website',
    description: 'Visited website via chatbot or tracking',
    points: 10,
    condition: (d) => !!d.websiteVisited,
  },

  // Firmographic rules
  {
    id: 'has_company',
    category: 'firmographic',
    label: 'Company identified',
    description: 'Company name is known',
    points: 5,
    condition: (d) => !!d.companyName,
  },
  {
    id: 'has_job_title',
    category: 'firmographic',
    label: 'Job title known',
    description: 'Job title is provided',
    points: 5,
    condition: (d) => !!d.jobTitle,
  },
  {
    id: 'decision_maker_title',
    category: 'firmographic',
    label: 'Decision maker title',
    description: 'Title suggests decision-making authority (CEO, CTO, VP, Director, Head, Manager)',
    points: 15,
    condition: (d) => {
      if (!d.jobTitle) return false;
      const t = d.jobTitle.toLowerCase();
      return /\b(ceo|cto|cfo|coo|cmo|vp|vice president|director|head of|manager|founder|owner|partner)\b/.test(t);
    },
  },
  {
    id: 'has_website',
    category: 'firmographic',
    label: 'Website available',
    description: 'Company website is known',
    points: 3,
    condition: (d) => !!d.website,
  },

  // Behavioral rules
  {
    id: 'active_recently',
    category: 'behavioral',
    label: 'Active in last 7 days',
    description: 'Had activity within the last week',
    points: 10,
    condition: (d) => {
      if (!d.lastActivityDate) return false;
      const diff = Date.now() - new Date(d.lastActivityDate).getTime();
      return diff < 7 * 24 * 60 * 60 * 1000;
    },
  },
  {
    id: 'multiple_activities',
    category: 'behavioral',
    label: 'Multiple interactions',
    description: '3+ total activities recorded',
    points: 10,
    condition: (d) => (d.totalActivities || 0) >= 3,
  },
  {
    id: 'has_deals',
    category: 'behavioral',
    label: 'Has associated deals',
    description: 'At least one deal created',
    points: 10,
    condition: (d) => (d.dealCount || 0) > 0,
  },
  {
    id: 'has_revenue',
    category: 'behavioral',
    label: 'Revenue generated',
    description: 'Has closed at least one deal',
    points: 15,
    condition: (d) => (d.wonDealCount || 0) > 0,
  },

  // Channel rules
  {
    id: 'multi_channel',
    category: 'channel',
    label: 'Multi-channel engagement',
    description: 'Engaged via 2+ channels (email, phone, WhatsApp, LinkedIn)',
    points: 10,
    condition: (d) => {
      let channels = 0;
      if (d.hasEmail || d.emailCount) channels++;
      if (d.hasPhone || d.callCount) channels++;
      if (d.hasWhatsApp || d.whatsappCount) channels++;
      if (d.hasLinkedIn) channels++;
      return channels >= 2;
    },
  },
];

/**
 * Calculate lead score based on scoring rules
 */
export function calculateLeadScore(
  data: ScoringData,
  rules: ScoringRule[] = DEFAULT_SCORING_RULES
): { score: number; matchedRules: ScoringRule[]; breakdown: Record<string, number> } {
  const matchedRules: ScoringRule[] = [];
  const breakdown: Record<string, number> = {
    engagement: 0,
    firmographic: 0,
    behavioral: 0,
    channel: 0,
  };

  let rawScore = 0;

  for (const rule of rules) {
    try {
      if (rule.condition(data)) {
        matchedRules.push(rule);
        rawScore += rule.points;
        breakdown[rule.category] = (breakdown[rule.category] || 0) + rule.points;
      }
    } catch {
      // Skip rules that error
    }
  }

  // Cap at 100
  const score = Math.min(rawScore, 100);

  return { score, matchedRules, breakdown };
}

/**
 * Get score label and color based on score value
 */
export function getScoreInfo(score: number): { label: string; color: string; bgClass: string } {
  if (score >= 80) return { label: 'Hot', color: '#EF4444', bgClass: 'bg-red-500' };
  if (score >= 60) return { label: 'Warm', color: '#F59E0B', bgClass: 'bg-amber-500' };
  if (score >= 40) return { label: 'Moderate', color: '#3B82F6', bgClass: 'bg-blue-500' };
  if (score >= 20) return { label: 'Cool', color: '#6B7280', bgClass: 'bg-gray-500' };
  return { label: 'Cold', color: '#9CA3AF', bgClass: 'bg-gray-400' };
}

/**
 * Build ScoringData from a contact object
 */
export function buildScoringDataFromContact(contact: Record<string, any>, activities?: any[]): ScoringData {
  const activityCounts = (activities || []).reduce(
    (acc, a) => {
      acc.total++;
      if (a.type === 'email') acc.email++;
      else if (a.type === 'call') acc.call++;
      else if (a.type === 'meeting') acc.meeting++;
      else if (a.type === 'note') acc.note++;
      else if (a.type === 'whatsapp') acc.whatsapp++;
      return acc;
    },
    { total: 0, email: 0, call: 0, meeting: 0, note: 0, whatsapp: 0 }
  );

  return {
    name: contact.name,
    email: contact.email,
    phone: contact.phone,
    companyName: contact.companyName || contact.company,
    jobTitle: contact.jobTitle || contact.title,
    industry: contact.industry,
    website: contact.website,
    status: contact.status,
    totalActivities: contact.totalActivities || activityCounts.total,
    emailCount: activityCounts.email,
    callCount: activityCounts.call,
    meetingCount: activityCounts.meeting,
    noteCount: activityCounts.note,
    whatsappCount: activityCounts.whatsapp,
    lastActivityDate: contact.lastActivityDate,
    dealCount: contact.dealCount,
    wonDealCount: contact.wonDealCount,
    totalRevenue: contact.totalRevenue,
    hasEmail: !!contact.email,
    hasPhone: !!contact.phone,
    hasLinkedIn: !!contact.linkedinUrl,
    hasWhatsApp: !!contact.sources?.whatsapp,
  };
}
