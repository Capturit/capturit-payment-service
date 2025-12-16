/**
 * Capturit Payment Service
 * Main entry point - Express server setup with modular routes
 */

// Load environment variables FIRST
import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, NextFunction } from 'express';
import Stripe from 'stripe';
import helmet from 'helmet';
import cors from 'cors';
import {
  createDbClient,
  DEFAULT_PORTS,
  getBackendConfig,
  getFrontendConfig,
  getCorsOrigins,
} from '@capturit/shared';

// Services and Routes
import { CatalogService, WebhookService } from './services';
import { createCatalogRoutes, createWebhookRoutes, createSessionRoutes, createCheckoutRoutes } from './routes';
import type { PendingAuthToken } from './types/webhook.types';

// Get centralized configuration
const backendConfig = getBackendConfig();
const frontendConfig = getFrontendConfig();

// Configuration
const config = {
  PORT: parseInt(process.env.PORT || String(DEFAULT_PORTS.PAYMENT_SERVICE), 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || backendConfig.DATABASE_URL,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
  CORS_ORIGIN: getCorsOrigins(),
  PROJECT_SERVICE_URL: process.env.PROJECT_SERVICE_URL || backendConfig.PROJECT_SERVICE_URL,
  INTERNAL_SECRET: process.env.INTERNAL_SECRET || 'dev-internal-secret-change-in-production',
};

// Validate required env vars
if (!config.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!config.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
if (!config.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');

// Initialize core dependencies
const stripe = new Stripe(config.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
const db = createDbClient(config.DATABASE_URL);

// Temporary storage for auto-login tokens (in production, use Redis)
const pendingAuthTokens = new Map<string, PendingAuthToken>();

// Clean up expired tokens every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of pendingAuthTokens.entries()) {
    if (now - data.createdAt.getTime() > 10 * 60 * 1000) {
      pendingAuthTokens.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

// Initialize services
const catalogService = new CatalogService(db);
const webhookService = new WebhookService(stripe, db, {
  STRIPE_WEBHOOK_SECRET: config.STRIPE_WEBHOOK_SECRET,
  PROJECT_SERVICE_URL: config.PROJECT_SERVICE_URL,
  INTERNAL_SECRET: config.INTERNAL_SECRET,
}, pendingAuthTokens);

// Initialize Express app
const app = express();

// Security middleware
app.use(helmet({ crossOriginResourcePolicy: false }));

// CORS with callback for better origin handling
const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      return callback(null, true);
    }
    // Check if origin is in allowed list
    if (config.CORS_ORIGIN.includes(origin)) {
      return callback(null, true);
    }
    console.log('[CORS] Blocked origin:', origin, 'Allowed:', config.CORS_ORIGIN);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
};
app.use(cors(corsOptions));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'capturit-payment-service',
    timestamp: new Date().toISOString()
  });
});

// Routes - Order matters! JSON routes before raw body webhook
app.use('/catalog', express.json(), createCatalogRoutes(catalogService));
app.use('/checkout', express.json(), createCheckoutRoutes(stripe, db));
app.use('/auth/session', createSessionRoutes(db, pendingAuthTokens));
app.use('/webhook', createWebhookRoutes(webhookService));

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
  console.log('');
  console.log('Routes:');
  console.log('  GET  /health');
  console.log('  GET  /catalog');
  console.log('  GET  /catalog/web');
  console.log('  GET  /catalog/production');
  console.log('  GET  /catalog/alacarte');
  console.log('  GET  /catalog/:slug');
  console.log('  POST /checkout/session');
  console.log('  GET  /auth/session/:sessionId');
  console.log('  POST /webhook');
  console.log('');
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
