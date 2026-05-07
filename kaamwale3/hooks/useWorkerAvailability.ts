/**
 * 🟢 useWorkerAvailability Hook
 * 
 * Smart hook to check and toggle online/offline status.
 * Listens to workerStatusUpdate socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { availabilityCacheManager } from '../utils/availabilityCacheManager';
import { socket } from '../utils/socket';
import api from '../utils/api';

interface UseWorkerAvailabilityReturn {
  isOnline: boolean;
  loading: boolean;
  error: string | null;
  toggleAvailability: (status: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

export const useWorkerAvailability = (): UseWorkerAvailabilityReturn => {
  const { accessToken } = useAuth();
  const [isOnline, setIsOnline] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAvailability = async () => {
    if (!accessToken) {
      console.warn('⚠️ useWorkerAvailability: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // ✅ No need to pass accessToken - cache manager uses api client
      const data = await availabilityCacheManager.getStatus();
      const fetchedStatus = data?.worker?.isAvailable ?? data?.isAvailable ?? data?.isOnline ?? data?.status === 'online';
      if (data?.success || typeof fetchedStatus === 'boolean') {
        setIsOnline(Boolean(fetchedStatus));
        console.log(`✅ Availability loaded - Online: ${Boolean(fetchedStatus)}`);
      } else {
        setError('Failed to load availability');
      }
    } catch (err) {
      console.error('❌ Availability fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useWorkerAvailability: Screen focused, fetching status');
      fetchAvailability();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleStatusUpdate = (data: any) => {
      console.log('📡 workerStatusUpdate event received:', data);
      availabilityCacheManager.invalidate();
      const status = data?.isAvailable ?? data?.worker?.isAvailable ?? data?.isOnline ?? data?.status === 'online';
      setIsOnline(Boolean(status));
    };

    socket.on('workerStatusUpdate', handleStatusUpdate);
    return () => {
      socket.off('workerStatusUpdate', handleStatusUpdate);
    };
  }, []);

  const toggleAvailability = async (status: boolean) => {
    console.log(`🔄 Toggling availability to: ${status}`);
    setLoading(true);
    setError(null);

    try {
      // ✅ Use api client with automatic token refresh
      const response = await api.put('/workers/availability', { isAvailable: status });

      if (response.data?.success) {
        setIsOnline(status);
        availabilityCacheManager.invalidate();
        console.log(`✅ Availability updated to: ${status}`);
      } else {
        throw new Error(response.data?.message || 'Failed to update availability');
      }
    } catch (err) {
      console.error('❌ Availability toggle error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => {
    console.log('🔄 Manual availability refresh requested');
    availabilityCacheManager.invalidate();
    await fetchAvailability();
  };

  return { isOnline, loading, error, toggleAvailability, refresh };
};
