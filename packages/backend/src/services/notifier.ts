/**
 * Outbound notifications — currently one: the confirmation link a debtor receives.
 *
 * **There is no mail transport in this service, and that is stated rather than mocked.**
 * No SMTP client, API key or provider SDK is a dependency of this package, so the default
 * implementation writes the link to the log at `info` and returns. During a demo that is
 * genuinely how the link is obtained, and calling it "sent" would be the kind of lie that
 * is discovered on stage.
 *
 * The seam is here so that adding a provider is one `setNotifier` call at boot and no
 * change to any route.
 */

import type { Logger } from '../logger.js';
import { rootLogger } from '../logger.js';

export interface ConfirmationEmail {
  readonly to: string;
  readonly debtorName: string;
  readonly sellerName: string;
  /** The one sentence the debtor is being asked about, already rendered. */
  readonly sentence: string;
  readonly link: string;
  readonly expiresAt: Date;
}

export interface Notifier {
  /** Resolves once the message has been handed off. Never throws for a bad address. */
  sendConfirmationRequest(email: ConfirmationEmail): Promise<void>;
}

export function createLoggingNotifier(logger: Logger = rootLogger): Notifier {
  const log = logger.child({ svc: 'notifier' });
  return {
    sendConfirmationRequest(email) {
      log.info('confirmation link ready (no mail transport configured)', {
        to: email.to,
        debtor: email.debtorName,
        seller: email.sellerName,
        link: email.link,
        expiresAt: email.expiresAt.toISOString(),
      });
      return Promise.resolve();
    },
  };
}

let notifier: Notifier | undefined;

export function setNotifier(next: Notifier): void {
  notifier = next;
}

export function getNotifier(): Notifier {
  notifier ??= createLoggingNotifier();
  return notifier;
}
