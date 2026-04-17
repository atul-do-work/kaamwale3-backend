/**
 * 🟢 Worker Availability Cache Manager
 * 
 * Tracks online/offline status.
 * 2-minute TTL for real-time accuracy.
 * Invalidated by workerStatusUpdate socket events.
 */

import { API_BASE } from './config';

const CACHE_TTL = 2 * 60 * 1000; // 2 minutes (real-time)

interface CachedAvailability {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class AvailabilityCacheManager {
  private cache: CachedAvailability | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached availability status');
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
    console.log('💾 Availability status cached');
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Availability cache invalidated (socket event)');
  }

  clear(): void {
    this.cache = null;
  }

  async fetchFresh(accessToken: string | null): Promise<any> {
    if (!accessToken) return null;

    if (this.isFetching && this.fetchPromise) {
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        const response = await fetch(`${API_BASE}/worker/profile`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Availability fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        this.setCache(data);
        console.log('✅ Fresh availability status fetched');
        return data;
      } catch (err) {
        console.error('❌ Availability fetch error:', err);
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
    if (cached) return cached;

    console.log('📡 Availability cache expired, fetching fresh...');
    return this.fetchFresh(accessToken);
  }

  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

export const availabilityCacheManager = new AvailabilityCacheManager();
