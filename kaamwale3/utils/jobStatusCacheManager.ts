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
  private cache = new Map<string, CachedJobStatus>();
  private fetchPromises = new Map<string, Promise<any>>();

  private buildCacheKey(jobId?: string): string {
    return jobId ? `job:${jobId}` : 'jobs:my-accepted';
  }

  private isCacheValid(key: string): boolean {
    const cached = this.cache.get(key);
    if (!cached || !cached.isValid) return false;
    const age = Date.now() - cached.timestamp;
    return age < CACHE_TTL;
  }

  getCached(jobId?: string): any | null {
    const key = this.buildCacheKey(jobId);
    if (this.isCacheValid(key)) {
      console.log('✅ Using cached job status', key);
      return this.cache.get(key)!.data;
    }
    return null;
  }

  setCache(data: any, jobId?: string): void {
    const key = this.buildCacheKey(jobId);
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      isValid: true,
    });
    console.log('💾 Job status cached', key);
  }

  invalidate(jobId?: string): void {
    if (jobId) {
      const key = this.buildCacheKey(jobId);
      const cached = this.cache.get(key);
      if (cached) cached.isValid = false;
    } else {
      this.cache.forEach((cached) => {
        cached.isValid = false;
      });
    }
    console.log('🔄 Job status cache invalidated (socket event)', jobId || 'all');
  }

  clear(jobId?: string): void {
    if (jobId) {
      this.cache.delete(this.buildCacheKey(jobId));
    } else {
      this.cache.clear();
    }
  }

  async fetchFresh(accessToken: string | null, jobId?: string): Promise<any> {
    if (!accessToken) return null;

    const key = this.buildCacheKey(jobId);
    const existingPromise = this.fetchPromises.get(key);
    if (existingPromise) {
      return existingPromise;
    }

    const promise = (async () => {
      try {
        const endpoint = jobId
          ? `${API_BASE}/jobs/by-id/${jobId}`
          : `${API_BASE}/jobs/my-accepted?limit=100`;
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Job status fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        this.setCache(data, jobId);
        console.log('✅ Fresh job status fetched', key);
        return data;
      } catch (err) {
        console.error('❌ Job status fetch error:', err);
        return null;
      } finally {
        this.fetchPromises.delete(key);
      }
    })();

    this.fetchPromises.set(key, promise);
    return promise;
  }

  async getStatus(accessToken: string | null, jobId?: string): Promise<any> {
    const cached = this.getCached(jobId);
    if (cached) return cached;

    console.log('📡 Job status cache expired, fetching fresh...', jobId || 'my-accepted');
    return this.fetchFresh(accessToken, jobId);
  }

  async forceFresh(accessToken: string | null, jobId?: string): Promise<any> {
    this.invalidate(jobId);
    return this.fetchFresh(accessToken, jobId);
  }
}

export const jobStatusCacheManager = new JobStatusCacheManager();
