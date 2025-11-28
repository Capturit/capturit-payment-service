// IMPORTANT: Load environment variables FIRST, before any other imports
// This ensures JWT_SECRET and other env vars are available when @capturit/shared initializes
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  createDbClient,
  projects,
  invoices,
  briefs,
  projectSteps,
  clientSubscriptions,
  refreshTokens,
  generateAccessToken,
  generateRefreshToken,
  users,
  type UserRole,
  DEFAULT_PORTS,
  getBackendConfig,
  getFrontendConfig,
} from '@capturit/shared';
import { eq } from 'drizzle-orm';

// Get centralized configuration
const backendConfig = getBackendConfig();
const frontendConfig = getFrontendConfig();

// Configuration - Using centralized config from capturit-shared
const config = {
  PORT: parseInt(process.env.PORT || String(DEFAULT_PORTS.PAYMENT_SERVICE), 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || backendConfig.DATABASE_URL,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
  CORS_ORIGIN: (process.env.CORS_ORIGIN || frontendConfig.CLIENT_FRONT_URL).split(','),
  AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL || backendConfig.AUTH_SERVICE_URL,
  CLIENT_FRONTEND_URL: process.env.CLIENT_FRONTEND_URL || frontendConfig.CLIENT_FRONT_URL,
};

// Validate required env vars
if (!config.DATABASE_URL) {
  throw new Error('DATABASE_URL is required');
}
if (!config.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is required');
}
if (!config.STRIPE_WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET is required');
}

// Initialize Stripe
const stripe = new Stripe(config.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// Initialize Database
const db = createDbClient(config.DATABASE_URL);

// Temporary storage for auto-login tokens (session_id -> tokens)
// In production, use Redis or similar
const pendingAuthTokens = new Map<string, {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
  createdAt: Date;
}>();

// Clean up expired tokens every 5 minutes (tokens valid for 10 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of pendingAuthTokens.entries()) {
    if (now - data.createdAt.getTime() > 10 * 60 * 1000) { // 10 minutes
      pendingAuthTokens.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Initialize Express app
const app = express();

// Security middleware
app.use(helmet());

// CORS
app.use(cors({
  origin: config.CORS_ORIGIN,
  credentials: true
}));

// Health check endpoint (before raw body middleware)
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'capturit-payment-service',
    timestamp: new Date().toISOString()
  });
});

// Auto-login endpoint - Exchange session_id for auth tokens after successful payment
app.get('/auth/session/:sessionId', async (req: Request, res: Response) => {
  const { sessionId } = req.params;

  console.log('[Auto-Login] Checking session:', sessionId);

  // First, check if we have tokens in memory (fastest path)
  const authData = pendingAuthTokens.get(sessionId);

  if (authData) {
    // Check if tokens are still valid (10 minute window)
    const now = Date.now();
    if (now - authData.createdAt.getTime() > 10 * 60 * 1000) {
      pendingAuthTokens.delete(sessionId);
      // Fall through to database lookup
    } else {
      // Return tokens and remove from pending (one-time use)
      pendingAuthTokens.delete(sessionId);

      console.log('[Auto-Login] Returning cached tokens for user:', authData.email);

      return res.status(200).json({
        success: true,
        data: {
          accessToken: authData.accessToken,
          refreshToken: authData.refreshToken,
          userId: authData.userId,
          email: authData.email
        }
      });
    }
  }

  // Fallback: Look up user from database via invoice's stripeCheckoutSessionId
  console.log('[Auto-Login] No cached tokens, checking database for session:', sessionId);

  try {
    // Find invoice with this checkout session ID
    const [invoice] = await db
      .select()
      .from(invoices)
      .where(eq(invoices.stripeCheckoutSessionId, sessionId))
      .limit(1);

    if (!invoice) {
      console.log('[Auto-Login] No invoice found for session:', sessionId);
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Check if invoice is paid (payment was successful)
    if (invoice.status !== 'paid') {
      console.log('[Auto-Login] Invoice not paid yet:', invoice.status);
      return res.status(400).json({
        success: false,
        error: 'Payment not completed yet'
      });
    }

    // Get the user associated with this invoice
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, invoice.clientId))
      .limit(1);

    if (!user) {
      console.log('[Auto-Login] User not found for invoice:', invoice.id);
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Generate new tokens for the user
    const userRoles: UserRole[] = (user.roles as any)?.roles || ['client'];
    const accessToken = generateAccessToken(user.id, user.email, userRoles);
    const refreshTokenString = generateRefreshToken(user.id, user.email, userRoles);

    // Hash refresh token before storing in database
    const hashedRefreshToken = await bcrypt.hash(refreshTokenString, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    // Store refresh token in database
    await db.insert(refreshTokens).values({
      userId: user.id,
      token: hashedRefreshToken,
      expiresAt,
    });

    console.log('[Auto-Login] Generated new tokens from database for user:', user.email);

    return res.status(200).json({
      success: true,
      data: {
        accessToken,
        refreshToken: refreshTokenString,
        userId: user.id,
        email: user.email
      }
    });

  } catch (error) {
    console.error('[Auto-Login] Database lookup error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error'
    });
  }
});

