/**
 * 🟢 Worker Availability Cache Manager
 * 
 * Tracks online/offline status.
 * 2-minute TTL for real-time accuracy.
 * Invalidated by workerStatusUpdate socket events.
 */

import { API_BASE } from './config';
import api from './api';

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
    // Note: accessToken parameter kept for backward compatibility but not used
    // The api client will handle token management automatically

    if (this.isFetching && this.fetchPromise) {
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        // ✅ Use api client with automatic token refresh
        const response = await api.get('/worker/profile');

        if (response.data?.success) {
          this.setCache(response.data);
          console.log('✅ Fresh availability status fetched');
          return response.data;
        } else {
          console.error('❌ Availability fetch failed:', response.data?.message);
          return null;
        }
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

  async getStatus(): Promise<any> {
    const cached = this.getCached();
    if (cached) return cached;

    console.log('📡 Availability cache expired, fetching fresh...');
    return this.fetchFresh(null); // accessToken no longer needed
  }

  async forceFresh(): Promise<any> {
    this.invalidate();
    return this.fetchFresh(null); // accessToken no longer needed
  }
}

export const availabilityCacheManager = new AvailabilityCacheManager();
