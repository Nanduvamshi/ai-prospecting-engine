import 'server-only';

import { optional } from '@/server/env';

/**
 * Outbound email.
 *
 * Without something here, outreach sequences would be a data model that
 * advances state and never sends anything. So: an interface, a dev
 * implementation that records instead of sending, and room for a real one.
 *
 * The sequence runner calls this directly in-process — no HTTP round-trip
 * back into the app, and no internal shared secret to manage.
 *
 * Not yet supported: sending from the individual rep's own mailbox so the
 * prospect sees a person rather than the product. That needs per-user OAuth
 * token storage and is a feature in its own right.
 */

export interface OutboundMessage {
  orgId: string;
  /** Whose sequence this is — the intended sender identity. */
  fromUserId: string;
  to: string;
  subject: string;
  body: string;
  replyTo?: string;
}

export interface SendResult {
  messageId?: string;
  /** True when the message was recorded rather than actually transmitted. */
  simulated?: boolean;
}

export interface EmailSender {
  readonly id: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/**
 * Records the send and returns success without transmitting.
 *
 * This is the default, and it is what makes sequences testable end to end
 * with no mail provider: enrollments advance, history entries accumulate, the
 * runner's step logic is exercised, and nothing reaches a real inbox. Sending
 * test sequences to real prospects is a mistake you only get to make once.
 */
export class LogOnlyEmailSender implements EmailSender {
  readonly id = 'log';

  async send(message: OutboundMessage): Promise<SendResult> {
    console.log(
      `[email:log] (not sent) to=${message.to} subject=${JSON.stringify(message.subject)} ` +
        `org=${message.orgId} from=${message.fromUserId} bodyChars=${message.body.length}`,
    );
    return { messageId: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, simulated: true };
  }
}

/**
 * SMTP.
 *
 * Intentionally unimplemented rather than half-implemented: wiring it needs a
 * mailer dependency and a deliverability story (SPF, DKIM, a warmed domain)
 * that belongs with the deployment, not with the extraction. It throws a
 * message that says what to do, which is more useful than silently doing
 * nothing under a name that promises otherwise.
 */
export class SmtpEmailSender implements EmailSender {
  readonly id = 'smtp';

  async send(_message: OutboundMessage): Promise<SendResult> {
    throw new Error(
      'SMTP sending is not implemented yet. Set EMAIL_SENDER=log for development, ' +
        'or implement SmtpEmailSender in src/server/email/index.ts.',
    );
  }
}

let instance: EmailSender | null = null;

export function getEmailSender(): EmailSender {
  if (!instance) {
    const kind = optional('EMAIL_SENDER') ?? 'log';
    instance = kind === 'smtp' ? new SmtpEmailSender() : new LogOnlyEmailSender();
    if (instance.id === 'log') {
      console.log('[email] sender: log — sequence steps will be recorded, not delivered');
    }
  }
  return instance;
}

export function resetEmailSender(): void {
  instance = null;
}
