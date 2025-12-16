import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';

/**
 * Rate Limiter Middleware for Payment Service
 * Protects checkout endpoints from abuse
 */

const isRateLimitEnabled = process.env.RATE_LIMIT_ENABLED !== 'false';
const isDev = process.env.NODE_ENV === 'development';

/**
 * Checkout Session Rate Limiter
 * - 5 attempts per 15 minutes per IP
 * - Prevents checkout session spam
 */
export const checkoutSessionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  validate: false,
  message: {
    success: false,
    error: 'Trop de tentatives de paiement. Reessayez dans 15 minutes.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const email = req.body?.email || 'unknown';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return `checkout_session_${email}_${ip}`;
  },
  skip: () => {
    if (!isRateLimitEnabled) return true;
    if (isDev && process.env.DISABLE_RATE_LIMIT === 'true') return true;
    return false;
  },
  handler: (req: Request, res: Response) => {
    console.warn(`[RATE LIMIT] Checkout session blocked for ${req.body?.email || 'unknown'} from ${req.ip}`);
    res.status(429).json({
      success: false,
      error: 'Trop de tentatives de paiement. Reessayez dans 15 minutes.',
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }
});

/**
 * Storage Checkout Rate Limiter
 * - 10 attempts per hour per clientId
 * - Prevents storage addon spam
 */
export const storageCheckoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 attempts
  validate: false,
  message: {
    success: false,
    error: 'Trop de tentatives d\'achat de stockage. Reessayez dans 1 heure.',
    code: 'RATE_LIMIT_EXCEEDED'
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request) => {
    const clientId = req.body?.clientId || 'unknown';
    return `storage_checkout_${clientId}`;
  },
  skip: () => {
    if (!isRateLimitEnabled) return true;
    if (isDev && process.env.DISABLE_RATE_LIMIT === 'true') return true;
    return false;
  },
  handler: (req: Request, res: Response) => {
    console.warn(`[RATE LIMIT] Storage checkout blocked for client ${req.body?.clientId || 'unknown'}`);
    res.status(429).json({
      success: false,
      error: 'Trop de tentatives d\'achat de stockage. Reessayez dans 1 heure.',
      code: 'RATE_LIMIT_EXCEEDED'
    });
  }
});
