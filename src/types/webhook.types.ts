/**
 * Webhook Types
 * Type definitions for Stripe webhook handling and Phoenix workflow
 */

import Stripe from 'stripe';
import { DbClient } from '@capturit/shared';

/**
 * Pending auth tokens stored temporarily for auto-login
 */
export interface PendingAuthToken {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  createdAt: Date;
}

/**
 * Checkout session metadata from Stripe
 */
export interface CheckoutMetadata {
  case?: string; // 'A', 'B', or 'C'
  pendingUserEmail?: string;
  pendingUserFirstName?: string;
  pendingUserLastName?: string;
  pendingUserFullName?: string;
  pendingUserHashedPassword?: string;
  pendingUserCompany?: string;
  pendingUserPhone?: string;
  webPlanId?: string;
  productionPlanId?: string;
  webPlanBudget?: string;
  productionPlanBudget?: string;
  planId?: string;
  planType?: string;
  totalAmount?: string;
  totalAmountCents?: string;
  invoiceDescription?: string;
  modulesJson?: string;
  moduleCount?: string;
}

/**
 * Module data parsed from modulesJson
 */
export interface ModuleData {
  planId: string;
  planName: string;
  priceCents: number;
  type: string;
}

/**
 * Module input for project service
 */
export interface ModuleInput {
  planId: string;
  planName: string;
  budget: string | null;
  metadata: {
    type: string;
    hasSubscription?: boolean;
    originalPriceCents?: number;
  };
}

/**
 * Invoice record from database
 */
export interface InvoiceRecord {
  id: string;
  clientId: string;
  invoiceNumber: string;
  amount: string;
  currency: string;
  status: string;
  paidAt: Date | null;
  planId: string | null;
  planName: string | null;
  description: string | null;
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  projectId: string | null;
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Webhook handler context
 */
export interface WebhookContext {
  stripe: Stripe;
  db: DbClient;
  config: {
    PROJECT_SERVICE_URL: string;
    INTERNAL_SECRET: string;
  };
  pendingAuthTokens: Map<string, PendingAuthToken>;
}
