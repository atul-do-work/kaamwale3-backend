import AsyncStorage from '@react-native-async-storage/async-storage';
import { SERVER_URL } from '../utils/config';
import { tokenManager } from './tokenManager';

interface SyncResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  fromCache?: boolean;
}

class StateSyncService {
  private cache = new Map<string, { data: any; timestamp: number; ttl: number }>();
  private readonly DEFAULT_TTL = 5 * 60 * 1000; // 5 minutes

  async syncWithBackend<T = any>(
    endpoint: string,
    cacheKey?: string,
    ttl: number = this.DEFAULT_TTL
  ): Promise<SyncResult<T>> {
    try {
      // ✅ Check cache first
      if (cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < cached.ttl) {
          console.log('📋 Using cached data for:', cacheKey);
          return { success: true, data: cached.data, fromCache: true };
        }
      }

      // ✅ Get fresh token
      const tokenResult = await tokenManager.refreshAccessToken();
      if (!tokenResult.success || !tokenResult.accessToken) {
        // ✅ Fallback to cache if available
        if (cacheKey) {
          const cached = this.cache.get(cacheKey);
          if (cached) {
            console.warn('⚠️ Token refresh failed, using stale cache for:', cacheKey);
            return { success: true, data: cached.data, fromCache: true };
          }
        }
        return { success: false, error: 'Token refresh failed' };
      }

      console.log('🔄 Syncing with backend:', endpoint);

      const response = await fetch(`${SERVER_URL}${endpoint}`, {
        headers: {
          'Authorization': `Bearer ${tokenResult.accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Sync failed: ${response.status}`);
      }

      const data = await response.json();

      // ✅ Cache successful response
      if (cacheKey && data) {
        this.cache.set(cacheKey, {
          data,
          timestamp: Date.now(),
          ttl,
        });
      }

      console.log('✅ Backend sync successful');
      return { success: true, data };

    } catch (error) {
      console.error('❌ State sync error:', error);

      // ✅ Fallback to cache on network errors
      if (cacheKey) {
        const cached = this.cache.get(cacheKey);
        if (cached) {
          console.warn('⚠️ Network error, using cache for:', cacheKey);
          return { success: true, data: cached.data, fromCache: true };
        }
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async syncJobState(jobId: string): Promise<SyncResult> {
    return this.syncWithBackend(`/jobs/by-id/${jobId}`, `job_${jobId}`, 2 * 60 * 1000); // 2 min TTL
  }

  async syncUserProfile(): Promise<SyncResult> {
    return this.syncWithBackend('/users/profile', 'user_profile', 10 * 60 * 1000); // 10 min TTL
  }

  async syncWalletBalance(): Promise<SyncResult> {
    return this.syncWithBackend('/wallet/balance', 'wallet_balance', 1 * 60 * 1000); // 1 min TTL
  }

  clearCache(key?: string): void {
    if (key) {
      this.cache.delete(key);
    } else {
      this.cache.clear();
    }
  }

  getCacheSize(): number {
    return this.cache.size;
  }
}

export const stateSyncService = new StateSyncService();