/**
 * Session Routes
 * Auto-login endpoint for post-payment authentication
 */

import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import {
  eq,
  invoices,
  refreshTokens,
  generateAccessToken,
  generateRefreshToken,
  users,
  type UserRole,
  DbClient,
} from '@capturit/shared';
import type { PendingAuthToken } from '../types/webhook.types';

export function createSessionRoutes(
  db: DbClient,
  pendingAuthTokens: Map<string, PendingAuthToken>
): Router {
  const router = Router();

  /**
   * GET /auth/session/:sessionId
   * Exchange checkout session ID for auth tokens after successful payment
   */
  router.get('/:sessionId', async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    console.log('[Auto-Login] Checking session:', sessionId);

    // First, check if we have tokens in memory (fastest path)
    const authData = pendingAuthTokens.get(sessionId);

    if (authData) {
      // Check if tokens are still valid (10 minute window)
      const now = Date.now();
      const tokenAge = now - authData.createdAt.getTime();

      if (tokenAge > 10 * 60 * 1000) {
        pendingAuthTokens.delete(sessionId);
        // Fall through to database lookup
      } else {
        // Return tokens but keep them for 2 minutes to allow retries
        // Only delete after 2 minutes to handle client-side storage failures
        if (tokenAge > 2 * 60 * 1000) {
          pendingAuthTokens.delete(sessionId);
        }

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

  return router;
}
