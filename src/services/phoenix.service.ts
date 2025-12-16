/**
 * Phoenix Service
 * Handles the Phoenix workflow - user creation and project setup after payment
 * Uses notification-service for all email and notification sending
 */

import Stripe from 'stripe';
import axios from 'axios';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import {
  eq,
  sql,
  invoices,
  clientSubscriptions,
  clientStorageQuotas,
  refreshTokens,
  generateAccessToken,
  generateRefreshToken,
  users,
  NotificationService,
  sendVerificationEmail,
  sendPaymentSuccessNotification,
  sendWelcomeNotification,
  type UserRole,
  DbClient,
} from '@capturit/shared';
import type {
  PendingAuthToken,
  CheckoutMetadata,
  ModuleData,
  ModuleInput,
  InvoiceRecord,
} from '../types/webhook.types';

interface PhoenixServiceConfig {
  PROJECT_SERVICE_URL: string;
  INTERNAL_SECRET: string;
}

export class PhoenixService {
  private stripe: Stripe;
  private db: DbClient;
  private config: PhoenixServiceConfig;
  private pendingAuthTokens: Map<string, PendingAuthToken>;
  private notificationService: NotificationService;

  constructor(
    stripe: Stripe,
    db: DbClient,
    config: PhoenixServiceConfig,
    pendingAuthTokens: Map<string, PendingAuthToken>
  ) {
    this.stripe = stripe;
    this.db = db;
    this.config = config;
    this.pendingAuthTokens = pendingAuthTokens;
    this.notificationService = new NotificationService(db);
  }

  /**
   * Handle successful checkout (Phoenix Workflow)
   * Creates user account if pending, then creates project
   */
  async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
    console.log('[Phoenix Webhook] Processing checkout.session.completed:', session.id);
    console.log('[Phoenix Webhook] Metadata:', session.metadata);

    const checkoutSessionId = session.id;
    const paymentIntentId = session.payment_intent as string;
    const subscriptionId = session.subscription as string;
    const customerId = session.customer as string;
    const metadata = (session.metadata || {}) as CheckoutMetadata;
    const caseType = metadata.case || 'A';

    // Get total amount paid TODAY from Stripe session
    // This is the immediate payment: setup fee + one-time production items
    // (subscription recurring amount is deferred during trial period)
    const amountPaidCents = session.amount_total || 0;
    const amountPaidEuros = (amountPaidCents / 100).toFixed(2);
    console.log('[Phoenix Webhook] Amount paid today:', amountPaidCents, 'cents =', amountPaidEuros, '€');

    // Add totalAmount to metadata for downstream use (this is what goes on the invoice)
    metadata.totalAmount = amountPaidEuros;
    metadata.totalAmountCents = String(amountPaidCents);

    // Check if this is a storage addon purchase
    if ((metadata as any).type === 'storage_addon') {
      await this.handleStorageAddonPurchase(
        checkoutSessionId,
        subscriptionId,
        customerId,
        metadata as any
      );
      return;
    }

    // Check if this is a pending registration (new user flow)
    if (metadata.pendingUserEmail) {
      await this.handlePendingRegistration(
        checkoutSessionId,
        paymentIntentId,
        subscriptionId,
        customerId,
        caseType,
        metadata
      );
    } else {
      await this.handleExistingUserPayment(
        checkoutSessionId,
        paymentIntentId,
        subscriptionId,
        customerId,
        caseType,
        metadata
      );
    }

