import { getBackendConfig, getFrontendConfig, DEFAULT_PORTS } from '@capturit/shared';

const backendConfig = getBackendConfig();
const frontendConfig = getFrontendConfig();
const isProduction = process.env.NODE_ENV === 'production';

// In production, INTERNAL_SECRET must be set via environment variable
const internalSecret = process.env.INTERNAL_SECRET ||
  (isProduction ? undefined : 'dev-internal-secret-change-in-production');

if (isProduction && !internalSecret) {
  throw new Error('INTERNAL_SECRET is required in production');
}

export const config = {
  PORT: parseInt(process.env.PORT || String(DEFAULT_PORTS.PAYMENT_SERVICE), 10),
  NODE_ENV: process.env.NODE_ENV || 'development',
  DATABASE_URL: process.env.DATABASE_URL || backendConfig.DATABASE_URL,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY!,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET!,
  CORS_ORIGIN: (process.env.CORS_ORIGIN || frontendConfig.CLIENT_FRONT_URL).split(','),
  AUTH_SERVICE_URL: process.env.AUTH_SERVICE_URL || backendConfig.AUTH_SERVICE_URL,
  CLIENT_FRONTEND_URL: process.env.CLIENT_FRONTEND_URL || frontendConfig.CLIENT_FRONT_URL,
  PROJECT_SERVICE_URL: process.env.PROJECT_SERVICE_URL || backendConfig.PROJECT_SERVICE_URL,
  INTERNAL_SECRET: internalSecret as string,
};
