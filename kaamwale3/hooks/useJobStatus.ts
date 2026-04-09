/**
 * 📋 useJobStatus Hook
 * 
 * Smart hook to fetch and monitor job status.
 * Listens to jobUpdated socket events.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../context/AuthContext';
import { jobStatusCacheManager } from '../utils/jobStatusCacheManager';
import { socket } from '../utils/socket';

interface UseJobStatusReturn {
  jobs: any[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export const useJobStatus = (jobId?: string): UseJobStatusReturn => {
  const { accessToken } = useAuth();
  const [jobs, setJobs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchJobStatus = async () => {
    if (!accessToken) {
      console.warn('⚠️ useJobStatus: No access token');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await jobStatusCacheManager.getStatus(accessToken, jobId);
      if (data?.success) {
        const jobsList = data.jobs || (jobId ? [data] : []);
        setJobs(jobsList);
        console.log(`✅ Job status loaded: ${jobsList.length} jobs`);
      } else {
        setError('Failed to load job status');
      }
    } catch (err) {
      console.error('❌ Job status fetch error:', err);
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  // Fetch on screen focus
  useFocusEffect(
    useCallback(() => {
      console.log('🔍 useJobStatus: Screen focused, fetching jobs');
      fetchJobStatus();
    }, [accessToken, jobId])
  );

  // Listen for socket updates
  useEffect(() => {
    if (!socket) return;

    const handleJobUpdate = (data: any) => {
      console.log('📡 jobUpdated event received:', data);
      jobStatusCacheManager.invalidate();
      
      if (data.jobId && jobId && data.jobId === jobId) {
        setJobs([data]);
      } else if (!jobId) {
        // If no specific jobId filter, invalidate and refetch
        fetchJobStatus();
      }
    };

    socket.on('jobUpdated', handleJobUpdate);
    return () => {
      socket.off('jobUpdated', handleJobUpdate);
    };
  }, [jobId]);

  const refresh = async () => {
    console.log('🔄 Manual job status refresh requested');
    jobStatusCacheManager.invalidate();
    await fetchJobStatus();
  };

  return { jobs, loading, error, refresh };
};
