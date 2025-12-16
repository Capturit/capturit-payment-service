/**
 * Checkout Routes - Create Stripe checkout sessions
 * This centralizes all Stripe checkout logic in the payment service
 */

import { Router, Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import { eq, inArray, plans, pricingPlans, capturitWebPlan, products, getFrontendConfig, authenticate, AuthRequest, DbClient, invoices, users } from '@capturit/shared';
import { z } from 'zod';
import { checkoutSessionLimiter, storageCheckoutLimiter } from '../middleware/rateLimiter';
import {
  buildSubscriptionLineItem,
  buildSetupFeeLineItem,
  buildProductionLineItem,
  buildPendingUserMetadata,
  buildModulesData,
  calculatePriceCents,
  type PlanInfo,
} from '../helpers/checkout.helpers';

// =============================================================================
// VALIDATION SCHEMAS
// =============================================================================

const CartItemSchema = z.object({
  planId: z.string().min(1, 'planId requis'),
  type: z.enum(['subscription', 'one_time']),
  billingPeriod: z.enum(['monthly', 'yearly']).optional(),
  amount: z.number().positive().optional(),
});

const CreateCheckoutSessionSchema = z.object({
  email: z.string().email('Email invalide'),
  firstName: z.string().min(1, 'Prénom requis').max(100),
  lastName: z.string().min(1, 'Nom requis').max(100),
  hashedPassword: z.string(), // Can be empty for Google auth
  company: z.string().max(200).optional(),
  phone: z.string().max(20).optional(),
  cartItems: z.array(CartItemSchema).min(1, 'Au moins un produit requis'),
  authMethod: z.enum(['email', 'google']).default('email'),
  avatar: z.string().url().optional(), // Google avatar URL
  cancelUrl: z.string().url().optional(), // Custom cancel URL (defaults to CLIENT_FRONT_URL)
  source: z.enum(['web', 'sw']).optional(), // Source of registration
});

const StorageCheckoutSchema = z.object({
  clientId: z.string().uuid('clientId invalide'),
  storagePlanId: z.string().min(1, 'storagePlanId requis'),
  stripeCustomerId: z.string().optional(),
  email: z.string().email().optional(),
});

// Schema for authenticated user checkout (existing clients ordering from catalog)
const AuthenticatedCheckoutSchema = z.object({
  cartItems: z.array(CartItemSchema).min(1, 'Au moins un produit requis'),
  stripeCustomerId: z.string().optional(),
});

// Types inferred from schemas
type CartItem = z.infer<typeof CartItemSchema>;
type CreateCheckoutSessionInput = z.infer<typeof CreateCheckoutSessionSchema>;

export function createCheckoutRoutes(
  stripe: Stripe,
  db: DbClient
): Router {
  const router = Router();
  const frontendConfig = getFrontendConfig();

  /**
   * POST /checkout/session
   * Create a Stripe checkout session for registration
   */
  router.post('/session', checkoutSessionLimiter, async (req: Request, res: Response) => {
    try {
      // Validate input with Zod
      const validationResult = CreateCheckoutSessionSchema.safeParse(req.body);
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(', ');
        return res.status(400).json({
          success: false,
          error: errors
        });
      }

      const {
        email,
        firstName,
        lastName,
        hashedPassword,
        company,
        phone,
        cartItems,
        authMethod,
        avatar,
        cancelUrl,
        source
      } = validationResult.data;

      // Build cancel URL - use provided cancelUrl or construct from source and plan
      // Get the main plan ID (first non-setup-fee item) to restore user's selection
      const mainPlanId = cartItems.find(item => item.planId !== 'setup-fee')?.planId;
      const finalCancelUrl = cancelUrl || (
        source === 'web'
          ? `${frontendConfig.AUTH_FRONT_URL}/register?source=web${mainPlanId ? `&formule=${mainPlanId}` : ''}`
          : source === 'sw'
          ? `${frontendConfig.AUTH_FRONT_URL}/register?source=sw${mainPlanId ? `&formule=${mainPlanId}` : ''}`
          : `${frontendConfig.AUTH_FRONT_URL}/register${mainPlanId ? `?formule=${mainPlanId}` : ''}`
      );

      // Filter out setup-fee items - handled automatically
      const filteredCartItems = cartItems.filter(item => item.planId !== 'setup-fee');
      const planIds = filteredCartItems.map(item => item.planId);

      console.log('[Checkout] Looking for planIds:', planIds);

      // Fetch plan details from ALL sources and combine results
      // Search in plans table (production plans)
      const plansResults = await db
        .select()
        .from(plans)
        .where(inArray(plans.id, planIds));

      console.log('[Checkout] Found in plans table:', plansResults.length, plansResults.map((p: any) => p.id));

      // Search in capturit_web_plan table (web subscription plans)
      const webPlanResults = await db
        .select()
        .from(capturitWebPlan)
        .where(inArray(capturitWebPlan.slug, planIds));

      console.log('[Checkout] Found in capturitWebPlan:', webPlanResults.length, webPlanResults.map((w: any) => w.slug));

      // Transform web plans to unified format
      const transformedWebPlans = webPlanResults.map(wp => ({
        id: wp.slug,
        name: wp.name,
        priceCents: wp.monthlyPrice,
        billingPeriod: 'monthly' as const,
        stripeProductId: wp.slug,
        stripePriceId: null,
        type: 'subscription',
        description: wp.description,
        recurring: true,
        currency: 'EUR',
        isActive: wp.published,
        features: wp.features,
        createdAt: wp.createdAt,
        updatedAt: wp.updatedAt,
        monthlyPrice: wp.monthlyPrice,
        yearlyPrice: wp.yearlyPrice,
        setupFee: wp.setupFee,
        isPopular: wp.isPopular,
        isCustom: wp.isCustom
      }));

      // Combine all results
      let dbPlans: any[] = [...plansResults, ...transformedWebPlans];

      // If still missing some plans, search in pricing_plans view
      const foundIds = dbPlans.map((p: any) => p.id);
      const missingIds = planIds.filter(id => !foundIds.includes(id));

      if (missingIds.length > 0) {
        console.log('[Checkout] Still missing planIds, searching pricingPlans:', missingIds);
        const pricingPlanResults = await db
          .select()
          .from(pricingPlans)
          .where(inArray(pricingPlans.slug, missingIds));

        console.log('[Checkout] Found in pricingPlans:', pricingPlanResults.length);

        const transformedPricingPlans = pricingPlanResults.map(pp => ({
          id: pp.slug || pp.planId,
          name: pp.name,
          priceCents: pp.price,
          billingPeriod: pp.billingPeriod === 'monthly' || pp.billingPeriod === 'yearly' ? pp.billingPeriod : null,
          stripeProductId: pp.planId,
          stripePriceId: null,
          type: pp.billingPeriod === 'one_time' ? 'production' : 'web',
          description: pp.description,
          recurring: pp.billingPeriod !== 'one_time',
          currency: pp.currency || 'EUR',
          isActive: (pp as any).isActive ?? (pp as any).active ?? true,
          features: pp.features,
          createdAt: pp.createdAt,
          updatedAt: pp.updatedAt
        }));

        dbPlans = [...dbPlans, ...transformedPricingPlans];
      }

      console.log('[Checkout] Total plans found:', dbPlans.length, dbPlans.map((p: any) => p.id));

      const dbProducts = await db.select().from(products);

      // Separate Web (recurring) from Production (one-off)
      const webItems = filteredCartItems.filter(item => item.type === 'subscription');
      const productionItems = filteredCartItems.filter(item => item.type === 'one_time');

      const hasWeb = webItems.length > 0;
      const hasProduction = productionItems.length > 0;

      // Default setup fee from products table (fallback)
      const setupFeeProduct = dbProducts.find(p => p.type === 'setup_fee');
      const defaultSetupFeeCents = setupFeeProduct?.priceCents || 30000;

      // Common metadata for pending user
      const pendingUserMetadata = buildPendingUserMetadata(
        email, firstName, lastName, hashedPassword, company, phone, authMethod, avatar
      );

      let checkoutSession: Stripe.Checkout.Session;

      if (hasWeb && !hasProduction) {
        // === CASE A: Web Only (Subscription + Setup Fee) ===
        const webItem = webItems[0];
        const webPlan = dbPlans.find(p => p.id === webItem.planId) as PlanInfo | undefined;

        if (!webPlan) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${webItem.planId}`
          });
        }

        const webPriceCents = calculatePriceCents(webItem.amount, webPlan.priceCents);
        const billingPeriod = (webItem.billingPeriod || webPlan.billingPeriod || 'monthly') as 'monthly' | 'yearly';

        // Use plan-specific setup fee if available, otherwise use default
        // Check both setupFee (from capturit_web_plan) and setup_fee_cents (from plans table)
        const planSetupFee = (webPlan as any).setupFee || (webPlan as any).setup_fee_cents || (webPlan as any).setupFeeCents;
        const setupFeeCents = planSetupFee && planSetupFee > 0 ? planSetupFee : defaultSetupFeeCents;
        console.log(`[Checkout] Case A - Using setup fee: ${setupFeeCents} cents for plan ${webPlan.id} (plan has setupFee: ${(webPlan as any).setupFee}, setup_fee_cents: ${(webPlan as any).setup_fee_cents})`);

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          buildSubscriptionLineItem(webPlan, webPriceCents, billingPeriod),
          buildSetupFeeLineItem(setupFeeCents)
        ];

        // Create modulesData for web plan so it gets its own brief
        const webModulesData = [{
          planId: webPlan.id,
          planName: webPlan.name,
          priceCents: webPriceCents,
          type: 'web'
        }];

        console.log(`[Checkout] Case A - Creating 1 web module:`, webModulesData[0].planId);

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer_email: email,
          line_items: lineItems,
          subscription_data: {
            trial_period_days: 30,
            metadata: { planId: webPlan.id, pendingRegistration: 'true' }
          },
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: finalCancelUrl,
          metadata: {
            case: 'A',
            planType: 'web',
            planId: webPlan.id,
            modulesJson: JSON.stringify(webModulesData),
            moduleCount: '1',
            ...pendingUserMetadata
          }
        });

      } else if (!hasWeb && hasProduction) {
        // === CASE B: Production Only (One-off) ===
        const { modulesData, lineItems, notFoundPlanId } = buildModulesData(
          productionItems,
          dbPlans as PlanInfo[]
        );

        if (notFoundPlanId) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${notFoundPlanId}`
          });
        }

        console.log(`[Checkout] Case B - Creating ${modulesData.length} production module(s):`, modulesData.map(m => m.planId));

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer_email: email,
          line_items: lineItems,
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: finalCancelUrl,
          metadata: {
            case: 'B',
            planType: 'production',
            modulesJson: JSON.stringify(modulesData),
            moduleCount: String(modulesData.length),
            ...pendingUserMetadata
          }
        });

      } else if (hasWeb && hasProduction) {
        // === CASE C: Web + Production (Mixed) ===
        const webItem = webItems[0];
        const webPlan = dbPlans.find(p => p.id === webItem.planId) as PlanInfo | undefined;

        if (!webPlan) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${webItem.planId}`
          });
        }

        const webPriceCents = calculatePriceCents(webItem.amount, webPlan.priceCents);
        const billingPeriod = (webItem.billingPeriod || webPlan.billingPeriod || 'monthly') as 'monthly' | 'yearly';

        // Use plan-specific setup fee if available, otherwise use default
        // Check both setupFee (from capturit_web_plan) and setup_fee_cents (from plans table)
        const planSetupFee = (webPlan as any).setupFee || (webPlan as any).setup_fee_cents || (webPlan as any).setupFeeCents;
        const setupFeeCents = planSetupFee && planSetupFee > 0 ? planSetupFee : defaultSetupFeeCents;
        console.log(`[Checkout] Case C - Using setup fee: ${setupFeeCents} cents for plan ${webPlan.id} (plan has setupFee: ${(webPlan as any).setupFee}, setup_fee_cents: ${(webPlan as any).setup_fee_cents})`);

        // Build production modules data
        const { modulesData: productionModulesData, notFoundPlanId } = buildModulesData(
          productionItems,
          dbPlans as PlanInfo[]
        );

        if (notFoundPlanId) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${notFoundPlanId}`
          });
        }

        // Build complete modulesData including BOTH web and production plans
        // This ensures each plan gets its own brief/module after payment
        const allModulesData = [
          // Web plan module first
          {
            planId: webPlan.id,
            planName: webPlan.name,
            priceCents: webPriceCents,
            type: 'web'
          },
          // Then all production plan modules
          ...productionModulesData
        ];

        // Build line items: subscription + setup fee + production items
        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          buildSubscriptionLineItem(webPlan, webPriceCents, billingPeriod),
          buildSetupFeeLineItem(setupFeeCents)
        ];

        // Add production items as one-time charges
        for (const productionItem of productionItems) {
          const productionPlan = dbPlans.find(p => p.id === productionItem.planId) as PlanInfo | undefined;
          if (productionPlan) {
            const priceCents = calculatePriceCents(productionItem.amount, productionPlan.priceCents);
            lineItems.push(buildProductionLineItem(productionPlan, priceCents, true));
          }
        }

        console.log(`[Checkout] Case C - Creating ${allModulesData.length} modules:`, allModulesData.map(m => `${m.type}:${m.planId}`));

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer_email: email,
          line_items: lineItems,
          subscription_data: {
            trial_period_days: 30,
            metadata: { planId: webPlan.id, pendingRegistration: 'true' }
          },
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: finalCancelUrl,
          metadata: {
            case: 'C',
            planType: 'mixed',
            webPlanId: webPlan.id,
            modulesJson: JSON.stringify(allModulesData),
            moduleCount: String(allModulesData.length),
            ...pendingUserMetadata
          }
        });

      } else {
        return res.status(400).json({
          success: false,
          error: 'Configuration de panier invalide'
        });
      }

      console.log(`[Checkout] Session created: ${checkoutSession.id} for ${email}`);

      res.json({
        success: true,
        checkoutUrl: checkoutSession.url,
        sessionId: checkoutSession.id
      });

    } catch (error: any) {
      console.error('[Checkout] Error creating session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la création de la session de paiement'
      });
    }
  });

  /**
   * POST /checkout/storage
   * Create a Stripe checkout session for storage addon (authenticated clients only)
   */
  router.post('/storage', storageCheckoutLimiter, authenticate, async (req: AuthRequest, res: Response) => {
    try {
      // Validate input with Zod
      const validationResult = StorageCheckoutSchema.safeParse(req.body);
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(', ');
        return res.status(400).json({
          success: false,
          error: errors
        });
      }

      const { clientId, storagePlanId, stripeCustomerId, email } = validationResult.data;

      // Verify authenticated user matches clientId
      if (req.user?.userId !== clientId) {
        return res.status(403).json({
          success: false,
          error: 'Non autorisé: clientId ne correspond pas à l\'utilisateur authentifié'
        });
      }

      // Fetch storage plan from database
      const [storagePlan] = await db
        .select()
        .from(plans)
        .where(eq(plans.id, storagePlanId));

      if (!storagePlan || storagePlan.category !== 'storage') {
        return res.status(404).json({
          success: false,
          error: 'Plan de stockage non trouvé'
        });
      }

      if (!storagePlan.stripePriceId) {
        return res.status(400).json({
          success: false,
          error: 'Ce plan n\'a pas de prix Stripe configuré'
        });
      }

      // Create or get Stripe customer
      let customerId = stripeCustomerId;
      if (!customerId && email) {
        // Look up existing customer or create new one
        const existingCustomers = await stripe.customers.list({
          limit: 1,
          email: email
        });

        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
        } else {
          const customer = await stripe.customers.create({
            email: email,
            metadata: { clientId }
          });
          customerId = customer.id;
        }
      }

      // Create checkout session for storage subscription
      const checkoutSession = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: [
          {
            price: storagePlan.stripePriceId,
            quantity: 1
          }
        ],
        success_url: `${frontendConfig.CLIENT_FRONT_URL}/settings/storage?success=true&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${frontendConfig.CLIENT_FRONT_URL}/settings/storage?cancelled=true`,
        metadata: {
          type: 'storage_addon',
          clientId,
          storagePlanId,
          storageGb: storagePlan.storageGb?.toString() || '0'
        },
        subscription_data: {
          metadata: {
            type: 'storage_addon',
            clientId,
            storagePlanId,
            storageGb: storagePlan.storageGb?.toString() || '0'
          }
        }
      });

      console.log(`[Checkout] Storage session created: ${checkoutSession.id} for client ${clientId}`);

      res.json({
        success: true,
        checkoutUrl: checkoutSession.url,
        sessionId: checkoutSession.id
      });

    } catch (error: any) {
      console.error('[Checkout] Error creating storage session:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la création de la session de paiement'
      });
    }
  });

  /**
   * POST /checkout/authenticated
   * Create a Stripe checkout session for authenticated users (ordering from catalog)
   * Creates invoice immediately, project created after webhook
   */
  router.post('/authenticated', checkoutSessionLimiter, authenticate, async (req: AuthRequest, res: Response) => {
    try {
      // Validate input with Zod
      const validationResult = AuthenticatedCheckoutSchema.safeParse(req.body);
      if (!validationResult.success) {
        const errors = validationResult.error.errors.map(e => e.message).join(', ');
        return res.status(400).json({
          success: false,
          error: errors
        });
      }

      const { cartItems, stripeCustomerId } = validationResult.data;
      const clientId = req.user!.userId;
      const clientEmail = req.user!.email;

      console.log(`[Checkout Authenticated] Processing order for client ${clientId} (${clientEmail})`);

      // Get client info from database
      const [client] = await db
        .select()
        .from(users)
        .where(eq(users.id, clientId))
        .limit(1);

      if (!client) {
        return res.status(404).json({
          success: false,
          error: 'Utilisateur non trouvé'
        });
      }

      // Filter out setup-fee items - handled automatically
      const filteredCartItems = cartItems.filter(item => item.planId !== 'setup-fee');
      const planIds = filteredCartItems.map(item => item.planId);

      console.log('[Checkout Authenticated] Looking for planIds:', planIds);

      // Fetch plan details from ALL sources (same logic as registration checkout)
      const plansResults = await db
        .select()
        .from(plans)
        .where(inArray(plans.id, planIds));

      const webPlanResults = await db
        .select()
        .from(capturitWebPlan)
        .where(inArray(capturitWebPlan.slug, planIds));

      // Transform web plans to unified format
      const transformedWebPlans = webPlanResults.map(wp => ({
        id: wp.slug,
        name: wp.name,
        priceCents: wp.monthlyPrice,
        billingPeriod: 'monthly' as const,
        stripeProductId: wp.slug,
        stripePriceId: null,
        type: 'subscription',
        description: wp.description,
        recurring: true,
        currency: 'EUR',
        isActive: wp.published,
        features: wp.features,
        monthlyPrice: wp.monthlyPrice,
        yearlyPrice: wp.yearlyPrice,
        setupFee: wp.setupFee,
        isPopular: wp.isPopular,
        isCustom: wp.isCustom
      }));

      let dbPlans: any[] = [...plansResults, ...transformedWebPlans];

      // If still missing some plans, search in pricing_plans view
      const foundIds = dbPlans.map((p: any) => p.id);
      const missingIds = planIds.filter(id => !foundIds.includes(id));

      if (missingIds.length > 0) {
        const pricingPlanResults = await db
          .select()
          .from(pricingPlans)
          .where(inArray(pricingPlans.slug, missingIds));

        const transformedPricingPlans = pricingPlanResults.map(pp => ({
          id: pp.slug || pp.planId,
          name: pp.name,
          priceCents: pp.price,
          billingPeriod: pp.billingPeriod === 'monthly' || pp.billingPeriod === 'yearly' ? pp.billingPeriod : null,
          stripeProductId: pp.planId,
          stripePriceId: null,
          type: pp.billingPeriod === 'one_time' ? 'production' : 'web',
          description: pp.description,
          recurring: pp.billingPeriod !== 'one_time',
          currency: pp.currency || 'EUR',
          isActive: (pp as any).isActive ?? (pp as any).active ?? true,
          features: pp.features
        }));

        dbPlans = [...dbPlans, ...transformedPricingPlans];
      }

      console.log('[Checkout Authenticated] Total plans found:', dbPlans.length);

      const dbProducts = await db.select().from(products);

      // Separate Web (recurring) from Production (one-off)
      const webItems = filteredCartItems.filter(item => item.type === 'subscription');
      const productionItems = filteredCartItems.filter(item => item.type === 'one_time');

      const hasWeb = webItems.length > 0;
      const hasProduction = productionItems.length > 0;

      // Default setup fee from products table (fallback)
      const setupFeeProduct = dbProducts.find(p => p.type === 'setup_fee');
      const defaultSetupFeeCents = setupFeeProduct?.priceCents || 30000;

      // Create or get Stripe customer
      let customerId = stripeCustomerId;
      if (!customerId) {
        const existingCustomers = await stripe.customers.list({
          limit: 1,
          email: clientEmail
        });

        if (existingCustomers.data.length > 0) {
          customerId = existingCustomers.data[0].id;
        } else {
          const customer = await stripe.customers.create({
            email: clientEmail,
            name: `${client.firstName} ${client.lastName}`.trim(),
            metadata: { clientId }
          });
          customerId = customer.id;
        }
      }

      let checkoutSession: Stripe.Checkout.Session;
      let caseType: 'A' | 'B' | 'C';
      let planType: 'web' | 'production' | 'mixed';
      let modulesData: any[] = [];
      let totalAmountCents = 0;
      let invoiceDescription = '';
      let mainPlanId = '';
      let mainPlanName = '';

      if (hasWeb && !hasProduction) {
        // === CASE A: Web Only (Subscription + Setup Fee) ===
        caseType = 'A';
        planType = 'web';
        const webItem = webItems[0];
        const webPlan = dbPlans.find(p => p.id === webItem.planId) as PlanInfo | undefined;

        if (!webPlan) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${webItem.planId}`
          });
        }

        const webPriceCents = calculatePriceCents(webItem.amount, webPlan.priceCents);
        const billingPeriod = (webItem.billingPeriod || webPlan.billingPeriod || 'monthly') as 'monthly' | 'yearly';

        const planSetupFee = (webPlan as any).setupFee || (webPlan as any).setup_fee_cents || (webPlan as any).setupFeeCents;
        const setupFeeCents = planSetupFee && planSetupFee > 0 ? planSetupFee : defaultSetupFeeCents;

        modulesData = [{
          planId: webPlan.id,
          planName: webPlan.name,
          priceCents: webPriceCents,
          type: 'web'
        }];

        totalAmountCents = webPriceCents + setupFeeCents;
        invoiceDescription = `Plan Web ${webPlan.name}`;
        mainPlanId = webPlan.id;
        mainPlanName = webPlan.name;

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          buildSubscriptionLineItem(webPlan, webPriceCents, billingPeriod),
          buildSetupFeeLineItem(setupFeeCents)
        ];

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: lineItems,
          subscription_data: {
            trial_period_days: 30,
            metadata: { planId: webPlan.id, clientId }
          },
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendConfig.CLIENT_FRONT_URL}/catalog?cancelled=true`,
          metadata: {
            case: caseType,
            planType,
            planId: webPlan.id,
            clientId,
            isExistingUser: 'true',
            modulesJson: JSON.stringify(modulesData),
            moduleCount: '1'
          }
        });

      } else if (!hasWeb && hasProduction) {
        // === CASE B: Production Only (One-off) ===
        caseType = 'B';
        planType = 'production';

        const { modulesData: builtModulesData, lineItems, notFoundPlanId } = buildModulesData(
          productionItems,
          dbPlans as PlanInfo[]
        );

        if (notFoundPlanId) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${notFoundPlanId}`
          });
        }

        modulesData = builtModulesData;
        totalAmountCents = modulesData.reduce((sum, m) => sum + m.priceCents, 0);
        invoiceDescription = modulesData.map(m => m.planName).join(' + ');
        mainPlanId = modulesData[0].planId;
        mainPlanName = modulesData[0].planName;

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'payment',
          customer: customerId,
          line_items: lineItems,
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendConfig.CLIENT_FRONT_URL}/catalog?cancelled=true`,
          metadata: {
            case: caseType,
            planType,
            clientId,
            isExistingUser: 'true',
            modulesJson: JSON.stringify(modulesData),
            moduleCount: String(modulesData.length)
          }
        });

      } else if (hasWeb && hasProduction) {
        // === CASE C: Web + Production (Mixed) ===
        caseType = 'C';
        planType = 'mixed';

        const webItem = webItems[0];
        const webPlan = dbPlans.find(p => p.id === webItem.planId) as PlanInfo | undefined;

        if (!webPlan) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${webItem.planId}`
          });
        }

        const webPriceCents = calculatePriceCents(webItem.amount, webPlan.priceCents);
        const billingPeriod = (webItem.billingPeriod || webPlan.billingPeriod || 'monthly') as 'monthly' | 'yearly';

        const planSetupFee = (webPlan as any).setupFee || (webPlan as any).setup_fee_cents || (webPlan as any).setupFeeCents;
        const setupFeeCents = planSetupFee && planSetupFee > 0 ? planSetupFee : defaultSetupFeeCents;

        const { modulesData: productionModulesData, notFoundPlanId } = buildModulesData(
          productionItems,
          dbPlans as PlanInfo[]
        );

        if (notFoundPlanId) {
          return res.status(404).json({
            success: false,
            error: `Plan non trouvé: ${notFoundPlanId}`
          });
        }

        modulesData = [
          {
            planId: webPlan.id,
            planName: webPlan.name,
            priceCents: webPriceCents,
            type: 'web'
          },
          ...productionModulesData
        ];

        const productionTotalCents = productionModulesData.reduce((sum, m) => sum + m.priceCents, 0);
        totalAmountCents = webPriceCents + setupFeeCents + productionTotalCents;
        invoiceDescription = modulesData.map(m => m.planName).join(' + ');
        mainPlanId = modulesData.map(m => m.planId).join(',');
        mainPlanName = modulesData.map(m => m.planName).join(' + ');

        const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
          buildSubscriptionLineItem(webPlan, webPriceCents, billingPeriod),
          buildSetupFeeLineItem(setupFeeCents)
        ];

        for (const productionItem of productionItems) {
          const productionPlan = dbPlans.find(p => p.id === productionItem.planId) as PlanInfo | undefined;
          if (productionPlan) {
            const priceCents = calculatePriceCents(productionItem.amount, productionPlan.priceCents);
            lineItems.push(buildProductionLineItem(productionPlan, priceCents, true));
          }
        }

        checkoutSession = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: lineItems,
          subscription_data: {
            trial_period_days: 30,
            metadata: { planId: webPlan.id, clientId }
          },
          success_url: `${frontendConfig.CLIENT_FRONT_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendConfig.CLIENT_FRONT_URL}/catalog?cancelled=true`,
          metadata: {
            case: caseType,
            planType,
            webPlanId: webPlan.id,
            clientId,
            isExistingUser: 'true',
            modulesJson: JSON.stringify(modulesData),
            moduleCount: String(modulesData.length)
          }
        });

      } else {
        return res.status(400).json({
          success: false,
          error: 'Configuration de panier invalide'
        });
      }

      // Create pending invoice record (will be marked as paid by webhook)
      const invoiceNumber = `INV-${caseType}-${Date.now()}-${clientId.slice(0, 8)}`;

      await db.insert(invoices).values({
        clientId,
        invoiceNumber,
        amount: (totalAmountCents / 100).toFixed(2),
        currency: 'eur',
        status: 'pending',
        planId: mainPlanId,
        planName: mainPlanName,
        description: invoiceDescription,
        stripeCheckoutSessionId: checkoutSession.id,
        stripeCustomerId: customerId,
        metadata: {
          case: caseType,
          type: planType,
          modulesJson: JSON.stringify(modulesData),
          moduleCount: modulesData.length,
          isExistingUser: true
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });

      console.log(`[Checkout Authenticated] Session created: ${checkoutSession.id}`);
      console.log(`[Checkout Authenticated] Case ${caseType} - ${modulesData.length} module(s)`);
      console.log(`[Checkout Authenticated] Invoice ${invoiceNumber} created (pending)`);

      res.json({
        success: true,
        checkoutUrl: checkoutSession.url,
        sessionId: checkoutSession.id
      });

    } catch (error: any) {
      console.error('[Checkout Authenticated] Error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Erreur lors de la création de la session de paiement'
      });
    }
  });

  return router;
}