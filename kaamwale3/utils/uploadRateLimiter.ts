/**
 * Client-Side Rate Limiter for Uploads
 * Prevents abuse by limiting upload attempts per user
 */
import { RATE_LIMIT_CONFIG } from './uploadConfig';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface RateLimitEntry {
  timestamp: number;
  size?: number;
}

class UploadRateLimiter {
  private uploadHistory: RateLimitEntry[] = [];
  private storageKey = 'uploadRateLimitHistory';

  /**
   * Initialize rate limiter from storage
   */
  async initialize() {
    try {
      const stored = await AsyncStorage.getItem(this.storageKey);
      if (stored) {
        this.uploadHistory = JSON.parse(stored);
        this.cleanOldEntries();
      }
    } catch (error) {
      console.warn('Failed to load upload history:', error);
    }
  }

  /**
   * Check if upload is allowed and record attempt
   */
  async canUpload(): Promise<{ allowed: boolean; reason?: string }> {
    await this.initialize();
    this.cleanOldEntries();

    const now = Date.now();

    // Check minute limit
    const lastMinute = this.uploadHistory.filter(
      (entry) => now - entry.timestamp < RATE_LIMIT_CONFIG.WINDOW_MINUTE
    );

    if (lastMinute.length >= RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_MINUTE) {
      return {
        allowed: false,
        reason: `Too many uploads. Please wait before trying again (${lastMinute.length}/${RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_MINUTE} per minute)`,
      };
    }

    // Check hour limit
    const lastHour = this.uploadHistory.filter(
      (entry) => now - entry.timestamp < RATE_LIMIT_CONFIG.WINDOW_HOUR
    );

    if (lastHour.length >= RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_HOUR) {
      return {
        allowed: false,
        reason: `Too many uploads today. Please try again later (${lastHour.length}/${RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_HOUR} per hour)`,
      };
    }

    return { allowed: true };
  }

  /**
   * Record an upload attempt
   */
  async recordUpload(sizeInBytes?: number) {
    this.uploadHistory.push({
      timestamp: Date.now(),
      size: sizeInBytes,
    });

    await this.saveToStorage();
  }

  /**
   * Get upload stats
   */
  async getStats() {
    await this.initialize();
    this.cleanOldEntries();

    const now = Date.now();
    const lastMinute = this.uploadHistory.filter(
      (entry) => now - entry.timestamp < RATE_LIMIT_CONFIG.WINDOW_MINUTE
    );
    const lastHour = this.uploadHistory.filter(
      (entry) => now - entry.timestamp < RATE_LIMIT_CONFIG.WINDOW_HOUR
    );

    const totalSizeLastHour = lastHour.reduce((sum, entry) => sum + (entry.size || 0), 0);

    return {
      uploadsLastMinute: lastMinute.length,
      uploadsLastHour: lastHour.length,
      totalSizeLastHour,
      maxPerMinute: RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_MINUTE,
      maxPerHour: RATE_LIMIT_CONFIG.MAX_UPLOADS_PER_HOUR,
    };
  }

  /**
   * Clear all rate limit history
   */
  async reset() {
    this.uploadHistory = [];
    await AsyncStorage.removeItem(this.storageKey);
  }

  /**
   * Remove old entries outside of rate limit windows
   */
  private cleanOldEntries() {
    const now = Date.now();
    this.uploadHistory = this.uploadHistory.filter(
      (entry) => now - entry.timestamp < RATE_LIMIT_CONFIG.WINDOW_HOUR
    );
  }

  /**
   * Save history to storage
   */
  private async saveToStorage() {
    try {
      await AsyncStorage.setItem(
        this.storageKey,
        JSON.stringify(this.uploadHistory)
      );
    } catch (error) {
      console.warn('Failed to save upload history:', error);
    }
  }
}

export const uploadRateLimiter = new UploadRateLimiter();
