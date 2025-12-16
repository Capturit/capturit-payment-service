/**
 * Checkout Helpers
 * Builder functions for Stripe checkout line items
 */

import Stripe from 'stripe';

// =============================================================================
// TYPES
// =============================================================================

export interface PlanInfo {
  id: string;
  name: string;
  priceCents: number;
  billingPeriod: string | null;
  description: string | null;
}

export interface CartItem {
  planId: string;
  type: 'subscription' | 'one_time';
  billingPeriod?: 'monthly' | 'yearly';
  amount?: number;
}

export interface ModuleData {
  planId: string;
  planName: string;
  priceCents: number;
  type: string;
}

export interface PendingUserMetadata {
  pendingUserEmail: string;
  pendingUserFirstName: string;
  pendingUserLastName: string;
  pendingUserHashedPassword: string;
  pendingUserCompany: string;
  pendingUserPhone: string;
  authMethod: string;
  pendingUserAvatar?: string; // Google avatar URL
}

// =============================================================================
// LINE ITEM BUILDERS
// =============================================================================

/**
 * Build subscription line item with recurring billing
 */
export function buildSubscriptionLineItem(
  plan: PlanInfo,
  priceCents: number,
  billingPeriod: 'monthly' | 'yearly'
): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    price_data: {
      currency: 'eur',
      product_data: {
        name: plan.name,
        description: `Abonnement ${billingPeriod === 'monthly' ? 'mensuel' : 'annuel'}`
      },
      unit_amount: priceCents,
      recurring: {
        interval: billingPeriod === 'monthly' ? 'month' : 'year'
      }
    },
    quantity: 1
  };
}

/**
 * Build one-time setup fee line item
 */
export function buildSetupFeeLineItem(setupFeeCents: number): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    price_data: {
      currency: 'eur',
      product_data: {
        name: 'Frais de mise en service',
        description: 'Paiement unique - Configuration et mise en place'
      },
      unit_amount: setupFeeCents
    },
    quantity: 1
  };
}

/**
 * Build one-time production item line item
 */
export function buildProductionLineItem(
  plan: PlanInfo,
  priceCents: number,
  isPartOfSubscription: boolean = false
): Stripe.Checkout.SessionCreateParams.LineItem {
  return {
    price_data: {
      currency: 'eur',
      product_data: {
        name: plan.name,
        description: isPartOfSubscription
          ? 'Formule Production (paiement unique)'
          : plan.description || 'Formule Production'
      },
      unit_amount: priceCents
    },
    quantity: 1
  };
}

// =============================================================================
// METADATA BUILDERS
// =============================================================================

/**
 * Build pending user metadata for checkout session
 */
export function buildPendingUserMetadata(
  email: string,
  firstName: string,
  lastName: string,
  hashedPassword: string,
  company: string | undefined,
  phone: string | undefined,
  authMethod: string,
  avatar?: string
): PendingUserMetadata {
  return {
    pendingUserEmail: email,
    pendingUserFirstName: firstName,
    pendingUserLastName: lastName,
    pendingUserHashedPassword: hashedPassword,
    pendingUserCompany: company || '',
    pendingUserPhone: phone || '',
    authMethod,
    ...(avatar && { pendingUserAvatar: avatar })
  };
}

// =============================================================================
// PRICE HELPERS
// =============================================================================

/**
 * Calculate price in cents from cart item or plan
 */
export function calculatePriceCents(
  cartItemAmount: number | undefined,
  planPriceCents: number
): number {
  return cartItemAmount ? Math.round(cartItemAmount * 100) : planPriceCents;
}

/**
 * Build modules data array from production items
 */
export function buildModulesData(
  productionItems: CartItem[],
  dbPlans: PlanInfo[]
): { modulesData: ModuleData[]; lineItems: Stripe.Checkout.SessionCreateParams.LineItem[]; notFoundPlanId: string | null } {
  const modulesData: ModuleData[] = [];
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
  let notFoundPlanId: string | null = null;

  for (const productionItem of productionItems) {
    const productionPlan = dbPlans.find(p => p.id === productionItem.planId);
    if (!productionPlan) {
      notFoundPlanId = productionItem.planId;
      break;
    }

    const priceCents = calculatePriceCents(productionItem.amount, productionPlan.priceCents);

    lineItems.push(buildProductionLineItem(productionPlan, priceCents));

    modulesData.push({
      planId: productionPlan.id,
      planName: productionPlan.name,
      priceCents: priceCents,
      type: 'production'
    });
  }

  return { modulesData, lineItems, notFoundPlanId };
}
