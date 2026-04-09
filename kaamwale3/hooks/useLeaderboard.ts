/**
 * 🏆 useLeaderboard Hook
 * 
 * Smart hook to fetch and monitor leaderboard rankings.
 * Listens to leaderboardUpdated socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { leaderboardCacheManager } from '../utils/leaderboardCacheManager';
import { socket } from '../utils/socket';

interface UseLeaderboardReturn {
  leaderboard: any[];
  userRank: number | null;
  userPoints: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useLeaderboard = (): UseLeaderboardReturn => {
  const { accessToken, user } = useAuth();
  const [leaderboard, setLeaderboard] = useState<any[]>([]);
  const [userRank, setUserRank] = useState<number | null>(null);
  const [userPoints, setUserPoints] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLeaderboard = async () => {
    if (!accessToken) {
      console.warn('⚠️ useLeaderboard: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await leaderboardCacheManager.getStatus(accessToken);
      if (data?.success) {
        setLeaderboard(data.leaderboard || []);
        setUserRank(data.userRank || null);
        setUserPoints(data.userPoints || null);
        console.log(`✅ Leaderboard loaded - Rank: ${data.userRank}, Points: ${data.userPoints}`);
      } else {
        setError('Failed to load leaderboard');
      }
    } catch (err) {
      console.error('❌ Leaderboard fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useLeaderboard: Screen focused, fetching rankings');
      fetchLeaderboard();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleLeaderboardUpdate = (data: any) => {
      console.log('📡 leaderboardUpdated event received:', data);
      leaderboardCacheManager.invalidate();
      
      if (data.userRank) setUserRank(data.userRank);
      if (data.userPoints) setUserPoints(data.userPoints);
      if (data.leaderboard) setLeaderboard(data.leaderboard);
    };

    socket.on('leaderboardUpdated', handleLeaderboardUpdate);
    return () => {
      socket.off('leaderboardUpdated', handleLeaderboardUpdate);
    };
  }, []);

  const refresh = async () => {
    console.log('🔄 Manual leaderboard refresh requested');
    leaderboardCacheManager.invalidate();
    await fetchLeaderboard();
  };

  return { leaderboard, userRank, userPoints, loading, error, refresh };
};