    console.log('[Phoenix Webhook] Checkout session completed successfully');
  }

  /**
   * Handle storage addon purchase
   * Increases client's storage limit and creates invoice
   */
  private async handleStorageAddonPurchase(
    checkoutSessionId: string,
    subscriptionId: string,
    customerId: string,
    metadata: { type: string; clientId: string; storagePlanId: string; storageGb: string }
  ): Promise<void> {
    console.log('[Phoenix Webhook] Processing storage addon purchase');
    console.log('[Phoenix Webhook] Client:', metadata.clientId, '| Plan:', metadata.storagePlanId);

    const clientId = metadata.clientId;
    const storageGb = parseInt(metadata.storageGb || '0', 10);
    const storageBytesToAdd = storageGb * 1024 * 1024 * 1024; // Convert GB to bytes

    try {
      // Get subscription details for pricing
      const stripeSubscription = await this.stripe.subscriptions.retrieve(subscriptionId);
      const amountPaid = (stripeSubscription.items.data[0]?.price?.unit_amount || 0) / 100;

      // Create invoice record
      const invoiceNumber = `INV-STORAGE-${Date.now()}-${clientId.substring(0, 8)}`;
      const [invoice] = await this.db.insert(invoices).values({
        clientId,
        invoiceNumber,
        amount: String(amountPaid),
        currency: 'eur',
        status: 'paid',
        paidAt: new Date(),
        planId: metadata.storagePlanId,
        planName: `Stockage supplémentaire +${storageGb}GB`,
        description: `Abonnement stockage additionnel - ${storageGb}GB/mois`,
        stripeCheckoutSessionId: checkoutSessionId,
        stripeCustomerId: customerId,
        metadata: {
          type: 'storage_addon',
          storageGb,
          storagePlanId: metadata.storagePlanId,
          stripeSubscriptionId: subscriptionId
        },
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning();

      console.log('[Phoenix Webhook] Storage invoice created:', invoice.id);

      // Create subscription record for storage
      // Note: Storage addon metadata (type, storageGb) is stored in Stripe subscription metadata
      await this.db.insert(clientSubscriptions).values({
        id: crypto.randomUUID(),
        clientId,
        planId: metadata.storagePlanId,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        status: stripeSubscription.status === 'trialing' ? 'trialing' : 'active',
        currentPeriodStart: new Date(stripeSubscription.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSubscription.current_period_end * 1000),
        cancelAtPeriodEnd: false,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log('[Phoenix Webhook] Storage subscription record created');

      // Update client storage quota
      const [existingQuota] = await this.db
        .select()
        .from(clientStorageQuotas)
        .where(eq(clientStorageQuotas.clientId, clientId))
        .limit(1);

      if (existingQuota) {
        // Increase existing quota
        await this.db
          .update(clientStorageQuotas)
          .set({
            storageLimitBytes: sql`${clientStorageQuotas.storageLimitBytes} + ${storageBytesToAdd}`,
            updatedAt: new Date()
          })
          .where(eq(clientStorageQuotas.clientId, clientId));

        console.log('[Phoenix Webhook] Storage quota increased by', storageGb, 'GB');
      } else {
        // Create new quota record (base 5GB + addon)
        const baseStorageBytes = 5 * 1024 * 1024 * 1024; // 5GB base
        await this.db.insert(clientStorageQuotas).values({
          clientId,
          planId: metadata.storagePlanId,
          storageLimitBytes: baseStorageBytes + storageBytesToAdd,
          usedStorageBytes: 0,
          fileCount: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });

        console.log('[Phoenix Webhook] Storage quota created with', 5 + storageGb, 'GB total');
      }

      // Get user info for notification
      const [user] = await this.db
        .select()
        .from(users)
        .where(eq(users.id, clientId))
        .limit(1);

      // Send notification
      if (user) {
        try {
          await sendPaymentSuccessNotification({
            userId: clientId,
            email: user.email,
            firstName: user.firstName || 'Client',
            invoiceId: invoice.id,
            invoiceNumber: invoice.invoiceNumber,
            planName: `Stockage +${storageGb}GB`,
            amountCents: Math.round(amountPaid * 100),
            channels: ['in_app', 'email'],
          });
          console.log('[Phoenix Webhook] Storage purchase notification sent');
        } catch (error) {
          console.error('[Phoenix Webhook] Error sending storage notification:', error);
        }
      }

      console.log('\n' + '='.repeat(60));
      console.log('[Phoenix Workflow Summary - Storage Addon]');
      console.log(`Client: ${clientId} | Storage Added: ${storageGb}GB`);
      console.log(`Invoice: ${invoice.invoiceNumber} | Amount: ${amountPaid}€/mois`);
      console.log(`Subscription: ${subscriptionId}`);
      console.log('='.repeat(60) + '\n');

    } catch (error) {
      console.error('[Phoenix Webhook] Error processing storage addon:', error);
      throw error;
    }
  }

  /**
   * Handle pending registration - create user first, then project
   */
  private async handlePendingRegistration(
    checkoutSessionId: string,
    paymentIntentId: string,
    subscriptionId: string,
    customerId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ): Promise<void> {
    console.log('[Phoenix Webhook] Pending registration detected - creating user first');

    // Validate required fields
    // For OAuth users (Google), password is not required since they authenticate via OAuth
    const isOAuthUser = metadata.authMethod === 'google' || metadata.authMethod === 'oauth';
    if (!metadata.pendingUserEmail) {
      throw new Error('Missing required user email in checkout metadata');
    }
    if (!isOAuthUser && !metadata.pendingUserHashedPassword) {
      throw new Error('Missing required password in checkout metadata (not OAuth user)');
    }

    // For OAuth users, generate a random password hash (they authenticate via OAuth, not password)
    let passwordHash = metadata.pendingUserHashedPassword;
    if (isOAuthUser && !passwordHash) {
      const randomPassword = crypto.randomBytes(32).toString('hex');
      passwordHash = await bcrypt.hash(randomPassword, 10);
      console.log('[Phoenix Webhook] Generated random password hash for OAuth user');
    }

    // Create the user account
    // OAuth users (Google) have their email already verified by the OAuth provider
    const [newUser] = await this.db.insert(users).values({
      firstName: metadata.pendingUserFirstName || metadata.pendingUserFullName?.split(' ')[0] || 'Client',
      lastName: metadata.pendingUserLastName || metadata.pendingUserFullName?.split(' ').slice(1).join(' ') || '',
      email: metadata.pendingUserEmail,
      password: passwordHash,
      companyName: metadata.pendingUserCompany || null,
      phone: metadata.pendingUserPhone || null,
      avatar: (metadata as any).pendingUserAvatar || null, // Google avatar URL
      roles: { roles: ['client'] as UserRole[] },
      emailVerified: isOAuthUser, // Google users have verified email, regular users need to verify
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    console.log('[Phoenix Webhook] User created:', newUser.id, newUser.email);

    // Generate authentication tokens for auto-login
    const userRoles: UserRole[] = ['client'];
    const accessToken = generateAccessToken(newUser.id, newUser.email, userRoles);
    const refreshTokenString = generateRefreshToken(newUser.id, newUser.email, userRoles);

    // Store refresh token in database
    const hashedRefreshToken = await bcrypt.hash(refreshTokenString, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    await this.db.insert(refreshTokens).values({
      userId: newUser.id,
      token: hashedRefreshToken,
      expiresAt,
    });

    // Store tokens for auto-login
    this.pendingAuthTokens.set(checkoutSessionId, {
      accessToken,
      refreshToken: refreshTokenString,
      userId: newUser.id,
      email: newUser.email,
      createdAt: new Date()
    });

    console.log('[Phoenix Webhook] Auth tokens generated for session:', checkoutSessionId);

    // Create invoice
    const invoice = await this.createInvoice(
      newUser.id,
      checkoutSessionId,
      paymentIntentId,
      caseType,
      metadata
    );

    // Create project and workflow
    await this.createProjectAndWorkflow(
      invoice,
      newUser.id,
      subscriptionId,
      customerId,
      caseType,
      metadata
    );

    // Send welcome notification via notification-service (in-app + email)
    try {
      await sendWelcomeNotification({
        userId: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName || 'Client',
        channels: ['in_app', 'email'],
      });
      console.log('[Phoenix Webhook] Welcome notification sent to new user');
    } catch (error) {
      console.error('[Phoenix Webhook] Error sending welcome notification:', error);
    }

    // Send payment success notification via notification-service (in-app + email)
    try {
      // FIXED: Use totalAmountCents (in cents) instead of totalAmount (in euros)
      // totalAmount is "299.00" (euros), totalAmountCents is "29900" (cents)
      const totalAmountCents = parseInt(metadata.totalAmountCents || '0', 10);
      await sendPaymentSuccessNotification({
        userId: newUser.id,
        email: newUser.email,
        firstName: newUser.firstName || 'Client',
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        planName: invoice.planName || 'Votre formule',
        amountCents: totalAmountCents,
        channels: ['in_app', 'email'],
      });
      console.log('[Phoenix Webhook] Payment success notification sent with amount:', totalAmountCents, 'cents');
    } catch (error) {
      console.error('[Phoenix Webhook] Error sending payment success notification:', error);
    }

    // Send verification email via notification-service (only for non-OAuth users)
    // OAuth users (Google) already have verified emails from the OAuth provider
    if (!isOAuthUser) {
      try {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        await sendVerificationEmail({
          userId: newUser.id,
          email: newUser.email,
          firstName: newUser.firstName || 'Client',
          verificationToken,
        });
        console.log('[Phoenix Webhook] Verification email sent to:', newUser.email);
      } catch (error) {
        console.error('[Phoenix Webhook] Error sending verification email:', error);
      }
    } else {
      console.log('[Phoenix Webhook] Skipping verification email for OAuth user (already verified):', newUser.email);
    }
  }

  /**
   * Handle payment for existing user
   */
  private async handleExistingUserPayment(
    checkoutSessionId: string,
    paymentIntentId: string,
    subscriptionId: string,
    customerId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ): Promise<void> {
    // Find existing invoice
    const [invoice] = await this.db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeCheckoutSessionId, checkoutSessionId))
      .limit(1);

    if (!invoice) {
      console.error('[Phoenix Webhook] Invoice not found for session:', checkoutSessionId);
      return;
    }

    console.log('[Phoenix Webhook] Found invoice:', invoice.id, '| Case:', caseType);

    // Update invoice status to paid
    const [updatedInvoice] = await this.db
      .update(invoices)
      .set({
        status: 'paid',
        paidAt: new Date(),
        stripePaymentIntentId: paymentIntentId,
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id))
      .returning();

    console.log('[Phoenix Webhook] Invoice marked as paid:', updatedInvoice.id);

    await this.createProjectAndWorkflow(
      updatedInvoice,
      updatedInvoice.clientId,
      subscriptionId,
      customerId,
      caseType,
      metadata
    );

    // Get user info for notification
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, updatedInvoice.clientId))
      .limit(1);

    // Send payment success notification to existing user via notification-service
    if (user) {
      try {
        const totalAmountCents = parseInt(updatedInvoice.amount || '0', 10) * 100;
        await sendPaymentSuccessNotification({
          userId: updatedInvoice.clientId,
          email: user.email,
          firstName: user.firstName || 'Client',
          invoiceId: updatedInvoice.id,
          invoiceNumber: updatedInvoice.invoiceNumber,
          planName: updatedInvoice.planName || 'Votre formule',
          amountCents: totalAmountCents,
          channels: ['in_app', 'email'],
        });
        console.log('[Phoenix Webhook] Payment success notification sent to existing user');
      } catch (error) {
        console.error('[Phoenix Webhook] Error sending payment success notification:', error);
      }
    }
  }

  /**
   * Create invoice for new user
   */
  private async createInvoice(
    clientId: string,
    checkoutSessionId: string,
    paymentIntentId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ): Promise<InvoiceRecord> {
    // Determine plan info based on case type
    let planId: string;
    let planName: string;

    // Parse modulesJson if available to get plan names
    let modulesData: Array<{ planId: string; planName: string; type?: string }> = [];
    if (metadata.modulesJson) {
      try {
        modulesData = JSON.parse(metadata.modulesJson);
      } catch (e) {
        console.warn('[Phoenix] Could not parse modulesJson:', e);
      }
    }

    // Helper to get proper plan display name
    const getPlanDisplayName = (id: string | undefined, fallback: string): string => {
      if (!id) return fallback;
      // Check if we have it in modulesData
      const found = modulesData.find(m => m.planId === id);
      if (found?.planName) return found.planName;
      // Capitalize first letter
      return id.charAt(0).toUpperCase() + id.slice(1);
    };

    if (caseType === 'C') {
      // Case C: Web subscription + Production one-off
      planId = metadata.webPlanId || 'growth';
      const webName = getPlanDisplayName(metadata.webPlanId, 'Formule Web');

      // Get production plan name from modulesJson
      const productionModules = modulesData.filter(m => m.type === 'production' || !m.type?.includes('web'));
      const productionNames = productionModules.length > 0
        ? productionModules.map(m => m.planName || m.planId).join(' + ')
        : metadata.productionPlanId || 'Production';

      planName = `${webName} + ${productionNames}`;
    } else if (caseType === 'A') {
      // Case A: Web subscription only
      planId = metadata.webPlanId || metadata.planId || 'growth';
      planName = getPlanDisplayName(metadata.webPlanId || metadata.planId, 'Formule Web');
    } else {
      // Case B: Production only (one-off)
      planId = metadata.productionPlanId || metadata.planId || 'signature';
      // Get all module names from modulesJson
      if (modulesData.length > 0) {
        planName = modulesData.map(m => m.planName || m.planId).join(' + ');
      } else {
        planName = getPlanDisplayName(metadata.productionPlanId || metadata.planId, 'Production');
      }
    }

    const invoiceNumber = `INV-${caseType}-${Date.now()}-${clientId.substring(0, 8)}`;

    const [invoice] = await this.db.insert(invoices).values({
      clientId,
      invoiceNumber,
      amount: metadata.totalAmount || '0',
      currency: 'eur',
      status: 'paid',
      paidAt: new Date(),
      planId,
      planName,
      description: metadata.invoiceDescription || `${planName} - Paiement initial`,
      stripeCheckoutSessionId: checkoutSessionId,
      stripePaymentIntentId: paymentIntentId,
      metadata: {
        case: caseType,
        type: metadata.planType,
        ...metadata
      },
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    console.log('[Phoenix Webhook] Invoice created:', invoice.id);
    return invoice;
  }

  /**
   * Create project and workflow via project-service
   */
  async createProjectAndWorkflow(
    invoice: InvoiceRecord,
    clientId: string,
    subscriptionId: string,
    customerId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ): Promise<void> {
    console.log('[Phoenix Webhook] Creating project and workflow for client:', clientId);

    // Handle subscription creation (Case A & C)
    if (subscriptionId && (caseType === 'A' || caseType === 'C')) {
      await this.createSubscriptionRecord(
        clientId,
        subscriptionId,
        customerId,
        caseType,
        invoice,
        metadata
      );
    }

    // Create project via project-service
    if (invoice.planId && invoice.planName) {
      await this.createProject(invoice, clientId, subscriptionId, caseType, metadata);
    } else {
      console.log('[Phoenix Webhook] This is a regular invoice payment (not onboarding)');
    }
  }

  /**
   * Create subscription record in database
   */
  private async createSubscriptionRecord(
    clientId: string,
    subscriptionId: string,
    customerId: string,
    caseType: string,
    invoice: InvoiceRecord,
    metadata: CheckoutMetadata
  ): Promise<void> {
    console.log('[Phoenix Webhook] Creating subscription record for:', subscriptionId);

    try {
      const subscription = await this.stripe.subscriptions.retrieve(subscriptionId);

      const planId = caseType === 'A'
        ? invoice.planId
        : (metadata.webPlanId || invoice.planId?.split(',')[0]);

      if (!planId) {
        console.error('[Phoenix Webhook] No planId found for subscription, skipping subscription record creation');
        return;
      }

      await this.db.insert(clientSubscriptions).values({
        id: crypto.randomUUID(),
        clientId,
        planId,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId: customerId,
        status: subscription.status === 'trialing' ? 'trialing' : 'active',
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        trialEnd: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        cancelAtPeriodEnd: false,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log('[Phoenix Webhook] Subscription record created | Status:', subscription.status);
    } catch (subError) {
      console.error('[Phoenix Webhook] Failed to create subscription record:',
        subError instanceof Error ? subError.message : subError);
    }
  }

  /**
   * Create project via project-service API
   */
  private async createProject(
    invoice: InvoiceRecord,
    clientId: string,
    subscriptionId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ): Promise<void> {
    console.log('[Phoenix Webhook] Calling project-service for plan:', invoice.planName);

    try {
      let response;

      const hasModulesJson = metadata.modulesJson;
      const moduleCount = parseInt(metadata.moduleCount || '0', 10);

      if (hasModulesJson && moduleCount > 0) {
        response = await this.createDynamicMultiModuleProject(
          invoice, clientId, subscriptionId, caseType, metadata, moduleCount
        );
      } else if (caseType === 'C' && metadata.webPlanId && metadata.productionPlanId) {
        response = await this.createLegacyMultiModuleProject(
          invoice, clientId, subscriptionId, caseType, metadata
        );
      } else {
        response = await this.createSingleModuleProject(
          invoice, clientId, subscriptionId, caseType, metadata
        );
      }

      if (response?.data.success) {
        await this.db.update(invoices)
          .set({ projectId: response.data.data.project.id, updatedAt: new Date() })
          .where(eq(invoices.id, invoice.id));
      }

      console.log('[Phoenix Webhook] TODO: Send onboarding email to client:', clientId);
    } catch (error) {
      this.handleProjectCreationError(error, invoice.id, clientId);
    }
  }

  /**
   * Create dynamic multi-module project (modulesJson)
   */
  private async createDynamicMultiModuleProject(
    invoice: InvoiceRecord,
    clientId: string,
    subscriptionId: string,
    caseType: string,
    metadata: CheckoutMetadata,
    moduleCount: number
  ) {
    console.log('[Phoenix Webhook] Creating dynamic multi-module project with', moduleCount, 'modules');

    let modulesData: ModuleData[];
    try {
      modulesData = JSON.parse(metadata.modulesJson!);
    } catch (parseError) {
      console.error('[Phoenix Webhook] Failed to parse modulesJson:', parseError);
      throw new Error('Invalid modulesJson in metadata');
    }

    const modules: ModuleInput[] = modulesData.map((mod) => ({
      planId: mod.planId,
      planName: mod.planName,
      budget: mod.priceCents ? String(mod.priceCents / 100) : null,
      metadata: {
        type: mod.type,
        hasSubscription: mod.type === 'web' && !!subscriptionId,
        originalPriceCents: mod.priceCents
      }
    }));

    console.log('[Phoenix Webhook] Modules:', modules.map(m => `${m.planId}(${m.planName})`).join(', '));

    const response = await axios.post(
      `${this.config.PROJECT_SERVICE_URL}/internal/projects/create-with-modules`,
      {
        clientId,
        invoiceId: invoice.id,
        totalBudget: invoice.amount,
        modules,
        metadata: {
          case: caseType,
          createdVia: 'phoenix_workflow_dynamic_multimodule',
          hasSubscription: !!subscriptionId,
          moduleCount,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.config.INTERNAL_SECRET,
        },
        timeout: 30000,
      }
    );

    if (response.data.success) {
      const { project, modules: createdModules, briefs, steps } = response.data.data;
      this.logWorkflowSummary('Dynamic Multi-Module', caseType, clientId, project.id,
        createdModules, briefs, subscriptionId);
    } else {
      throw new Error(response.data.error || 'Project service returned unsuccessful response');
    }

    return response;
  }

  /**
   * Create legacy multi-module project (Case C without modulesJson)
   */
  private async createLegacyMultiModuleProject(
    invoice: InvoiceRecord,
    clientId: string,
    subscriptionId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ) {
    console.log('[Phoenix Webhook] Creating legacy multi-module project (web + production)');

    const modules: ModuleInput[] = [
      {
        planId: metadata.webPlanId!,
        planName: metadata.webPlanId === 'growth' ? 'Growth' : metadata.webPlanId!,
        budget: metadata.webPlanBudget || null,
        metadata: { type: 'web', hasSubscription: true }
      },
      {
        planId: metadata.productionPlanId!,
        planName: metadata.productionPlanId === 'signature' ? 'Signature' : metadata.productionPlanId!,
        budget: metadata.productionPlanBudget || null,
        metadata: { type: 'production' }
      }
    ];

    const response = await axios.post(
      `${this.config.PROJECT_SERVICE_URL}/internal/projects/create-with-modules`,
      {
        clientId,
        invoiceId: invoice.id,
        totalBudget: invoice.amount,
        modules,
        metadata: {
          case: caseType,
          createdVia: 'phoenix_workflow_multimodule_legacy',
          hasSubscription: !!subscriptionId,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.config.INTERNAL_SECRET,
        },
        timeout: 15000,
      }
    );

    if (response.data.success) {
      const { project, modules: createdModules, briefs } = response.data.data;
      this.logWorkflowSummary('Multi-Module Legacy', caseType, clientId, project.id,
        createdModules, briefs, subscriptionId);
    } else {
      throw new Error(response.data.error || 'Project service returned unsuccessful response');
    }

    return response;
  }

  /**
   * Create single module project
   */
  private async createSingleModuleProject(
    invoice: InvoiceRecord,
    clientId: string,
    subscriptionId: string,
    caseType: string,
    metadata: CheckoutMetadata
  ) {
    console.log('[Phoenix Webhook] Creating single-module project');

    const response = await axios.post(
      `${this.config.PROJECT_SERVICE_URL}/internal/projects/create-with-workflow`,
      {
        clientId,
        planId: invoice.planId,
        planName: invoice.planName,
        invoiceId: invoice.id,
        budget: invoice.amount,
        metadata: {
          case: caseType,
          createdVia: 'phoenix_workflow',
          hasSubscription: !!subscriptionId,
          webPlanId: metadata.webPlanId,
          productionPlanId: metadata.productionPlanId,
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': this.config.INTERNAL_SECRET,
        },
        timeout: 10000,
      }
    );

    if (response.data.success) {
      const { project, brief, steps } = response.data.data;
      console.log('[Phoenix Webhook] Project created:', project.id, '| Brief:', brief.id, '| Steps:', steps.length);

      console.log('\n' + '='.repeat(60));
      console.log('[Phoenix Workflow Summary]');
      console.log(`Case: ${caseType} | Plan: ${invoice.planName} | Client: ${clientId}`);
      console.log(`Project: ${project.id} | Brief: ${brief.id} | Steps: ${steps.length}`);
      if (subscriptionId) console.log(`Subscription: ${subscriptionId} (30 day trial)`);
      console.log('='.repeat(60) + '\n');
    } else {
      throw new Error(response.data.error || 'Project service returned unsuccessful response');
    }

    return response;
  }

  /**
   * Log workflow summary for multi-module projects
   */
  private logWorkflowSummary(
    type: string,
    caseType: string,
    clientId: string,
    projectId: string,
    modules: any[],
    briefs: any[],
    subscriptionId?: string
  ): void {
    console.log('\n' + '='.repeat(60));
    console.log(`[Phoenix Workflow Summary - ${type}]`);
    console.log(`Case: ${caseType} | Client: ${clientId} | Project: ${projectId}`);
    console.log(`Total Modules: ${modules.length} | Total Briefs: ${briefs.length}`);
    modules.forEach((m: any, i: number) => {
      console.log(`  Module ${i + 1}: ${m.type} - ${m.planName} (Brief: ${briefs[i]?.id || 'N/A'})`);
    });
    if (subscriptionId) console.log(`Subscription: ${subscriptionId} (30 day trial)`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Handle project creation errors
   */
  private handleProjectCreationError(error: unknown, invoiceId: string, clientId: string): void {
    if (axios.isAxiosError(error)) {
      console.error('[Phoenix Webhook] Project service call failed:', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      });
    } else {
      console.error('[Phoenix Webhook] Project service call failed:',
        error instanceof Error ? error.message : error);
    }
    console.error('[Phoenix Webhook] CRITICAL: Project creation failed. Invoice:', invoiceId, '| Client:', clientId);
  }
}
