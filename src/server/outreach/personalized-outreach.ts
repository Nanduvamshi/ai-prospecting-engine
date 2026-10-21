/**
 * Personalized Outreach Drafting — Phase 2 AI layer.
 *
 * Given a prospect + known intent signals + customer context, drafts a first-
 * touch cold-email (or multi-channel) message that references specific signals
 * — "I saw you raised Series B" — instead of the generic templates that
 * typical sales sequences send.
 *
 * Output is structured (subject + opener + body + CTA) so it can be plugged
 * into the workflow engine's email-send action OR surfaced as a suggestion
 * in the copilot inbox.
 */

import { getProviderRouter } from '@/server/ai/providers';
import type { ProspectProfile } from '@/server/icp/fit-scoring';

/** What the customer wants to pitch, and how they sound. */
export interface CustomerContext {
  /** Customer's company name — appears in signature */
  companyName: string;
  /** One-line value prop ("AI workspace that unifies CRM + email + WhatsApp") */
  valueProp: string;
  /** Specific use cases we can hook into ("cut sales response time 60%") */
  useCases?: string[];
  /** Tone: "formal" | "casual" | "consultative" | "direct" */
  tone?: OutreachTone;
  /** Sender's name (appears in signature + sign-off) */
  senderName?: string;
  /** Sender's title */
  senderTitle?: string;
  /** Social-proof logos/names we can drop ("helped Loom, Notion, ...") */
  socialProof?: string[];
  /** Optional calendar booking link — when present, AI uses it as the CTA */
  bookingUrl?: string;
}

export type OutreachTone = 'formal' | 'casual' | 'consultative' | 'direct';

/** Specific intent-signal context to hook the opener into. */
export interface OutreachSignalContext {
  /** Competitor detected on their site — hook: "switching from X?" */
  competitors?: string[];
  /** Recent funding — hook: "congrats on the Series B" */
  fundingRound?: string;
  /** New executive — hook: "heard you just joined as CRO" */
  recentExecChange?: { role: string; execName?: string };
  /** ICP roles they're hiring — hook: "saw you're hiring 3 CSMs" */
  hiringRoles?: string[];
  /** Tool-switch detected — hook: "noticed you removed HubSpot" */
  toolSwitch?: { added?: string[]; removed?: string[] };
}

export type OutreachChannel = 'email' | 'linkedin' | 'whatsapp';

export interface DraftedOutreach {
  channel: OutreachChannel;
  subject?: string; // email only
  body: string;
  /** The hook used, so the sales rep knows why this draft reads this way */
  hookSummary: string;
  /** Confidence the draft references real, specific signal context (0-1) */
  specificityScore: number;
}

function toneGuidance(tone?: OutreachTone): string {
  switch (tone) {
    case 'formal': return 'Professional, polished. Full sentences. No contractions.';
    case 'casual': return 'Warm and human. Contractions OK. Can use one emoji if it fits.';
    case 'consultative': return 'Curious and question-led. Frame as offering to help, not to sell.';
    case 'direct': return 'Cut to the chase. Short sentences. Skip pleasantries.';
    default: return 'Warm but professional. No fluff.';
  }
}

function channelGuidance(channel: OutreachChannel): string {
  switch (channel) {
    case 'email':
      return 'Format as cold email. Subject 5-8 words. Body 3-4 short paragraphs, max 100 words. End with a single low-commitment CTA (e.g., "worth a quick call?").';
    case 'linkedin':
      return 'Format as LinkedIn connection-request note OR InMail. Max 300 characters if connection request, 800 if InMail. Skip subject. No salutation needed.';
    case 'whatsapp':
      return 'Format as WhatsApp message. Very short — 2-3 sentences max. No subject. Casual punctuation.';
  }
}

function summarizeHook(signals: OutreachSignalContext): string {
  if (signals.recentExecChange?.execName) return `New ${signals.recentExecChange.role} ${signals.recentExecChange.execName}`;
  if (signals.toolSwitch?.removed?.length) return `Removed ${signals.toolSwitch.removed[0]}`;
  if (signals.fundingRound) return `Recent ${signals.fundingRound}`;
  if (signals.competitors?.length) return `Uses ${signals.competitors[0]}`;
  if (signals.hiringRoles?.length) return `Hiring ${signals.hiringRoles[0]}`;
  return 'No specific hook — generic warm opener';
}

