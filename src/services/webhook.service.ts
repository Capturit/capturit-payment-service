/**
 * Webhook Service
 * Handles Stripe webhook events
 */

import Stripe from 'stripe';
import { eq, sql, invoices, clientSubscriptions, clientStorageQuotas, NotificationService, users, DbClient } from '@capturit/shared';
import { PhoenixService } from './phoenix.service';
import type { PendingAuthToken } from '../types/webhook.types';

interface WebhookServiceConfig {
  STRIPE_WEBHOOK_SECRET: string;
  PROJECT_SERVICE_URL: string;
  INTERNAL_SECRET: string;
}

export class WebhookService {
  private stripe: Stripe;
  private db: DbClient;
  private config: WebhookServiceConfig;
  private phoenixService: PhoenixService;
  private notificationService: NotificationService;

  constructor(
    stripe: Stripe,
    db: DbClient,
    config: WebhookServiceConfig,
    pendingAuthTokens: Map<string, PendingAuthToken>
  ) {
    this.stripe = stripe;
    this.db = db;
    this.config = config;
    this.notificationService = new NotificationService(db);
    this.phoenixService = new PhoenixService(
      stripe,
      db,
      {
        PROJECT_SERVICE_URL: config.PROJECT_SERVICE_URL,
        INTERNAL_SECRET: config.INTERNAL_SECRET,
      },
      pendingAuthTokens
    );
  }

  /**
   * Verify and parse Stripe webhook event
   */
  verifyEvent(payload: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(
      payload,
      signature,
      this.config.STRIPE_WEBHOOK_SECRET
    );
  }

  /**
   * Route and handle webhook event
   */
  async handleEvent(event: Stripe.Event): Promise<void> {
    console.log(`[Webhook] Received event: ${event.type}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await this.phoenixService.handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        break;

      case 'checkout.session.expired':
        await this.handleCheckoutSessionExpired(
          event.data.object as Stripe.Checkout.Session
        );
        break;

      case 'payment_intent.succeeded':
        console.log('[Webhook] Payment intent succeeded:', event.data.object.id);
        break;

      case 'payment_intent.payment_failed':
        await this.handlePaymentFailed(
          event.data.object as Stripe.PaymentIntent
        );
        break;

      // === RECURRING PAYMENT EVENTS ===
      case 'invoice.paid':
        await this.handleInvoicePaid(
          event.data.object as Stripe.Invoice
        );
        break;

      case 'invoice.payment_failed':
        await this.handleInvoicePaymentFailed(
          event.data.object as Stripe.Invoice
        );
        break;

      case 'customer.subscription.updated':
        await this.handleSubscriptionUpdated(
          event.data.object as Stripe.Subscription
        );
        break;

      case 'customer.subscription.deleted':
        await this.handleSubscriptionDeleted(
          event.data.object as Stripe.Subscription
        );
        break;

      default:
        console.log(`[Webhook] Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Handle expired checkout session
   */
  private async handleCheckoutSessionExpired(session: Stripe.Checkout.Session): Promise<void> {
    console.log('[Webhook] Processing checkout.session.expired:', session.id);

    const checkoutSessionId = session.id;

    // Find the invoice
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeCheckoutSessionId, checkoutSessionId))
      .limit(1);

    if (!invoice) {
      console.log('[Webhook] Invoice not found for expired session:', checkoutSessionId);
      return;
    }

    // Update invoice status to cancelled
    await this.db
      .update(invoices)
      .set({
        status: 'cancelled',
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id));

    console.log('[Webhook] Invoice marked as cancelled:', invoice.id);
  }

  /**
   * Get admin user IDs for notifications
   */
  /**
   * Get staff user IDs for notifications (admin, super_admin, editor)
   * @param includeEditors - Include editors in the list (default: false, only admins)
   */
  private async getStaffUserIds(includeEditors = false): Promise<string[]> {
    try {
      const staffUsers = await this.db
        .select({ id: users.id, roles: users.roles })
        .from(users)
        .where(eq(users.isActive, true));

      // Filter users by role
      const allowedRoles = includeEditors
        ? ['admin', 'super_admin', 'editor']
        : ['admin', 'super_admin'];

      const staff = staffUsers.filter((u: any) => {
        const roles = u.roles?.roles || [];
        return roles.some((r: string) => allowedRoles.includes(r));
      });

      return staff.map((a: any) => a.id);
    } catch (error) {
      console.error('[Webhook] Error fetching staff users:', error);
      return [];
    }
  }

