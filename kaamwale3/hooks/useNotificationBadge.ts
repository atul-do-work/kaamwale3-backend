/**
 * 🔔 useNotificationBadge Hook
 * 
 * Smart hook to show notification badge count.
 * Listens to notificationUpdate socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { notificationCacheManager } from '../utils/notificationCacheManager';
import { socket } from '../utils/socket';

interface UseNotificationBadgeReturn {
  unreadCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useNotificationBadge = (): UseNotificationBadgeReturn => {
  const { accessToken } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUnreadCount = async () => {
    if (!accessToken) {
      console.warn('⚠️ useNotificationBadge: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await notificationCacheManager.getStatus(accessToken);
      if (data?.success) {
        setUnreadCount(data.unreadCount || data.count || 0);
        console.log(`✅ Unread notifications: ${data.unreadCount}`);
      } else {
        setError('Failed to load notification count');
      }
    } catch (err) {
      console.error('❌ Notification count fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useNotificationBadge: Screen focused, fetching count');
      fetchUnreadCount();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleNotification = (data: any) => {
      console.log('📡 notificationUpdate event received:', data);
      notificationCacheManager.invalidate();
      
      if (data.unreadCount !== undefined) {
        setUnreadCount(data.unreadCount);
      } else if (data.action === 'increment') {
        setUnreadCount((prev) => prev + 1);
      } else if (data.action === 'decrement') {
        setUnreadCount((prev) => Math.max(0, prev - 1));
      } else if (data.action === 'reset') {
        setUnreadCount(0);
      }
    };

    socket.on('notificationUpdate', handleNotification);
    return () => {
      socket.off('notificationUpdate', handleNotification);
    };
  }, []);

  const refresh = async () => {
    console.log('🔄 Manual notification count refresh requested');
    notificationCacheManager.invalidate();
    await fetchUnreadCount();
  };

  return { unreadCount, loading, error, refresh };
};
