/**
 * Webhook Routes
 * Stripe webhook endpoint with event deduplication
 */

import { Router, Request, Response } from 'express';
import express from 'express';
import { WebhookService } from '../services/webhook.service';
import { eventDeduplicationService } from '../services/event-deduplication.service';

export function createWebhookRoutes(webhookService: WebhookService): Router {
  const router = Router();

  /**
   * POST /webhook
   * Stripe webhook endpoint - uses raw body for signature verification
   */
  router.post(
    '/',
    express.raw({ type: 'application/json' }),
    async (req: Request, res: Response) => {
      const sig = req.headers['stripe-signature'];

      if (!sig || typeof sig !== 'string') {
        console.error('[Webhook] Missing stripe-signature header');
        return res.status(400).send('Missing signature');
      }

      let eventId: string | undefined;

      try {
        // Verify and parse the event
        const event = webhookService.verifyEvent(req.body, sig);
        eventId = event.id;

        // Check for duplicate events (Stripe may send the same event multiple times)
        if (!eventDeduplicationService.tryAcquire(event.id, event.type)) {
          // Duplicate event - acknowledge receipt but don't process
          console.log(`[Webhook] Skipping duplicate event: ${event.id} (${event.type})`);
          return res.status(200).json({ received: true, duplicate: true });
        }

        // Handle the event
        await webhookService.handleEvent(event);

        res.status(200).json({ received: true });
      } catch (err: any) {
        // Release the event from deduplication cache on failure to allow retry
        if (eventId) {
          eventDeduplicationService.release(eventId);
        }

        if (err.type === 'StripeSignatureVerificationError') {
          console.error('[Webhook] Signature verification failed:', err.message);
          return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        console.error('[Webhook] Error processing event:', err);
        res.status(500).json({ error: 'Webhook handler failed' });
      }
    }
  );

  return router;
}