// Stripe webhook endpoint - MUST use express.raw() for signature verification
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const sig = req.headers['stripe-signature'];

    if (!sig) {
      console.error('[Webhook] Missing stripe-signature header');
      return res.status(400).send('Missing signature');
    }

    let event: Stripe.Event;

    try {
      // Verify webhook signature
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        config.STRIPE_WEBHOOK_SECRET
      );
    } catch (err: any) {
      console.error('[Webhook] Signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log(`[Webhook] Received event: ${event.type}`);

    // Handle the event
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
          break;

        case 'checkout.session.expired':
          await handleCheckoutSessionExpired(event.data.object as Stripe.Checkout.Session);
          break;

        case 'payment_intent.succeeded':
          console.log('[Webhook] Payment intent succeeded:', event.data.object.id);
          // Additional logic if needed
          break;

        case 'payment_intent.payment_failed':
          await handlePaymentFailed(event.data.object as Stripe.PaymentIntent);
          break;

        default:
          console.log(`[Webhook] Unhandled event type: ${event.type}`);
      }

      res.status(200).json({ received: true });
    } catch (error: any) {
      console.error('[Webhook] Error processing event:', error);
      res.status(500).json({ error: 'Webhook handler failed' });
    }
  }
);

/**
 * Detect project type from plan ID
 */
function detectProjectType(planId: string): string {
  const normalizedPlanId = planId.toLowerCase();

  if (normalizedPlanId.includes('video') || normalizedPlanId.includes('film') || normalizedPlanId.includes('clip')) {
    return 'video';
  }
  if (normalizedPlanId.includes('web') || normalizedPlanId.includes('site') || normalizedPlanId.includes('website')) {
    return 'web';
  }
  if (normalizedPlanId.includes('photo') || normalizedPlanId.includes('photography')) {
    return 'photo';
  }
  if (normalizedPlanId.includes('brand') || normalizedPlanId.includes('logo') || normalizedPlanId.includes('design')) {
    return 'branding';
  }

  return 'web'; // Default to web
}

/**
 * Get workflow template based on plan type
 * Uses hardcoded templates for now - can be extended to fetch from database later
 */