  // Backward compatibility alias
  private async getAdminUserIds(): Promise<string[]> {
    return this.getStaffUserIds(false);
  }

  /**
   * Handle payment failure
   */
  private async handlePaymentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    console.log('[Webhook] Processing payment_intent.payment_failed:', paymentIntent.id);

    // Find invoice by payment intent ID
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.stripePaymentIntentId, paymentIntent.id))
      .limit(1);

    if (!invoice) {
      console.log('[Webhook] Invoice not found for payment intent:', paymentIntent.id);
      return;
    }

    // Update invoice status to failed
    await this.db
      .update(invoices)
      .set({
        status: 'failed',
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id));

    console.log('[Webhook] Invoice marked as failed:', invoice.id);

    // Send notification to client
    try {
      await this.notificationService.sendPaymentFailed(
        invoice.clientId,
        parseFloat(invoice.amount || '0')
      );
      console.log('[Webhook] Payment failed notification sent to client:', invoice.clientId);
    } catch (error) {
      console.error('[Webhook] Error sending payment failed notification:', error);
    }

    // Notify admins
    try {
      const adminIds = await this.getAdminUserIds();
      if (adminIds.length > 0) {
        await this.notificationService.notifyAdmins(
          adminIds,
          'admin.payment_failed',
          { clientName: 'Client', amount: `${invoice.amount}€` },
          '/payments',
          'invoice',
          invoice.id
        );
        console.log('[Webhook] Payment failed notification sent to admins');
      }
    } catch (error) {
      console.error('[Webhook] Error sending admin notification:', error);
    }
  }

  // ============================================
  // RECURRING PAYMENT HANDLERS
  // ============================================

  /**
   * Handle Stripe invoice.paid event
   * This is triggered for EVERY successful payment including:
   * - Initial subscription payment
   * - Recurring monthly/yearly payments
   * - One-time invoice payments
   */
  private async handleInvoicePaid(stripeInvoice: Stripe.Invoice): Promise<void> {
    console.log('[Webhook] Processing invoice.paid:', stripeInvoice.id);
    console.log('[Webhook] Billing reason:', stripeInvoice.billing_reason);
    console.log('[Webhook] Subscription:', stripeInvoice.subscription);

    // Skip if no subscription (one-time payments are handled by checkout.session.completed)
    if (!stripeInvoice.subscription) {
      console.log('[Webhook] No subscription attached, skipping (handled by checkout flow)');
      return;
    }

    const subscriptionId = typeof stripeInvoice.subscription === 'string'
      ? stripeInvoice.subscription
      : stripeInvoice.subscription.id;

    // Find the subscription in our database
    const [subscription] = await this.db
      .select()
      .from(clientSubscriptions)
      .where(eq(clientSubscriptions.stripeSubscriptionId, subscriptionId))
      .limit(1);

    if (!subscription) {
      console.log('[Webhook] Subscription not found in DB:', subscriptionId);
      return;
    }

    // Skip initial payment (already handled by checkout.session.completed / Phoenix)
    // billing_reason: 'subscription_create' = initial payment
    // billing_reason: 'subscription_cycle' = recurring payment
    // billing_reason: 'subscription_update' = plan change
    if (stripeInvoice.billing_reason === 'subscription_create') {
      console.log('[Webhook] Initial subscription payment, already handled by Phoenix workflow');
      return;
    }

    // This is a RECURRING payment - create an invoice record
    const amountPaid = (stripeInvoice.amount_paid || 0) / 100; // Convert from cents to euros
    const invoiceNumber = `INV-REC-${Date.now()}-${subscription.clientId.substring(0, 8)}`;

    // Check if we already recorded this Stripe invoice (idempotency)
    const [existingInvoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.stripePaymentIntentId, stripeInvoice.payment_intent as string))
      .limit(1);

    if (existingInvoice) {
      console.log('[Webhook] Invoice already recorded:', existingInvoice.id);
      return;
    }

    // Create invoice record for the recurring payment
    const [newInvoice] = await this.db
      .insert(invoices)
      .values({
        clientId: subscription.clientId,
        invoiceNumber,
        amount: String(amountPaid),
        currency: stripeInvoice.currency || 'eur',
        status: 'paid',
        paidAt: new Date(stripeInvoice.status_transitions?.paid_at
          ? stripeInvoice.status_transitions.paid_at * 1000
          : Date.now()),
        planId: subscription.planId,
        planName: `Abonnement ${subscription.planId}`,
        description: `Paiement récurrent - ${stripeInvoice.billing_reason}`,
        stripePaymentIntentId: stripeInvoice.payment_intent as string,
        stripeCustomerId: typeof stripeInvoice.customer === 'string'
          ? stripeInvoice.customer
          : stripeInvoice.customer?.id,
        metadata: {
          stripeInvoiceId: stripeInvoice.id,
          billingReason: stripeInvoice.billing_reason,
          subscriptionId: subscriptionId,
          periodStart: stripeInvoice.period_start,
          periodEnd: stripeInvoice.period_end,
          type: 'recurring'
        },
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    console.log('[Webhook] Recurring payment recorded:', newInvoice.id);
    console.log('[Webhook] Amount:', amountPaid, stripeInvoice.currency?.toUpperCase());
    console.log('[Webhook] Client:', subscription.clientId);

    // Update subscription period dates
    await this.db
      .update(clientSubscriptions)
      .set({
        currentPeriodStart: new Date(stripeInvoice.period_start * 1000),
        currentPeriodEnd: new Date(stripeInvoice.period_end * 1000),
        status: 'active',
        updatedAt: new Date()
      })
      .where(eq(clientSubscriptions.stripeSubscriptionId, subscriptionId));

    console.log('[Webhook] Subscription period updated');
  }

  /**
   * Handle Stripe invoice.payment_failed event
   * Triggered when a recurring payment fails
   */
  private async handleInvoicePaymentFailed(stripeInvoice: Stripe.Invoice): Promise<void> {
    console.log('[Webhook] Processing invoice.payment_failed:', stripeInvoice.id);

    if (!stripeInvoice.subscription) {
      console.log('[Webhook] No subscription attached, skipping');
      return;
    }

    const subscriptionId = typeof stripeInvoice.subscription === 'string'
      ? stripeInvoice.subscription
      : stripeInvoice.subscription.id;

    // Find and update the subscription status
    const [subscription] = await this.db
      .select()
      .from(clientSubscriptions)
      .where(eq(clientSubscriptions.stripeSubscriptionId, subscriptionId))
      .limit(1);

    if (!subscription) {
      console.log('[Webhook] Subscription not found:', subscriptionId);
      return;
    }

    // Update subscription to past_due
    await this.db
      .update(clientSubscriptions)
      .set({
        status: 'past_due',
        updatedAt: new Date()
      })
      .where(eq(clientSubscriptions.stripeSubscriptionId, subscriptionId));

    console.log('[Webhook] Subscription marked as past_due:', subscriptionId);

    // Create a failed invoice record for tracking
    const amountDue = (stripeInvoice.amount_due || 0) / 100;
    const invoiceNumber = `INV-FAIL-${Date.now()}-${subscription.clientId.substring(0, 8)}`;

    await this.db
      .insert(invoices)
      .values({
        clientId: subscription.clientId,
        invoiceNumber,
        amount: String(amountDue),
        currency: stripeInvoice.currency || 'eur',
        status: 'failed',
        planId: subscription.planId,
        planName: `Abonnement ${subscription.planId}`,
        description: `Paiement récurrent échoué - ${stripeInvoice.billing_reason}`,
        stripePaymentIntentId: stripeInvoice.payment_intent as string,
        stripeCustomerId: typeof stripeInvoice.customer === 'string'
          ? stripeInvoice.customer
          : stripeInvoice.customer?.id,
        metadata: {
          stripeInvoiceId: stripeInvoice.id,
          billingReason: stripeInvoice.billing_reason,
          subscriptionId: subscriptionId,
          type: 'recurring_failed',
          attemptCount: stripeInvoice.attempt_count
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });

    console.log('[Webhook] Failed payment recorded for client:', subscription.clientId);

    // Send notification to client about payment failure
    try {
      await this.notificationService.sendPaymentFailed(
        subscription.clientId,
        amountDue
      );
      console.log('[Webhook] Payment failed notification sent to client');
    } catch (error) {
      console.error('[Webhook] Error sending payment failed notification:', error);
    }

    // Notify admins
    try {
      const adminIds = await this.getAdminUserIds();
      if (adminIds.length > 0) {
        await this.notificationService.notifyAdmins(
          adminIds,
          'admin.payment_failed',
          { clientName: 'Client', amount: `${amountDue}€` },
          '/payments',
          'invoice',
          invoiceNumber
        );
        console.log('[Webhook] Payment failed notification sent to admins');
      }
    } catch (error) {
      console.error('[Webhook] Error sending admin notification:', error);
    }
  }

  /**
   * Handle Stripe customer.subscription.updated event
   * Triggered when subscription is modified (plan change, cancel scheduled, etc.)
   */
  private async handleSubscriptionUpdated(stripeSubscription: Stripe.Subscription): Promise<void> {
    console.log('[Webhook] Processing customer.subscription.updated:', stripeSubscription.id);
    console.log('[Webhook] Status:', stripeSubscription.status);
    console.log('[Webhook] Cancel at period end:', stripeSubscription.cancel_at_period_end);

    // Find the subscription in our database
    const [subscription] = await this.db
      .select()
      .from(clientSubscriptions)
      .where(eq(clientSubscriptions.stripeSubscriptionId, stripeSubscription.id))
      .limit(1);

    if (!subscription) {
      console.log('[Webhook] Subscription not found:', stripeSubscription.id);
      return;
    }

    // Map Stripe status to our status
    let status = subscription.status;
    switch (stripeSubscription.status) {
      case 'active':
        status = 'active';
        break;
      case 'past_due':
        status = 'past_due';
        break;
      case 'canceled':
        status = 'cancelled';
        break;
      case 'trialing':
        status = 'trialing';
        break;
      case 'unpaid':
        status = 'past_due';
        break;
    }

    // Update subscription record
    await this.db
      .update(clientSubscriptions)
      .set({
        status,
        currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
        cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
        trialEnd: stripeSubscription.trial_end
          ? new Date(stripeSubscription.trial_end * 1000)
          : null,
        updatedAt: new Date()
      })
      .where(eq(clientSubscriptions.stripeSubscriptionId, stripeSubscription.id));

    console.log('[Webhook] Subscription updated:', stripeSubscription.id, '| New status:', status);

    // Log if subscription is scheduled for cancellation
    if (stripeSubscription.cancel_at_period_end) {
      console.log('[Webhook] Subscription scheduled for cancellation at period end');
      console.log('[Webhook] Will cancel on:', new Date(stripeSubscription.current_period_end * 1000));
    }
  }

  /**
   * Handle Stripe customer.subscription.deleted event
   * Triggered when subscription is actually cancelled/deleted
   */
  private async handleSubscriptionDeleted(stripeSubscription: Stripe.Subscription): Promise<void> {
    console.log('[Webhook] Processing customer.subscription.deleted:', stripeSubscription.id);

    // Find the subscription in our database
    const [subscription] = await this.db
      .select()
      .from(clientSubscriptions)
      .where(eq(clientSubscriptions.stripeSubscriptionId, stripeSubscription.id))
      .limit(1);

    if (!subscription) {
      console.log('[Webhook] Subscription not found:', stripeSubscription.id);
      return;
    }

    // Check if this is a storage addon subscription (from Stripe metadata)
    const isStorageAddon = stripeSubscription.metadata?.type === 'storage_addon';

    // Update subscription to cancelled
    await this.db
      .update(clientSubscriptions)
      .set({
        status: 'cancelled',
        cancelledAt: new Date(),
        updatedAt: new Date()
      })
      .where(eq(clientSubscriptions.stripeSubscriptionId, stripeSubscription.id));

    console.log('[Webhook] Subscription cancelled:', stripeSubscription.id);
    console.log('[Webhook] Client:', subscription.clientId);

    // If storage addon, decrease storage quota
    if (isStorageAddon) {
      await this.handleStorageAddonCancellation(subscription, stripeSubscription);
    }

    // Send cancellation notification to client
    try {
      await this.notificationService.sendSubscriptionCancelled(
        subscription.clientId
      );
      console.log('[Webhook] Subscription cancelled notification sent to client');
    } catch (error) {
      console.error('[Webhook] Error sending subscription cancelled notification:', error);
    }

    // Notify admins of churned subscription
    try {
      const adminIds = await this.getAdminUserIds();
      if (adminIds.length > 0) {
        await this.notificationService.notifyAdmins(
          adminIds,
          'admin.subscription_cancelled',
          { clientName: 'Client' },
          '/users',
          'subscription',
          subscription.id
        );
        console.log('[Webhook] Subscription cancelled notification sent to admins');
      }
    } catch (error) {
      console.error('[Webhook] Error sending admin notification:', error);
    }
  }

  /**
   * Handle storage addon cancellation
   * Decreases client's storage quota
   */
  private async handleStorageAddonCancellation(subscription: any, stripeSubscription: Stripe.Subscription): Promise<void> {
    console.log('[Webhook] Processing storage addon cancellation');

    const storageGb = Number(stripeSubscription.metadata?.storageGb) || 0;
    const storageBytesToRemove = storageGb * 1024 * 1024 * 1024;

    if (storageBytesToRemove <= 0) {
      console.log('[Webhook] No storage to remove (storageGb:', storageGb, ')');
      return;
    }

    try {
      // Get current quota
      const [quota] = await this.db
        .select()
        .from(clientStorageQuotas)
        .where(eq(clientStorageQuotas.clientId, subscription.clientId))
        .limit(1);

      if (!quota) {
        console.log('[Webhook] No storage quota found for client:', subscription.clientId);
        return;
      }

      // Calculate new limit (minimum 5GB base storage)
      const baseStorageBytes = 5 * 1024 * 1024 * 1024; // 5GB
      const currentLimit = quota.storageLimitBytes || baseStorageBytes;
      const newLimit = Math.max(baseStorageBytes, currentLimit - storageBytesToRemove);

      // Update quota
      await this.db
        .update(clientStorageQuotas)
        .set({
          storageLimitBytes: newLimit,
          updatedAt: new Date()
        })
        .where(eq(clientStorageQuotas.clientId, subscription.clientId));

      console.log('[Webhook] Storage quota decreased by', storageGb, 'GB');
      console.log('[Webhook] New limit:', Math.round(newLimit / (1024 * 1024 * 1024)), 'GB');

      // Check if user is now over quota
      if (quota.usedStorageBytes > newLimit) {
        console.log('[Webhook] WARNING: Client is now over storage quota!');
        console.log('[Webhook] Used:', Math.round(quota.usedStorageBytes / (1024 * 1024 * 1024)), 'GB');
        console.log('[Webhook] New Limit:', Math.round(newLimit / (1024 * 1024 * 1024)), 'GB');

        // Notify client that they're over quota
        try {
          await this.notificationService.createCustom({
            userId: subscription.clientId,
            type: 'storage.over_quota',
            category: 'storage',
            title: 'Stockage dépassé',
            message: `Votre abonnement stockage a été annulé. Vous utilisez actuellement ${Math.round(quota.usedStorageBytes / (1024 * 1024 * 1024))}GB sur ${Math.round(newLimit / (1024 * 1024 * 1024))}GB disponibles.`,
            priority: 'high'
          });
        } catch (error) {
          console.error('[Webhook] Error sending over quota notification:', error);
        }
      }
    } catch (error) {
      console.error('[Webhook] Error handling storage addon cancellation:', error);
    }
  }
}
