/**
 * 💰 Wallet Cache Manager
 * 
 * Prevents excessive API calls while keeping wallet balance fresh.
 * Uses time-based caching + event-based invalidation.
 */

import { API_BASE } from './config';

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
    if (!accessToken) {
      console.warn('⚠️ No access token for wallet balance check');
      return null;
    }

    if (this.isFetching && this.fetchPromise) {
      console.log('📡 Reusing in-flight wallet request');
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/wallet/balance`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Wallet balance fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        if (data.success) {
          this.setCache(data);
          console.log('✅ Fresh wallet balance fetched');
          return data;
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

  async getStatus(accessToken: string | null): Promise<any> {
    const cached = this.getCached();
    if (cached) {
      return cached;
    }

    console.log('📡 Wallet cache invalid/expired, fetching fresh data...');
    return this.fetchFresh(accessToken);
  }

  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

export const walletCacheManager = new WalletCacheManager();
