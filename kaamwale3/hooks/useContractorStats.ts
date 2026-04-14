/**
 * 👤 useContractorStats Hook
 * 
 * Smart hook to fetch earnings, jobs completed, rating.
 * Listens to statsUpdated socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { statsCacheManager } from '../utils/statsCacheManager';
import { socket } from '../utils/socket';

interface UseContractorStatsReturn {
  earnings: number | null;
  jobsCompleted: number | null;
  rating: number | null;
  totalJobs: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useContractorStats = (): UseContractorStatsReturn => {
  const { accessToken } = useAuth();
  const [earnings, setEarnings] = useState<number | null>(null);
  const [jobsCompleted, setJobsCompleted] = useState<number | null>(null);
  const [rating, setRating] = useState<number | null>(null);
  const [totalJobs, setTotalJobs] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStats = async () => {
    if (!accessToken) {
      console.warn('⚠️ useContractorStats: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await statsCacheManager.getStatus(accessToken);
      if (data?.success) {
        const earningsValue =
          data?.aggregated?.totalSpending ??
          data?.totalSpending ??
          data?.earnings ??
          data?.totalEarnings ??
          0;
        const jobsCompletedValue =
          data?.aggregated?.totalJobsCompleted ??
          data?.jobsCompleted ??
          data?.completedJobs ??
          0;
        const totalJobsValue =
          data?.aggregated?.totalJobsPosted ??
          data?.totalJobs ??
          0;
        const ratingValue = data?.rating ?? data?.avgRating ?? 0;

        setEarnings(earningsValue);
        setJobsCompleted(jobsCompletedValue);
        setRating(ratingValue);
        setTotalJobs(totalJobsValue);

        console.log(`✅ Stats loaded - Earnings: ${earningsValue}, Completed: ${jobsCompletedValue}`);
      } else {
        setError('Failed to load stats');
      }
    } catch (err) {
      console.error('❌ Stats fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useContractorStats: Screen focused, fetching stats');
      fetchStats();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleStatsUpdate = (data: any) => {
      console.log('📡 statsUpdated event received:', data);
      statsCacheManager.invalidate();
      
      if (data.earnings !== undefined) setEarnings(data.earnings);
      if (data.jobsCompleted !== undefined) setJobsCompleted(data.jobsCompleted);
      if (data.rating !== undefined) setRating(data.rating);
      if (data.totalJobs !== undefined) setTotalJobs(data.totalJobs);

      if (data?.aggregated?.totalSpending !== undefined) setEarnings(data.aggregated.totalSpending);
      if (data?.aggregated?.totalJobsCompleted !== undefined) setJobsCompleted(data.aggregated.totalJobsCompleted);
      if (data?.aggregated?.totalJobsPosted !== undefined) setTotalJobs(data.aggregated.totalJobsPosted);
    };

    socket.on('statsUpdated', handleStatsUpdate);
    return () => {
      socket.off('statsUpdated', handleStatsUpdate);
    };
  }, []);

  const refresh = async () => {
    console.log('🔄 Manual stats refresh requested');
    statsCacheManager.invalidate();
    await fetchStats();
  };

  return { earnings, jobsCompleted, rating, totalJobs, loading, error, refresh };
};
