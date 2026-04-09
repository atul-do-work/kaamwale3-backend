/**
 * 📋 Job Status Cache Manager
 * 
 * Prevents stale job status display.
 * Uses event-based invalidation on jobUpdated socket events.
 */

import { API_BASE } from './config';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedJobStatus {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class JobStatusCacheManager {
  private cache: CachedJobStatus | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached job status');
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
    console.log('💾 Job status cached');
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Job status cache invalidated (socket event)');
  }

  clear(): void {
    this.cache = null;
  }

  async fetchFresh(accessToken: string | null, jobId?: string): Promise<any> {
    if (!accessToken) return null;

    if (this.isFetching && this.fetchPromise) {
      return this.fetchPromise;
    }

    this.isFetching = true;
    this.fetchPromise = (async () => {
      try {
        const endpoint = jobId ? `${API_BASE}/jobs/${jobId}` : `${API_BASE}/jobs/list`;
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Job status fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        this.setCache(data);
        console.log('✅ Fresh job status fetched');
        return data;
      } catch (err) {
        console.error('❌ Job status fetch error:', err);
        return null;
      } finally {
        this.isFetching = false;
        this.fetchPromise = null;
      }
    })();

    return this.fetchPromise;
  }

  async getStatus(accessToken: string | null, jobId?: string): Promise<any> {
    const cached = this.getCached();
    if (cached) return cached;

    console.log('📡 Job status cache expired, fetching fresh...');
    return this.fetchFresh(accessToken, jobId);
  }

  async forceFresh(accessToken: string | null, jobId?: string): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken, jobId);
  }
}

export const jobStatusCacheManager = new JobStatusCacheManager();
