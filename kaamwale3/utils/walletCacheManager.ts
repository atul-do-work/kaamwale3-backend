/**
 * 💰 Wallet Cache Manager
 * 
 * Prevents excessive API calls while keeping wallet balance fresh.
 * Uses time-based caching + event-based invalidation.
 */

import { API_BASE } from './config';
import api from './api';

const CACHE_KEY = 'wallet_balance_cache';
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

interface CachedWalletBalance {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class WalletCacheManager {
  private cache: CachedWalletBalance | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached wallet balance');
      return this.cache!.data;
    }
    return null;
  }

  setCache(data: any): void {
    this.cache = {
      data,
      timestamp: Date.now(),
      isValid: true,
    };
    console.log('💾 Wallet balance cached');
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Wallet cache invalidated (socket event received)');
  }

  clear(): void {
    this.cache = null;
    console.log('🗑️ Wallet cache cleared');
  }

  async fetchFresh(accessToken: string | null): Promise<any> {
    // Note: accessToken parameter kept for backward compatibility but not used
    // The api client will handle token management automatically

    if (this.isFetching && this.fetchPromise) {
      console.log('📡 Reusing in-flight wallet request');
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        // ✅ Use api client with automatic token refresh
        const response = await api.get('/wallet/balance');

        if (response.data?.success) {
          this.setCache(response.data);
          console.log('✅ Fresh wallet balance fetched');
          return response.data;
        }
        return null;
      } catch (err) {
        console.error('❌ Wallet balance fetch error:', err);
        return null;
      } finally {
        this.isFetching = false;
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  async getStatus(): Promise<any> {
    const cached = this.getCached();
    if (cached) {
      return cached;
    }

    console.log('📡 Wallet cache invalid/expired, fetching fresh data...');
    return this.fetchFresh(null); // accessToken no longer needed
  }

  async forceFresh(): Promise<any> {
    this.invalidate();
    return this.fetchFresh(null); // accessToken no longer needed
  }
}

export const walletCacheManager = new WalletCacheManager();
