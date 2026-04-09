/**
 * 🔔 Notification Cache Manager
 * 
 * Caches notification badge count.
 * Invalidated by notificationUpdate socket events.
 */

import { API_BASE } from './config';

const CACHE_TTL = 2 * 60 * 1000; // 2 minutes

interface CachedNotification {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class NotificationCacheManager {
  private cache: CachedNotification | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached notifications');
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
    console.log('💾 Notifications cached');
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Notification cache invalidated (socket event)');
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
        const response = await fetch(`${API_BASE}/notifications/unread-count`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Notifications fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        this.setCache(data);
        console.log('✅ Fresh notifications fetched');
        return data;
      } catch (err) {
        console.error('❌ Notifications fetch error:', err);
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

    console.log('📡 Notifications cache expired, fetching fresh...');
    return this.fetchFresh(accessToken);
  }

  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

export const notificationCacheManager = new NotificationCacheManager();
