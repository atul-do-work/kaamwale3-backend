/**
 * 🎯 Premium Cache Manager
 * 
 * Prevents excessive API calls while keeping data fresh.
 * Uses time-based caching + event-based invalidation.
 * 
 * Strategy:
 * - Cache premium status for 10 minutes
 * - Only refresh on app startup or when explicitly invalidated
 * - Socket events invalidate cache for real-time updates
 * - Screens use the cache, not direct API calls
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from './config';

const CACHE_KEY = 'premium_status_cache';
const CACHE_TTL = 2 * 60 * 1000; // ✅ FIXED: Reduced from 10 minutes to 2 minutes

interface CachedPremiumStatus {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class PremiumCacheManager {
  private cache: CachedPremiumStatus | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  /**
   * Check if cache is still valid
   */
  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  /**
   * Get cached data if valid, otherwise return null
   */
  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached premium status');
      return this.cache!.data;
    }
    return null;
  }

  /**
   * Set cache data (usually called after successful API fetch)
   */
  setCache(data: any): void {
    this.cache = {
      data,
      timestamp: Date.now(),
      isValid: true,
    };
    console.log('💾 Premium status cached');
  }

  /**
   * Invalidate cache (called when purchase happens or socket update received)
   */
  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Premium cache invalidated');
  }

  /**
   * Clear cache completely
   */
  clear(): void {
    this.cache = null;
    console.log('🗑️ Premium cache cleared');
  }

  /**
   * Fetch fresh premium status from API
   * Uses request deduplication for concurrent calls
   */
  async fetchFresh(accessToken: string | null): Promise<any> {
    if (!accessToken) {
      console.warn('⚠️ No access token for premium status check');
      return null;
    }

    // If already fetching, return existing promise (deduplicate)
    if (this.isFetching && this.fetchPromise) {
      console.log('📡 Reusing in-flight premium status request');
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/premium/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Premium status check failed:', response.status);
          return null;
        }

        const data = await response.json();
        if (data.success) {
          this.setCache(data);
          console.log('✅ Fresh premium status fetched');
          return data;
        }
        return null;
      } catch (err) {
        console.error('❌ Premium status fetch error:', err);
        return null;
      } finally {
        this.isFetching = false;
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  /**
   * Get premium status: use cache if valid, else fetch fresh
   * Minimal DB calls - smart caching!
   */
  async getStatus(accessToken: string | null): Promise<any> {
    // Step 1: Try cached data first
    const cached = this.getCached();
    if (cached) {
      return cached;
    }

    // Step 2: No valid cache, fetch fresh from API
    console.log('📡 Cache invalid/expired, fetching fresh data...');
    return this.fetchFresh(accessToken);
  }

  /**
   * Force fresh fetch (called on app startup)
   */
  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

// Export singleton instance
export const premiumCacheManager = new PremiumCacheManager();