function getWorkflowTemplate(planId: string) {
  const projectType = detectProjectType(planId);
  console.log(`[Workflow] Using template for project type: ${projectType}`);

  const templates: Record<string, any> = {
    video: {
      name: 'Vidéo Production',
      steps: [
        { name: 'Pre-production', order: 1, description: 'Script writing, storyboarding, and planning', estimatedDays: 5 },
        { name: 'Filming', order: 2, description: 'On-location shooting and capture', estimatedDays: 2 },
        { name: 'Post-production', order: 3, description: 'Editing, color grading, and sound design', estimatedDays: 7 },
        { name: 'Review & Revisions', order: 4, description: 'Client feedback and adjustments', estimatedDays: 3 },
        { name: 'Final Delivery', order: 5, description: 'Export and delivery of final files', estimatedDays: 1 }
      ],
      estimatedDuration: 18
    },
    web: {
      name: 'Site Web Standard',
      steps: [
        { name: 'Design', order: 1, description: 'UI/UX design and mockups', estimatedDays: 7 },
        { name: 'Development', order: 2, description: 'Frontend and backend implementation', estimatedDays: 14 },
        { name: 'QA Testing', order: 3, description: 'Quality assurance and bug fixing', estimatedDays: 3 },
        { name: 'Review & Revisions', order: 4, description: 'Client feedback and adjustments', estimatedDays: 3 },
        { name: 'Deployment', order: 5, description: 'Launch and go-live', estimatedDays: 1 }
      ],
      estimatedDuration: 28
    },
    photo: {
      name: 'Shooting Photo',
      steps: [
        { name: 'Planning', order: 1, description: 'Location scouting and shot list preparation', estimatedDays: 3 },
        { name: 'Photo Shoot', order: 2, description: 'On-location photography session', estimatedDays: 1 },
        { name: 'Selection', order: 3, description: 'Image selection and curation', estimatedDays: 2 },
        { name: 'Retouching', order: 4, description: 'Professional photo editing and enhancement', estimatedDays: 5 },
        { name: 'Final Delivery', order: 5, description: 'Export and delivery of final images', estimatedDays: 1 }
      ],
      estimatedDuration: 12
    },
    branding: {
      name: 'Branding & Design',
      steps: [
        { name: 'Discovery', order: 1, description: 'Brand research and strategy development', estimatedDays: 5 },
        { name: 'Concepts', order: 2, description: 'Initial design concepts and iterations', estimatedDays: 7 },
        { name: 'Refinement', order: 3, description: 'Design refinement based on feedback', estimatedDays: 5 },
        { name: 'Finalization', order: 4, description: 'Final designs and brand guidelines', estimatedDays: 3 },
        { name: 'Delivery', order: 5, description: 'Export all assets and documentation', estimatedDays: 1 }
      ],
      estimatedDuration: 21
    }
  };

  return templates[projectType] || templates.web;
}

