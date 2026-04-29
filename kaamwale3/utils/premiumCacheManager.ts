import { API_BASE } from './config';

const CACHE_TTL = 2 * 60 * 1000;

interface CachedPremiumStatus {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class PremiumCacheManager {
  private cache: CachedPremiumStatus | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    return Date.now() - this.cache.timestamp < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      return this.cache!.data;
    }
    return null;
  }

  getCachedStale(): any | null {
    return this.cache?.data || null;
  }

  setCache(data: any): void {
    this.cache = {
      data,
      timestamp: Date.now(),
      isValid: true,
    };
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('Premium cache invalidated');
  }

  clear(): void {
    this.cache = null;
    console.log('Premium cache cleared');
  }

  async fetchFresh(accessToken: string | null): Promise<any> {
    if (!accessToken) {
      console.warn('No access token for premium status check');
      return null;
    }

    if (this.isFetching && this.fetchPromise) {
      console.log('Reusing in-flight premium status request');
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/premium/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('Premium status check failed:', response.status);
          return null;
        }

        const data = await response.json();
        if (data.success) {
          this.setCache(data);
          console.log('Fresh premium status fetched');
          return data;
        }

        return null;
      } catch (err) {
        console.error('Premium status fetch error:', err);
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

    console.log('Premium cache invalid/expired, fetching fresh data...');
    const fresh = await this.fetchFresh(accessToken);
    if (fresh) {
      return fresh;
    }

    const stale = this.getCachedStale();
    if (stale) {
      console.log('Using stale premium status cache after fetch failure');
      return stale;
    }

    return null;
  }

  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

export const premiumCacheManager = new PremiumCacheManager();
