/**
 * Event Deduplication Service
 * Prevents duplicate processing of Stripe webhook events
 *
 * Stripe may send the same event multiple times (at-least-once delivery).
 * This service ensures each event is only processed once.
 *
 * In production, this should be replaced with Redis or a database table
 * for persistence across service restarts.
 */

interface ProcessedEvent {
  eventId: string;
  eventType: string;
  processedAt: Date;
}

export class EventDeduplicationService {
  // In-memory store for processed events
  // NOTE: In production, use Redis or a database table for persistence
  private processedEvents: Map<string, ProcessedEvent> = new Map();

  // Event TTL in milliseconds (default: 24 hours)
  // Events older than this will be removed from the cache
  private readonly EVENT_TTL_MS = 24 * 60 * 60 * 1000;

  // Maximum cache size to prevent memory issues
  private readonly MAX_CACHE_SIZE = 10000;

  // Cleanup interval (every hour)
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Check if an event has already been processed
   * Returns true if the event is a duplicate
   */
  isDuplicate(eventId: string): boolean {
    const existing = this.processedEvents.get(eventId);
    if (!existing) {
      return false;
    }

    // Check if the event is still within TTL
    const now = Date.now();
    const eventAge = now - existing.processedAt.getTime();

    if (eventAge > this.EVENT_TTL_MS) {
      // Event has expired, remove it and allow reprocessing
      this.processedEvents.delete(eventId);
      return false;
    }

    return true;
  }

  /**
   * Mark an event as processed
   * Should be called AFTER successful processing
   */
  markAsProcessed(eventId: string, eventType: string): void {
    // Enforce cache size limit
    if (this.processedEvents.size >= this.MAX_CACHE_SIZE) {
      this.removeOldestEvents(Math.floor(this.MAX_CACHE_SIZE * 0.1)); // Remove 10%
    }

    this.processedEvents.set(eventId, {
      eventId,
      eventType,
      processedAt: new Date(),
    });
  }

  /**
   * Check if event is duplicate and mark as processing in one atomic operation
   * Returns true if the event should be processed (not a duplicate)
   * Returns false if the event is a duplicate and should be skipped
   */
  tryAcquire(eventId: string, eventType: string): boolean {
    if (this.isDuplicate(eventId)) {
      console.log(`[Dedup] Duplicate event detected: ${eventId} (${eventType})`);
      return false;
    }

    // Mark as processed immediately to prevent race conditions
    // If processing fails, the TTL will eventually allow reprocessing
    this.markAsProcessed(eventId, eventType);
    return true;
  }

  /**
   * Remove an event from the processed list
   * Useful when processing fails and retry is needed
   */
  release(eventId: string): void {
    this.processedEvents.delete(eventId);
  }

  /**
   * Get statistics about the deduplication cache
   */
  getStats(): { size: number; maxSize: number; ttlHours: number } {
    return {
      size: this.processedEvents.size,
      maxSize: this.MAX_CACHE_SIZE,
      ttlHours: this.EVENT_TTL_MS / (60 * 60 * 1000),
    };
  }

  /**
   * Remove oldest events to free up space
   */
  private removeOldestEvents(count: number): void {
    const events = Array.from(this.processedEvents.entries())
      .sort((a, b) => a[1].processedAt.getTime() - b[1].processedAt.getTime())
      .slice(0, count);

    for (const [eventId] of events) {
      this.processedEvents.delete(eventId);
    }

    console.log(`[Dedup] Removed ${events.length} old events from cache`);
  }

  /**
   * Clean up expired events
   */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;

    for (const [eventId, event] of this.processedEvents.entries()) {
      const eventAge = now - event.processedAt.getTime();
      if (eventAge > this.EVENT_TTL_MS) {
        this.processedEvents.delete(eventId);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[Dedup] Cleanup removed ${removed} expired events`);
    }
  }

  /**
   * Start the periodic cleanup timer
   */
  private startCleanupTimer(): void {
    // Cleanup every hour
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60 * 60 * 1000);

    // Unref to prevent timer from keeping process alive
    this.cleanupInterval.unref();
  }

  /**
   * Stop the cleanup timer (for graceful shutdown)
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}

// Singleton instance
export const eventDeduplicationService = new EventDeduplicationService();