// Handle successful checkout (Phoenix Workflow)
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  console.log('[Phoenix Webhook] Processing checkout.session.completed:', session.id);
  console.log('[Phoenix Webhook] Metadata:', session.metadata);

  const checkoutSessionId = session.id;
  const paymentIntentId = session.payment_intent as string;
  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;
  const clientEmail = session.customer_email || session.customer_details?.email;
  const metadata = session.metadata || {};
  const caseType = metadata.case; // 'A', 'B', or 'C'

  // Check if this is a pending registration (new user flow)
  if (metadata.pendingUserEmail) {
    console.log('[Phoenix Webhook] Pending registration detected - creating user first');

    // Create the user account now that payment is successful
    // Note: 'users' schema is imported statically at the top of the file

    const [newUser] = await db.insert(users).values({
      firstName: metadata.pendingUserFirstName || metadata.pendingUserFullName?.split(' ')[0] || 'Client',
      lastName: metadata.pendingUserLastName || metadata.pendingUserFullName?.split(' ').slice(1).join(' ') || '',
      email: metadata.pendingUserEmail,
      password: metadata.pendingUserHashedPassword, // Already hashed
      companyName: metadata.pendingUserCompany || null,
      phone: metadata.pendingUserPhone || null,
      roles: { roles: ['client'] as UserRole[] },
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    }).returning();

    console.log('[Phoenix Webhook] User created:', newUser.id, newUser.email);

    // Generate authentication tokens for auto-login after redirect
    const userRoles: UserRole[] = ['client'];
    const accessToken = generateAccessToken(newUser.id, newUser.email, userRoles);
    const refreshTokenString = generateRefreshToken(newUser.id, newUser.email, userRoles);

    // Hash refresh token before storing in database
    const hashedRefreshToken = await bcrypt.hash(refreshTokenString, 10);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 days

    // Store refresh token in database
    await db.insert(refreshTokens).values({
      userId: newUser.id,
      token: hashedRefreshToken,
      expiresAt,
    });

    // Store tokens in pending auth map for auto-login
    pendingAuthTokens.set(checkoutSessionId, {
      accessToken,
      refreshToken: refreshTokenString,
      userId: newUser.id,
      email: newUser.email,
      createdAt: new Date()
    });

    console.log('[Phoenix Webhook] Auth tokens generated and stored for session:', checkoutSessionId);

    // Create invoice for this user
    // Determine plan info based on case type
    let planId: string;
    let planName: string;

    if (caseType === 'C') {
      // Mixed cart: use web plan as primary (subscription)
      planId = metadata.webPlanId || 'growth';
      planName = `${metadata.webPlanId === 'growth' ? 'Growth' : metadata.webPlanId} + ${metadata.productionPlanId === 'signature' ? 'Signature' : metadata.productionPlanId}`;
    } else if (caseType === 'A') {
      // Web only
      planId = metadata.webPlanId || metadata.planId || 'growth';
      planName = metadata.webPlanId === 'growth' ? 'Growth' : (metadata.webPlanId || 'Formule Web');
    } else {
      // Production only (Case B)
      planId = metadata.productionPlanId || metadata.planId || 'signature';
      planName = metadata.productionPlanId === 'signature' ? 'Signature' : (metadata.productionPlanId || 'Production');
    }

    const invoiceNumber = `INV-${caseType}-${Date.now()}-${newUser.id.substring(0, 8)}`;
    const [invoice] = await db.insert(invoices).values({
      clientId: newUser.id,
      invoiceNumber,
      amount: metadata.totalAmount || '0',
      currency: 'eur',
      status: 'paid', // Payment already succeeded
      paidAt: new Date(),
      planId: planId,
      planName: planName,
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

    // Continue with project creation using the new user and invoice
    const clientId = newUser.id;
    await createProjectAndWorkflow(invoice, clientId, subscriptionId, customerId, caseType, metadata);

  } else {
    // Old flow: invoice already exists with clientId
    const [invoice] = await db
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
    const [updatedInvoice] = await db
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

    await createProjectAndWorkflow(updatedInvoice, updatedInvoice.clientId, subscriptionId, customerId, caseType, metadata);
  }

  console.log('[Phoenix Webhook] Checkout session completed successfully');
}

// Extracted function to create project and workflow
async function createProjectAndWorkflow(
  invoice: any,
  clientId: string,
  subscriptionId: string,
  customerId: string,
  caseType: string,
  metadata: any
) {
  console.log('[Phoenix Webhook] Creating project and workflow for client:', clientId);

  // === Handle Subscription Creation (Case A & C) ===
  if (subscriptionId && (caseType === 'A' || caseType === 'C')) {
    console.log('[Phoenix Webhook] Creating subscription record for:', subscriptionId);

    try {
      // Fetch subscription details from Stripe
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);

      // Extract plan ID from metadata
      const planId = caseType === 'A'
        ? invoice.planId
        : (metadata.webPlanId || invoice.planId.split(',')[0]);

      // Create client subscription record
      await db.insert(clientSubscriptions).values({
        id: crypto.randomUUID(),
        clientId: clientId,
        planId: planId,
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
      console.error('[Phoenix Webhook] Failed to create subscription record:', subError instanceof Error ? subError.message : subError);
      // Continue with project creation even if subscription fails
    }
  }

  // === Create Project & Brief (All Cases) ===
  if (invoice.planId && invoice.planName) {
    console.log('[Phoenix Webhook] Creating project for plan:', invoice.planName);

    // Create a new project with status 'onboarding_pending'
    const [newProject] = await db
      .insert(projects)
      .values({
        clientId: clientId,
        title: `${invoice.planName}`,
        description: invoice.description || `Project created from ${invoice.planName} plan purchase. Awaiting brief completion.`,
        status: 'onboarding_pending',
        budget: invoice.amount,
        metadata: {
          planId: invoice.planId,
          planName: invoice.planName,
          invoiceId: invoice.id,
          case: caseType,
          createdVia: 'phoenix_workflow',
          hasSubscription: !!subscriptionId
        },
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    console.log('[Phoenix Webhook] Project created:', newProject.id);

    // Link invoice to project
    await db
      .update(invoices)
      .set({
        projectId: newProject.id,
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id));

    console.log('[Phoenix Webhook] Invoice linked to project');

    // Create an empty brief for the project
    const [newBrief] = await db
      .insert(briefs)
      .values({
        projectId: newProject.id,
        clientId: clientId,
        status: 'pending',
        content: {}, // Empty object - to be filled by client
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    console.log('[Phoenix Webhook] Brief created:', newBrief.id);

    // Create default project steps based on plan type
    // For mixed cart (Case C), use the primary plan (Web)
    const primaryPlanId = caseType === 'C'
      ? (metadata.webPlanId || invoice.planId.split(',')[0])
      : invoice.planId;

    const workflowTemplate = getWorkflowTemplate(primaryPlanId);
    console.log(`[Phoenix Webhook] Using template: ${workflowTemplate.name}`);
    console.log(`[Phoenix Webhook] Creating ${workflowTemplate.steps.length} workflow steps`);

    // Create a mapping of step names to their IDs for dependency resolution
    const stepIdMap = new Map<string, string>();

    // First pass: Create all steps
    for (const stepDef of workflowTemplate.steps) {
      // Generate a unique UUID for this step
      const stepId = crypto.randomUUID();
      stepIdMap.set(stepDef.name, stepId);

      // Calculate due date based on estimated days (if available)
      let dueDate = null;
      if (stepDef.estimatedDays) {
        dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + stepDef.estimatedDays);
      }

      await db.insert(projectSteps).values({
        id: stepId,
        projectId: newProject.id,
        name: stepDef.name,
        description: stepDef.description,
        status: 'pending',
        order: stepDef.order,
        startDate: null,
        endDate: dueDate,
        metadata: {
          estimatedDays: stepDef.estimatedDays,
          templateName: workflowTemplate.name,
          autoCreated: true,
          dependencies: stepDef.dependencies || []
        },
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    console.log('[Phoenix Webhook] Workflow steps created successfully');

    // === Log Phoenix Workflow Summary ===
    console.log('\n' + '='.repeat(60));
    console.log('[Phoenix Workflow Summary]');
    console.log(`Case: ${caseType}`);
    console.log(`Plan: ${invoice.planName}`);
    console.log(`Client ID: ${clientId}`);
    console.log(`Project ID: ${newProject.id}`);
    console.log(`Brief ID: ${newBrief.id}`);
    if (subscriptionId) {
      console.log(`Subscription ID: ${subscriptionId}`);
      console.log(`Trial: 30 days (recurring starts ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()})`);
    }
    console.log('='.repeat(60) + '\n');

    // TODO: Send email notification to client about onboarding
    console.log('[Phoenix Webhook] TODO: Send onboarding email to client:', clientId);
  } else {
    console.log('[Phoenix Webhook] This is a regular invoice payment (not onboarding)');
  }
}

// Handle expired checkout session
async function handleCheckoutSessionExpired(session: Stripe.Checkout.Session) {
  console.log('[Webhook] Processing checkout.session.expired:', session.id);

  const checkoutSessionId = session.id;

  // Find the invoice
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripeCheckoutSessionId, checkoutSessionId))
    .limit(1);

  if (!invoice) {
    console.log('[Webhook] Invoice not found for expired session:', checkoutSessionId);
    return;
  }

  // Update invoice status to cancelled
  await db
    .update(invoices)
    .set({
      status: 'cancelled',
      updatedAt: new Date()
    })
    .where(eq(invoices.id, invoice.id));

  console.log('[Webhook] Invoice marked as cancelled:', invoice.id);
}

// Handle payment failure
async function handlePaymentFailed(paymentIntent: Stripe.PaymentIntent) {
  console.log('[Webhook] Processing payment_intent.payment_failed:', paymentIntent.id);

  // Find invoice by payment intent ID
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripePaymentIntentId, paymentIntent.id))
    .limit(1);

  if (!invoice) {
    console.log('[Webhook] Invoice not found for payment intent:', paymentIntent.id);
    return;
  }

  // Update invoice status to failed
  await db
    .update(invoices)
    .set({
      status: 'failed',
      updatedAt: new Date()
    })
    .where(eq(invoices.id, invoice.id));

  console.log('[Webhook] Invoice marked as failed:', invoice.id);

  // TODO: Send email notification to client and admin
}

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({
    error: 'Internal server error',
    message: config.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Start server
app.listen(config.PORT, () => {
  console.log('='.repeat(50));
  console.log(`Capturit Payment Service`);
  console.log(`Environment: ${config.NODE_ENV}`);
  console.log(`Port: ${config.PORT}`);
  console.log(`Database: Connected`);
  console.log(`Stripe: Initialized`);
  console.log('='.repeat(50));
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully...');
  process.exit(0);
});