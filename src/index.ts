import express, { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import helmet from 'helmet';
import cors from 'cors';
import dotenv from 'dotenv';
import { createDbClient, projects, invoices, briefs, projectSteps } from '@capturit/shared';
import { eq } from 'drizzle-orm';

// Load environment variables
dotenv.config();

// Configuration
const config = {
  PORT: parseInt(process.env.PORT || '4005', 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL!,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
  CORS_ORIGIN: (process.env.CORS_ORIGIN || 'http://localhost:3004').split(',')
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

// Helper function to get default project steps based on plan type
function getDefaultStepsForPlan(planId: string): Array<{ name: string; order: number; description: string }> {
  // Normalize plan ID to lowercase for matching
  const normalizedPlanId = planId.toLowerCase();

  // Video/Film production plans
  if (normalizedPlanId.includes('video') || normalizedPlanId.includes('film') || normalizedPlanId.includes('clip')) {
    return [
      { name: 'Pre-production', order: 1, description: 'Script writing, storyboarding, and planning' },
      { name: 'Filming', order: 2, description: 'On-location shooting and capture' },
      { name: 'Post-production', order: 3, description: 'Editing, color grading, and sound design' },
      { name: 'Review & Revisions', order: 4, description: 'Client feedback and adjustments' },
      { name: 'Final Delivery', order: 5, description: 'Export and delivery of final files' }
    ];
  }

  // Web development plans
  if (normalizedPlanId.includes('web') || normalizedPlanId.includes('site') || normalizedPlanId.includes('website')) {
    return [
      { name: 'Design', order: 1, description: 'UI/UX design and mockups' },
      { name: 'Development', order: 2, description: 'Frontend and backend implementation' },
      { name: 'QA Testing', order: 3, description: 'Quality assurance and bug fixing' },
      { name: 'Review & Revisions', order: 4, description: 'Client feedback and adjustments' },
      { name: 'Deployment', order: 5, description: 'Launch and go-live' }
    ];
  }

  // Photography plans
  if (normalizedPlanId.includes('photo') || normalizedPlanId.includes('photography')) {
    return [
      { name: 'Planning', order: 1, description: 'Location scouting and shot list preparation' },
      { name: 'Photo Shoot', order: 2, description: 'On-location photography session' },
      { name: 'Selection', order: 3, description: 'Image selection and curation' },
      { name: 'Retouching', order: 4, description: 'Professional photo editing and enhancement' },
      { name: 'Final Delivery', order: 5, description: 'Export and delivery of final images' }
    ];
  }

  // Branding/Design plans
  if (normalizedPlanId.includes('brand') || normalizedPlanId.includes('logo') || normalizedPlanId.includes('design')) {
    return [
      { name: 'Discovery', order: 1, description: 'Brand research and strategy development' },
      { name: 'Concepts', order: 2, description: 'Initial design concepts and iterations' },
      { name: 'Refinement', order: 3, description: 'Design refinement based on feedback' },
      { name: 'Finalization', order: 4, description: 'Final designs and brand guidelines' },
      { name: 'Delivery', order: 5, description: 'Export all assets and documentation' }
    ];
  }

  // Default/Generic production steps (fallback for any plan type)
  return [
    { name: 'Planning', order: 1, description: 'Project planning and requirements gathering' },
    { name: 'Production', order: 2, description: 'Main production work' },
    { name: 'Review', order: 3, description: 'Client review and feedback' },
    { name: 'Finalization', order: 4, description: 'Final adjustments and polish' },
    { name: 'Delivery', order: 5, description: 'Final delivery to client' }
  ];
}

// Handle successful checkout
async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
  console.log('[Webhook] Processing checkout.session.completed:', session.id);

  const checkoutSessionId = session.id;
  const paymentIntentId = session.payment_intent as string;
  const clientEmail = session.customer_email || session.customer_details?.email;

  // Find the invoice by checkout session ID
  const [invoice] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.stripeCheckoutSessionId, checkoutSessionId))
    .limit(1);

  if (!invoice) {
    console.error('[Webhook] Invoice not found for session:', checkoutSessionId);
    return;
  }

  console.log('[Webhook] Found invoice:', invoice.id);

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

  console.log('[Webhook] Invoice marked as paid:', updatedInvoice.id);

  // Check if this invoice is for a plan (onboarding payment)
  if (invoice.planId && invoice.planName) {
    console.log('[Webhook] This is an onboarding payment for plan:', invoice.planName);

    // Create a new project with status 'onboarding_pending'
    const [newProject] = await db
      .insert(projects)
      .values({
        clientId: invoice.clientId,
        title: `${invoice.planName} - Onboarding`,
        description: `Project created from ${invoice.planName} plan purchase. Awaiting onboarding questionnaire completion.`,
        status: 'onboarding_pending',
        budget: invoice.amount,
        metadata: {
          planId: invoice.planId,
          planName: invoice.planName,
          invoiceId: invoice.id,
          createdVia: 'stripe_payment'
        },
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    console.log('[Webhook] Project created:', newProject.id);

    // Link invoice to project
    await db
      .update(invoices)
      .set({
        projectId: newProject.id,
        updatedAt: new Date()
      })
      .where(eq(invoices.id, invoice.id));

    console.log('[Webhook] Invoice linked to project');

    // Create an empty brief for the project
    const [newBrief] = await db
      .insert(briefs)
      .values({
        projectId: newProject.id,
        clientId: invoice.clientId,
        status: 'pending',
        content: [], // Empty array - to be filled by client
        createdAt: new Date(),
        updatedAt: new Date()
      })
      .returning();

    console.log('[Webhook] Brief created:', newBrief.id);

    // Create default project steps based on plan type
    const defaultSteps = getDefaultStepsForPlan(invoice.planId);
    console.log(`[Webhook] Creating ${defaultSteps.length} default steps for plan:`, invoice.planId);

    for (const step of defaultSteps) {
      await db.insert(projectSteps).values({
        projectId: newProject.id,
        name: step.name,
        order: step.order,
        description: step.description,
        status: 'pending',
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    console.log('[Webhook] Project steps created successfully');

    // TODO: Send email notification to client about onboarding
    console.log('[Webhook] TODO: Send email to client:', clientEmail);
  } else {
    console.log('[Webhook] This is a regular invoice payment (not onboarding)');
  }

  console.log('[Webhook] Checkout session completed successfully');
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