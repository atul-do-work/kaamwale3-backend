/**
 * 🎣 usePremiumStatus Hook
 * 
 * Smart hook for screens to check and refresh premium status.
 * 
 * Uses intelligent caching:
 * - Returns cached data immediately if fresh
 * - Fetches from API only if cache expired
 * - Deduplicates multiple concurrent requests
 * 
 * NO database overload because:
 * - Cache TTL: 10 minutes
 * - Event-based invalidation instead of on every screen switch
 * - Socket updates trigger refresh automatically
 * 
 * Usage in screens:
 * ```
 * const { hasPremium, loading, premiumPlan } = usePremiumStatus();
 * ```
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { premiumCacheManager } from '../utils/premiumCacheManager';

interface UsePremiumStatusReturn {
  hasPremium: boolean;
  loading: boolean;
  premiumPlan: any;
  refresh: () => Promise<void>;
}

export const usePremiumStatus = (): UsePremiumStatusReturn => {
  const { accessToken, user } = useAuth();
  const [hasPremium, setHasPremium] = useState(false);
  const [loading, setLoading] = useState(false);
  const [premiumPlan, setPremiumPlan] = useState(null);

  /**
   * Fetch premium status using cache manager
   * Will use cache if valid, else fetch fresh
   */
  const fetchStatus = async () => {
    if (!accessToken) {
      console.warn('⚠️ usePremiumStatus: No access token');
      setHasPremium(false);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const status = await premiumCacheManager.getStatus(accessToken);
      
      if (status?.success) {
        const isActive = Boolean(status.isActive);
        const plan = status.premiumPlan || status.user?.premiumPlan;
        
        setHasPremium(isActive);
        setPremiumPlan(plan);
        
        console.log(`✅ Premium status loaded - Has Premium: ${isActive}`);
      } else {
        // If status check failed, fall back to user object data
        const userPlan = user?.premiumPlan;
        setHasPremium(userPlan?.type && userPlan.type !== 'free' ? true : false);
        setPremiumPlan(userPlan);
        console.log('⚠️ Could not validate premium status, using cached user data');
      }
    } catch (err) {
      console.error('❌ Premium status fetch error:', err);
      // Fallback to user data on error
      const userPlan = user?.premiumPlan;
      setHasPremium(userPlan?.type && userPlan.type !== 'free' ? true : false);
      setPremiumPlan(userPlan);
    } finally {
      setLoading(false);
    }
  };

  /**
   * On screen focus: Fetch status (uses cache if valid)
   * This ensures data is fresh when user navigates back to screen
   * But with caching, it doesn't hammer the API on every visit
   */
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 usePremiumStatus: Screen focused, fetching premium status (will use cache if valid)');
      fetchStatus();
    }, [accessToken])
  );

  /**
   * Allow manual refresh (called from UI when needed)
   */
  const refresh = async () => {
    console.log('🔄 Manual premium status refresh requested');
    premiumCacheManager.invalidate(); // Invalidate cache to force fresh fetch
    await fetchStatus();
  };

  return { hasPremium, loading, premiumPlan, refresh };
};
