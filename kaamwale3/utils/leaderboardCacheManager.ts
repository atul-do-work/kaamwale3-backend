/**
 * 📊 Leaderboard Cache Manager
 * 
 * Caches leaderboard rankings with 3-5 minute TTL.
 * Invalidated by leaderboardUpdated socket events.
 */

import { API_BASE } from './config';

const CACHE_TTL = 3 * 60 * 1000; // 3 minutes (frequent updates)

interface CachedLeaderboard {
  data: any;
  timestamp: number;
  isValid: boolean;
}

class LeaderboardCacheManager {
  private cache: CachedLeaderboard | null = null;
  private isFetching = false;
  private fetchPromise: Promise<any> | null = null;

  private isCacheValid(): boolean {
    if (!this.cache || !this.cache.isValid) return false;
    const age = Date.now() - this.cache.timestamp;
    return age < CACHE_TTL;
  }

  getCached(): any | null {
    if (this.isCacheValid()) {
      console.log('✅ Using cached leaderboard');
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
    console.log('💾 Leaderboard cached');
  }

  invalidate(): void {
    if (this.cache) {
      this.cache.isValid = false;
    }
    console.log('🔄 Leaderboard cache invalidated (socket event)');
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
const response = await fetch(`${API_BASE}/leaderboard/my-city`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!response.ok) {
          console.error('❌ Leaderboard fetch failed:', response.status);
          return null;
        }

        const data = await response.json();
        this.setCache(data);
        console.log('✅ Fresh leaderboard fetched');
        return data;
      } catch (err) {
        console.error('❌ Leaderboard fetch error:', err);
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

    console.log('📡 Leaderboard cache expired, fetching fresh...');
    return this.fetchFresh(accessToken);
  }

  async forceFresh(accessToken: string | null): Promise<any> {
    this.invalidate();
    return this.fetchFresh(accessToken);
  }
}

export const leaderboardCacheManager = new LeaderboardCacheManager();
