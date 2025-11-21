# Capturit Payment Service

Standalone Stripe webhook handler for processing payments and managing onboarding workflows.

## Overview

This microservice handles Stripe webhook events to:
- Process successful payments and update invoice statuses
- Automatically create projects when clients purchase plans
- Initialize onboarding questionnaires (briefs) for new projects
- Handle payment failures and checkout session expirations

## Architecture

- **Framework**: Express.js + TypeScript
- **Payment Processing**: Stripe Webhooks
- **Database**: PostgreSQL via `@capturit/shared`
- **Port**: 4005

## Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL database (shared with other Capturit services)
- Stripe account with webhook configuration

## Environment Setup

Create `.env` file:

```bash
# Server
NODE_ENV=development
PORT=4005

# Database (shared with other services)
DATABASE_URL=postgresql://capturit:password@localhost:5432/capturit

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# CORS
CORS_ORIGIN=http://localhost:3004,http://localhost:3001
```

## Installation

```bash
# Install dependencies
pnpm install

# Link shared package (development)
cd ../capturit-shared && pnpm link
cd ../capturit-payment-service && pnpm link @capturit/shared
```

## Development

```bash
# Run in development mode with hot reload
pnpm run dev
```

## Production Build

```bash
# Build TypeScript
pnpm run build

# Start production server
pnpm start
```

## Docker Deployment

```bash
# Build image
docker build -t capturit-payment-service .

# Run container
docker run -d \
  -p 4005:4005 \
  --env-file .env \
  --name capturit-payment-service \
  capturit-payment-service
```

## Stripe Webhook Configuration

### 1. Create Webhook Endpoint in Stripe Dashboard

```
URL: https://your-domain.com/webhook
Events to send:
  - checkout.session.completed
  - checkout.session.expired
  - payment_intent.succeeded
  - payment_intent.payment_failed
```

### 2. Copy Webhook Signing Secret

Add the `whsec_...` secret to your `.env` file as `STRIPE_WEBHOOK_SECRET`.

### 3. Test Webhooks Locally

```bash
# Install Stripe CLI
brew install stripe/stripe-cli/stripe

# Login
stripe login

# Forward webhooks to local server
stripe listen --forward-to localhost:4005/webhook

# Trigger test events
stripe trigger checkout.session.completed
```

## API Endpoints

### Health Check
```bash
GET /health

Response:
{
  "status": "ok",
  "service": "capturit-payment-service",
  "timestamp": "2025-11-20T12:00:00.000Z"
}
```

### Webhook Handler
```bash
POST /webhook
Headers:
  - stripe-signature: <stripe signature>
Body: <raw stripe event json>
```

## Payment Flow

### 1. Client Registers with Plan

Client API creates:
- User account
- Invoice with `planId` and `planName`
- Stripe Checkout Session

### 2. Payment Completed

When `checkout.session.completed` webhook is received:

1. **Update Invoice**
   - Set status to `paid`
   - Add `stripePaymentIntentId`
   - Set `paidAt` timestamp

2. **Create Project** (if plan purchase)
   - Status: `onboarding_pending`
   - Title: `{Plan Name} - Onboarding`
   - Metadata: plan details

3. **Create Brief**
   - Empty content array
   - Status: `pending`
   - Linked to project and client

4. **Link Invoice to Project**

### 3. Client Completes Onboarding

Client fills out questionnaire via client portal → Brief status changes → Project moves to `pending` or `in_progress`.

## Database Schema

Uses shared schemas from `@capturit/shared`:

### Invoices
```typescript
{
  id: uuid
  clientId: uuid
  projectId: uuid | null
  amount: decimal
  status: 'draft' | 'pending' | 'paid' | 'failed' | 'cancelled'
  planId: string | null
  planName: string | null
  stripeCheckoutSessionId: string
  stripePaymentIntentId: string
  paidAt: timestamp
}
```

### Projects
```typescript
{
  id: uuid
  clientId: uuid
  title: string
  status: 'onboarding_pending' | 'pending' | 'in_progress' | 'completed'
  budget: decimal
  metadata: jsonb
}
```

### Briefs
```typescript
{
  id: uuid
  projectId: uuid
  clientId: uuid
  status: 'pending' | 'in_review' | 'approved'
  content: jsonb // Array of {question, answer}
  completedAt: timestamp
}
```

## Error Handling

- **Invalid Signature**: Returns 400 with error message
- **Event Processing Error**: Returns 500, logs error details
- **Database Errors**: Logged and returned as 500

## Logging

All webhook events are logged with:
- Event type
- Event ID
- Processing status
- Any errors

Example:
```
[Webhook] Received event: checkout.session.completed
[Webhook] Processing checkout.session.completed: cs_test_...
[Webhook] Found invoice: abc-123
[Webhook] Invoice marked as paid: abc-123
[Webhook] This is an onboarding payment for plan: Pro Plan
[Webhook] Project created: proj-456
[Webhook] Invoice linked to project
[Webhook] Brief created: brief-789
[Webhook] Checkout session completed successfully
```

## Security

- Helmet.js for security headers
- Stripe signature verification on all webhooks
- Raw body parsing for webhook signature validation
- CORS configured for specific origins
- Environment variable validation on startup

## Monitoring

- Health check endpoint at `/health`
- Logs all webhook events
- Docker healthcheck configured

## Future Enhancements

- [ ] Email notifications on payment success
- [ ] Admin notifications for new onboarding
- [ ] Retry logic for failed database operations
- [ ] Webhook event history/audit log
- [ ] Support for subscription payments
- [ ] Refund handling

## Support

For issues or questions, contact the Capturit development team.