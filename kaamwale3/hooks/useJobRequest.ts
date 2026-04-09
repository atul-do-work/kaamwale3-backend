/**
 * 📬 useJobRequest Hook
 * 
 * Smart hook to fetch pending job requests.
 * Listens to jobRequestResponse socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { jobRequestCacheManager } from '../utils/jobRequestCacheManager';
import { socket } from '../utils/socket';

interface UseJobRequestReturn {
  requests: any[];
  pendingCount: number;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useJobRequest = (): UseJobRequestReturn => {
  const { accessToken } = useAuth();
  const [requests, setRequests] = useState<any[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRequests = async () => {
    if (!accessToken) {
      console.warn('⚠️ useJobRequest: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await jobRequestCacheManager.getStatus(accessToken);
      if (data?.success) {
        const requestList = data.requests || [];
        setRequests(requestList);
        setPendingCount(data.pendingCount || requestList.length);
        console.log(`✅ Job requests loaded: ${requestList.length} pending`);
      } else {
        setError('Failed to load job requests');
      }
    } catch (err) {
      console.error('❌ Job requests fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useJobRequest: Screen focused, fetching requests');
      fetchRequests();
    }, [accessToken])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleRequestResponse = (data: any) => {
      console.log('📡 jobRequestResponse event received:', data);
      jobRequestCacheManager.invalidate();
      
      // Update requests list in real-time
      setRequests((prev) =>
        prev.map((req) =>
          req._id === data.requestId ? { ...req, status: data.status } : req
        )
      );
      
      // Decrement pending count if request was handled
      if (data.status !== 'pending') {
        setPendingCount((prev) => Math.max(0, prev - 1));
      }
    };

    socket.on('jobRequestResponse', handleRequestResponse);
    return () => {
      socket.off('jobRequestResponse', handleRequestResponse);
    };
  }, []);

  const refresh = async () => {
    console.log('🔄 Manual job requests refresh requested');
    jobRequestCacheManager.invalidate();
    await fetchRequests();
  };

  return { requests, pendingCount, loading, error, refresh };
};