function signalsToContext(signals: OutreachSignalContext): string {
  const lines: string[] = [];
  if (signals.fundingRound) lines.push(`- They just raised ${signals.fundingRound}.`);
  if (signals.recentExecChange) {
    const who = signals.recentExecChange.execName
      ? `${signals.recentExecChange.execName} (new ${signals.recentExecChange.role})`
      : `a new ${signals.recentExecChange.role}`;
    lines.push(`- They recently appointed ${who}.`);
  }
  if (signals.competitors?.length) lines.push(`- They currently use ${signals.competitors.join(', ')} — competitors of ours.`);
  if (signals.toolSwitch?.removed?.length) lines.push(`- They REMOVED ${signals.toolSwitch.removed.join(', ')} from their stack recently.`);
  if (signals.toolSwitch?.added?.length) lines.push(`- They ADDED ${signals.toolSwitch.added.join(', ')} to their stack recently.`);
  if (signals.hiringRoles?.length) lines.push(`- They are hiring: ${signals.hiringRoles.join(', ')}.`);
  return lines.join('\n') || '(No specific signals — rely on role/company-level warm opener.)';
}

/**
 * Draft a single personalized outreach message.
 * On model failure returns a minimal generic draft rather than throwing —
 * callers can distinguish by checking `specificityScore < 0.3`.
 */
export async function draftOutreach(opts: {
  prospect: ProspectProfile;
  customerContext: CustomerContext;
  signals?: OutreachSignalContext;
  channel: OutreachChannel;
}): Promise<DraftedOutreach> {
  const { prospect, customerContext, channel } = opts;
  const signals = opts.signals || {};
  const hookSummary = summarizeHook(signals);

  const prospectDesc = [
    prospect.name && `Name: ${prospect.name}`,
    prospect.title && `Title: ${prospect.title}`,
    prospect.company && `Company: ${prospect.company}`,
    prospect.industry && `Industry: ${prospect.industry}`,
  ].filter(Boolean).join(' | ') || '(minimal info)';

  try {
    const router = getProviderRouter();
    const response = await router.route({
      model: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
      maxTokens: 768,
      messages: [{
        role: 'user',
        content: `Write a first-touch cold outreach message.

PROSPECT: ${prospectDesc}

SIGNAL CONTEXT (use these to hook the opener — be specific, never fabricate):
${signalsToContext(signals)}

WHAT WE SELL: ${customerContext.valueProp}
${customerContext.useCases?.length ? `RELEVANT USE CASES:\n${customerContext.useCases.map(u => `- ${u}`).join('\n')}` : ''}
${customerContext.socialProof?.length ? `SOCIAL PROOF (use sparingly): ${customerContext.socialProof.join(', ')}` : ''}
${customerContext.bookingUrl ? `CTA: include this booking link as the call-to-action — ${customerContext.bookingUrl}` : ''}

SENDER: ${customerContext.senderName || 'Sales Team'}${customerContext.senderTitle ? `, ${customerContext.senderTitle}` : ''} at ${customerContext.companyName}

CHANNEL: ${channel}
${channelGuidance(channel)}

TONE: ${toneGuidance(customerContext.tone)}

Rules:
- NEVER fabricate signals. Only reference context that was actually provided.
- If no specific signals were provided, write a role-relevant warm opener without inventing a hook.
- No "I hope this finds you well". No "Just circling back". No "I wanted to reach out".
- Lead with THEM, not us.
- One low-commitment CTA at the end.

Return ONLY this JSON (no markdown):
{
  "subject": "subject line or empty string for non-email channels",
  "body": "the full message body",
  "specificityScore": 0.0-1.0 — how grounded in the given signals is this draft
}`,
      }],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text || text.type !== 'text') {
      return fallbackDraft(channel, customerContext, hookSummary);
    }
    const jsonMatch = text.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackDraft(channel, customerContext, hookSummary);
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      channel,
      subject: channel === 'email' ? (typeof parsed.subject === 'string' ? parsed.subject : undefined) : undefined,
      body: typeof parsed.body === 'string' ? parsed.body : '',
      hookSummary,
      specificityScore: Math.max(0, Math.min(1, Number(parsed.specificityScore) || 0)),
    };
  } catch (err) {
    console.error('[personalized-outreach] Claude call failed:', err);
    return fallbackDraft(channel, customerContext, hookSummary);
  }
}

function fallbackDraft(
  channel: OutreachChannel,
  customer: CustomerContext,
  hookSummary: string,
): DraftedOutreach {
  return {
    channel,
    subject: channel === 'email' ? `Quick question about ${customer.companyName}` : undefined,
    body: `Hi,\n\n${customer.valueProp}\n\nOpen to a 15-min chat this week?\n\n— ${customer.senderName || 'The team'} at ${customer.companyName}`,
    hookSummary,
    specificityScore: 0.1,
  };
}

/** Draft the same prospect across multiple channels in parallel. */
export async function draftMultiChannelOutreach(
  opts: Omit<Parameters<typeof draftOutreach>[0], 'channel'> & { channels: OutreachChannel[] },
): Promise<DraftedOutreach[]> {
  const results = await Promise.all(opts.channels.map(channel =>
    draftOutreach({ ...opts, channel }),
  ));
  return results;
}
