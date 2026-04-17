/**
 * 💳 useWalletBalance Hook
 * 
 * Smart hook for screens to check and refresh wallet balance.
 * Uses intelligent caching with socket event listening.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { walletCacheManager } from '../utils/walletCacheManager';
import { socket } from '../utils/socket';

interface UseWalletBalanceReturn {
  balance: number | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useWalletBalance = (): UseWalletBalanceReturn => {
  const { accessToken } = useAuth();
  const [balance, setBalance] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = async () => {
    if (!accessToken) {
      console.warn('⚠️ useWalletBalance: No access token');
      setBalance(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await walletCacheManager.getStatus(accessToken);
      if (data?.success) {
        const resolvedBalance = data.balance ?? data.amount ?? data.pocketBalance ?? 0;
        setBalance(resolvedBalance);
        console.log(`✅ Wallet balance loaded: ${resolvedBalance}`);
      } else {
        setError('Failed to load wallet balance');
      }
    } catch (err) {
      console.error('❌ Wallet balance fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useWalletBalance: Screen focused, fetching balance');
      fetchBalance();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleWalletUpdate = (data: any) => {
      console.log('📡 walletUpdated event received:', data);
      walletCacheManager.invalidate();
      setBalance(data.balance ?? data.amount ?? data.pocketBalance ?? null);
    };

    socket.on('walletUpdated', handleWalletUpdate);
    return () => {
      socket.off('walletUpdated', handleWalletUpdate);
    };
  }, []);

  const refresh = async () => {
    console.log('🔄 Manual wallet balance refresh requested');
    walletCacheManager.invalidate();
    await fetchBalance();
  };

  return { balance, loading, error, refresh };
};
