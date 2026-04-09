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
      const data = await availabilityCacheManager.getStatus(accessToken);
      if (data?.success) {
        setIsOnline(data.isOnline || data.status === 'online' || false);
        console.log(`✅ Availability loaded - Online: ${data.isOnline}`);
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
      setIsOnline(data.isOnline || data.status === 'online' || false);
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
      const response = await fetch(
        `${process.env.REACT_APP_API_BASE}/worker/availability`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ isOnline: status }),
        }
      );

      if (!response.ok) {
        throw new Error('Failed to update availability');
      }

      const data = await response.json();
      if (data.success) {
        setIsOnline(status);
        availabilityCacheManager.invalidate();
        console.log(`✅ Availability updated to: ${status}`);
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
