import React, { useEffect, useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, FlatList, Modal, Animated, Easing } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { socket } from '../../../utils/socket';
import { SERVER_URL, API_BASE } from '../../../utils/config';
import PremiumPlansModal from '../../../components/PremiumPlansModal';
import { useLanguage } from '../../../context/LanguageContext';
import { useAuth } from '../../../context/AuthContext';
import { premiumCacheManager } from '../../../utils/premiumCacheManager';
import { isPremiumPlanActive } from '../../../utils/premiumPlanState';
import styles from '../../../styles/ContractorHomeStyles';



const normalizePhoneDigits = (value: any) => String(value || '').replace(/\D/g, '').slice(-10);

const isJobFullyPaid = (job: any): boolean => {
  const paymentStatus = String(job?.paymentStatus || '').toLowerCase();
  if (paymentStatus === 'paid') return true;
  if (Array.isArray(job?.acceptedWorkers)) {
    return job.acceptedWorkers.some((worker: any) =>
      String(worker?.paymentStatus || '').toLowerCase() === 'paid'
    );
  }
  return false;
};

const filterUnpaidWorkerPhones = (job: any): string[] => {
  if (!Array.isArray(job?.acceptedWorkers)) return [];
  return job.acceptedWorkers
    .filter((worker: any) => String(worker?.paymentStatus || '').toLowerCase() !== 'paid')
    .map((worker: any) => worker?.phone || worker?.workerPhone || worker?.acceptedBy)
    .filter(Boolean)
    .map((phone: any) => String(phone).trim());
};

export default function ContractorHome() {
  const isFocused = useIsFocused();
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const currentUserPhone = authUser?.phone || null;
  const [premiumModalVisible, setPremiumModalVisible] = React.useState(false);
  const [hasPremium, setHasPremium] = React.useState(false);
  const [premiumStatusLoading, setPremiumStatusLoading] = React.useState(true);
  const [premiumDetails, setPremiumDetails] = React.useState<any | null>(null);
  const [userProfilePhoto, setUserProfilePhoto] = React.useState<any | null>(null);
  // Default avatar assets (used when contractor hasn't set a profilePhoto)
  const defaultAvatars = [
    require('../../../assets/avatar1.png'),
    require('../../../assets/avatar2.png'),
    require('../../../assets/avatar3.png'),
    require('../../../assets/avatar4.png'),
    require('../../../assets/avatar5.png'),
    require('../../../assets/avatar6.png'),
  ];

  const normalizeMediaUrl = (url?: string | null): string | null => {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('http://')) return trimmed.replace('http://', 'https://');
    if (trimmed.startsWith('https://')) return trimmed;
    if (trimmed.startsWith('/')) return `${API_BASE}${trimmed}`;
    return `${API_BASE}/${trimmed}`;
  };

  const avatarSourceForEntry = (entry: any, positionIndex = 1) => {
    const isCurrent = Boolean(currentUserPhone && (entry.id === currentUserPhone || entry.phone === currentUserPhone));

    // If this is the current user, prefer cached userProfilePhoto (updates via socket)
    if (isCurrent && userProfilePhoto) return userProfilePhoto;

    // If entry has a profile URL, use it
    if (entry?.profile) {
      if (typeof entry.profile === 'string') {
        const uri = normalizeMediaUrl(entry.profile);
        if (uri) return { uri };
      } else {
        return entry.profile;
      }
    }

    // Fallback: choose a default avatar based on rank/position for variety
    const idx = Math.max(0, ((entry?.rank || positionIndex) - 1) % defaultAvatars.length);
    return defaultAvatars[idx];
  };
  const [leaderboard, setLeaderboard] = React.useState<any[]>([]);
  const [currentUserLeaderboardEntry, setCurrentUserLeaderboardEntry] = React.useState<any | null>(null);
  const [leaderboardExpanded, setLeaderboardExpanded] = React.useState(false);
  const [leaderboardPagination, setLeaderboardPagination] = React.useState<{
    page: number;
    pageSize: number;
    totalPages: number;
    hasNextPage: boolean;
    loading: boolean;
  }>({
    page: 1,
    pageSize: 50,
    totalPages: 1,
    hasNextPage: false,
    loading: false,
  });
  const [jobsDoneCount, setJobsDoneCount] = React.useState(0);
  const [postedCount, setPostedCount] = React.useState(0);
  const [totalSpending, setTotalSpending] = React.useState(0);
  const [workersEngaged, setWorkersEngaged] = React.useState(0);
  const [notificationCount, setNotificationCount] = React.useState<number>(0); // ? Add notification count state
  const [showLocationModal, setShowLocationModal] = React.useState<boolean>(false); // ? Location modal state
  const [requestingLocation, setRequestingLocation] = React.useState<boolean>(false); // ? Loading state for location request
  const [supportModalVisible, setSupportModalVisible] = React.useState(false);
  // ? Removed dead token state - use accessToken from context instead

  // Track if premium status has been checked to prevent repeated loading
  const premiumStatusCheckedRef = React.useRef(false);
  const focusBootstrapInFlightRef = React.useRef(false);

  // ? Separate premium listener effect - runs on login, not on every tab focus
  React.useEffect(() => {
    if (!accessToken) return;

    const handlePremiumSubscriptionUpdate = async (data: any) => {
      console.log(`Premium subscription update received from contractor ${data.contractorPhone}`);
      
      try {
        premiumCacheManager.invalidate();
        const userStr = await AsyncStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : null;
        
        // Clear leaderboard cache on premium status change
        await clearLeaderboardCache();
        
        if (!isFocused) return;

        const formattedLeaderboard = await fetchLeaderboardByDistrict({
          latitude: Number(user?.latitude || 0),
          longitude: Number(user?.longitude || 0),
          token: accessToken,
        });
        console.log('Leaderboard refreshed after premium subscription update:', formattedLeaderboard);
      } catch (err) {
        console.error('Error refreshing leaderboard on subscription update:', (err as Error).message);
      }
    };

    socket.on('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);

    // ✅ NEW: Listen for any leaderboard updates from backend
    const handleLeaderboardUpdated = async (data: any) => {
      console.log('📊 leaderboardUpdated event received from backend:', data);
      
      try {
        // CRITICAL: Clear all cached pages when backend leaderboard changes
        await clearLeaderboardCache();
        console.log('✅ Leaderboard cache invalidated due to backend changes');
        
        // Optionally refresh current view if visible
        if (isFocused && hasPremium && !leaderboardExpanded) {
          const userStr = await AsyncStorage.getItem('user');
          const user = userStr ? JSON.parse(userStr) : null;
          await fetchLeaderboardByDistrict({
            latitude: Number(user?.latitude || 0),
            longitude: Number(user?.longitude || 0),
            token: accessToken,
            page: 1,
          });
          console.log('✅ Leaderboard refreshed after backend update');
        }
      } catch (err) {
        console.error('Error handling leaderboardUpdated event:', err);
      }
    };

    socket.on('leaderboardUpdated', handleLeaderboardUpdated);

    // ✅ NEW: Listen for contractor rating/score changes
    const handleContractorScoreUpdated = async (data: any) => {
      console.log('⭐ contractorScoreUpdated event received:', data);
      
      try {
        // Clear cache when any contractor's score changes
        // (This affects sorting and ranking)
        await clearLeaderboardCache();
        console.log('✅ Leaderboard cache cleared due to score change');
      } catch (err) {
        console.error('Error handling score update:', err);
      }
    };

    socket.on('contractorScoreUpdated', handleContractorScoreUpdated);
    socket.on('contractorRatingUpdated', handleContractorScoreUpdated); // Same handler for rating changes

    const handleJobRequestResponse = (data: any) => {
      console.log('Job request response received:', data);
      // Show alert for job request response
      const message = data.accepted
        ? `Your job request was accepted by ${data.workerName || 'the worker'}!`
        : `Your job request was declined by ${data.workerName || 'the worker'}.`;
      
      // You could also update local state here if needed
      // For now, just show an alert
      setTimeout(() => {
        alert(message);
      }, 100);
    };

    socket.on('jobRequestResponse', handleJobRequestResponse);

    const handleJobCancelled = async (data: any) => {
      try {
        const contractorPhone = String(data?.contractorPhone || "").trim();
        if (!currentUserPhone || !contractorPhone) return;
        if (normalizePhoneDigits(contractorPhone) !== normalizePhoneDigits(currentUserPhone)) return;

        console.log('🔔 jobCancelled received for contractor, refreshing notification count');
        if (isFocused) {
          await fetchNotificationCount();
        }
      } catch (err) {
        console.warn('Failed to refresh notifications on jobCancelled:', err);
      }
    };

    socket.on('jobCancelled', handleJobCancelled);

    const handleProfilePhotoUpdated = async (data: any) => {
      try {
        if (data.phone !== currentUserPhone) return;

        console.log('📸 Contractor profilePhotoUpdated event:', data.profilePhoto);
        setUserProfilePhoto({ uri: data.profilePhoto });

        const userStr = await AsyncStorage.getItem('user');
        if (userStr) {
          const user = JSON.parse(userStr);
          user.profilePhoto = data.profilePhoto;
          await AsyncStorage.setItem('user', JSON.stringify(user));
        }
      } catch (err) {
        console.warn('Error handling profile photo update:', err);
      }
    };

    socket.on('profilePhotoUpdated', handleProfilePhotoUpdated);

    return () => {
      socket.off('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);
      socket.off('leaderboardUpdated', handleLeaderboardUpdated);
      socket.off('contractorScoreUpdated', handleContractorScoreUpdated);
      socket.off('contractorRatingUpdated', handleContractorScoreUpdated);
      socket.off('jobRequestResponse', handleJobRequestResponse);
      socket.off('jobCancelled', handleJobCancelled);
      socket.off('profilePhotoUpdated', handleProfilePhotoUpdated);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, currentUserPhone, hasPremium, isFocused, leaderboardExpanded]);

  // ? Memoize sorted leaderboard to prevent re-sorting on every render
  // CRITICAL: Clone array before sorting to avoid mutating React state
  const sortedLeaderboard = React.useMemo(() => {
    const deduped = new Map<string, any>();
    leaderboard.forEach((entry) => {
      const key = String(entry?.id || entry?.phone || '');
      if (!key) return;
      const existing = deduped.get(key);
      if (!existing || (entry?.rank || 999999) < (existing?.rank || 999999)) {
        deduped.set(key, entry);
      }
    });
    return Array.from(deduped.values()).sort((a, b) => (a.rank || 999) - (b.rank || 999));
  }, [leaderboard]);

  // Prepare top-3 and remaining list once per render
  const top = React.useMemo(() => sortedLeaderboard.slice(0, 3), [sortedLeaderboard]);
  const first = top[0] || null;
  const second = top[1] || null;
  const third = top[2] || null;
  const currentUserInTopThree = React.useMemo(
    () => top.some((p) => Boolean(currentUserPhone && (p.id === currentUserPhone || p.phone === currentUserPhone))),
    [top, currentUserPhone]
  );

  const remainingList = React.useMemo(() => {
    const originalRemaining = sortedLeaderboard.slice(3);
    if (currentUserInTopThree) {
      return originalRemaining;
    }

    const userEntry = currentUserLeaderboardEntry || sortedLeaderboard.find((p) =>
      Boolean(currentUserPhone && (p.id === currentUserPhone || p.phone === currentUserPhone))
    );

    if (!userEntry) {
      return originalRemaining;
    }

    const filtered = originalRemaining.filter((p) => !(p.id === userEntry.id || p.phone === userEntry.phone));
    return [userEntry, ...filtered];
  }, [sortedLeaderboard, currentUserPhone, currentUserLeaderboardEntry, currentUserInTopThree]);

  const profileSourceSecond = second ? avatarSourceForEntry(second, 2) : null;
  const profileSourceFirst = first ? avatarSourceForEntry(first, 1) : null;
  const profileSourceThird = third ? avatarSourceForEntry(third, 3) : null;

  // Initialize row animations whenever remainingList changes
  useEffect(() => {
    rowAnimsRef.current = remainingList.map(() => new Animated.Value(0));
    Animated.stagger(
      80,
      rowAnimsRef.current.map((v) =>
        Animated.timing(v, { toValue: 1, duration: 360, easing: Easing.out(Easing.cubic), useNativeDriver: true })
      )
    ).start();
  }, [remainingList]);

  // Animation for top-3 entrance
  const topAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    // Reset and play entrance when leaderboard changes
    topAnim.setValue(0);
    Animated.timing(topAnim, {
      toValue: 1,
      duration: 550,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [sortedLeaderboard, topAnim]);

  // FlatList scroll preservation for remaining list
  const remainingListRef = useRef<FlatList<any> | null>(null);
  const scrollOffsetRef = useRef(0);
  const onListScroll = (e: any) => {
    scrollOffsetRef.current = e.nativeEvent.contentOffset?.y || 0;
  };

  // Row animations (staggered) - keep refs at component level, values assigned when remainingList is computed
  const rowAnimsRef = useRef<Animated.Value[]>([]);

  // When leaderboard updates, restore previous scroll offset to avoid jumps when inserting current user
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (remainingListRef.current && typeof scrollOffsetRef.current === 'number') {
        try {
          remainingListRef.current.scrollToOffset({ offset: scrollOffsetRef.current, animated: false });
        } catch (err) {
          // ignore if unable to scroll (index out of range)
        }
      }
    }, 50);
    return () => clearTimeout(timeout);
  }, [leaderboard]);

  const toSafeNumber = React.useCallback((value: any) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }, []);

  const formatPremiumDate = React.useCallback((value: string | Date | null) => {
    if (!value) return '';
    const date = new Date(value);
    if (!date || Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }, []);

  const getPremiumStatusMessage = React.useCallback(() => {
    if (!premiumDetails?.type || premiumDetails?.type === 'free') {
      return 'Upgrade to Premium to see full rankings';
    }

    const status = String(premiumDetails.status || '').toLowerCase();
    switch (status) {
      case 'expired':
        return `Your ${premiumDetails.type} plan expired on ${formatPremiumDate(premiumDetails.expiryDate)}.`;
      case 'grace':
        return `Your ${premiumDetails.type} plan is in a grace period until ${formatPremiumDate(premiumDetails.graceUntil)}.`;
      case 'active':
        return `Your ${premiumDetails.type} plan is active, but leaderboard access is still loading.`;
      default:
        return `Your ${premiumDetails.type} plan has status '${premiumDetails.status || 'unknown'}'. Please refresh or contact support.`;
    }
  }, [premiumDetails, formatPremiumDate]);

  const mapLeaderboardRows = React.useCallback((rows: any[] = []) => {
    return rows.map((contractor: any) => ({
      id: contractor.contractorId || contractor._id || contractor.phone,
      phone: contractor.phone || contractor.contractorPhone || contractor.contractorId || contractor._id,
      name: contractor.name || 'Unknown',
      points: toSafeNumber(contractor.score ?? contractor.points ?? contractor.finalScore ?? contractor.myPoints ?? 0),
      profile: contractor.profilePhoto ? contractor.profilePhoto : null,
      rank: toSafeNumber(contractor.rank ?? contractor.position ?? 0),
      rating: toSafeNumber(contractor.rating ?? contractor.avgRating ?? contractor.averageRating ?? 0),
      jobsPosted: toSafeNumber(contractor.jobCount ?? contractor.totalJobsPosted ?? contractor.jobsPosted ?? 0),
      tier: contractor.tier || 'new',
    }));
  }, [toSafeNumber]);

  const fetchLeaderboardByDistrict = React.useCallback(async ({
    latitude,
    longitude,
    token = accessToken,
    useCacheFallback = false,
    page = 1,
    limit = 50,
    append = false,
  }: {
    latitude?: number;
    longitude?: number;
    token?: string | null;
    useCacheFallback?: boolean;
    page?: number;
    limit?: number;
    append?: boolean;
  } = {}) => {
    if (!token) return [];

    const lat = Number(latitude ?? authUser?.latitude ?? 0);
    const lon = Number(longitude ?? authUser?.longitude ?? 0);
    const CACHE_TTL_MINUTES = 30; // Cache expires after 30 minutes
    const CACHE_KEY_PREFIX = 'leaderboard_v2_page_'; // Per-page cache key
    const CACHE_META_KEY = 'leaderboard_meta'; // Global cache metadata
    const CACHE_INDEX_KEY = 'leaderboard_cache_index'; // Track which pages are cached

    try {
      const leaderboardRes = await fetch(
        `${SERVER_URL}/leaderboard/contractors/by-district?lat=${lat}&lon=${lon}&page=${page}&limit=${limit}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!leaderboardRes.ok) {
        throw new Error(`Leaderboard fetch failed with status ${leaderboardRes.status}`);
      }

      const leaderboardData = await leaderboardRes.json();
      
      if (!leaderboardData.success) {
        throw new Error(leaderboardData.message || 'Failed to fetch leaderboard');
      }

      const boardData = leaderboardData.leaderboard || [];
      const formattedLeaderboard = mapLeaderboardRows(boardData);
      const formattedCurrentUserEntry = leaderboardData.currentUserEntry
        ? mapLeaderboardRows([leaderboardData.currentUserEntry])[0] || null
        : null;

      // Update pagination state
      setLeaderboardPagination({
        page: leaderboardData.pagination?.page || page,
        pageSize: leaderboardData.pagination?.pageSize || limit,
        totalPages: leaderboardData.pagination?.totalPages || 1,
        hasNextPage: leaderboardData.pagination?.hasNextPage || false,
        loading: false,
      });

      // Either replace or append the leaderboard data
      if (append) {
        setLeaderboard(prev => [...prev, ...formattedLeaderboard]);
      } else {
        setLeaderboard(formattedLeaderboard);
      }
      setCurrentUserLeaderboardEntry(formattedCurrentUserEntry);

      // ⚠️ CHECK CACHED VERSION BEFORE SAVING NEW DATA
      // This detects if backend logic changed since last request
      try {
        const cachedMeta = await AsyncStorage.getItem(CACHE_META_KEY);
        if (cachedMeta) {
          const meta = JSON.parse(cachedMeta);
          const backendVersion = leaderboardData.version || 1;
          const cachedVersion = meta.dataVersion || 1;
          
          if (backendVersion !== cachedVersion) {
            console.warn(`⚠️ VERSION MISMATCH DETECTED: Cached v${cachedVersion} → Backend v${backendVersion}`);
            console.warn('   This means backend logic changed - invalidating old cache');
            // Old cache is now stale, will be replaced below
          }
        }
      } catch (err) {
        console.warn('Could not validate version before caching:', err);
      }

      // Cache individual page with metadata
      const cacheMetadata = {
        timestamp: Date.now(),
        latitude: lat,
        longitude: lon,
        cacheVersion: 3, // Increment for cache format changes
        dataVersion: leaderboardData.version || 1, // CRITICAL: Backend version for validation
        totalPages: leaderboardData.pagination?.totalPages || 1,
      };
      
      // Store page-specific cache
      const pageCache = {
        data: leaderboardData,
        timestamp: Date.now(),
      };
      
      await AsyncStorage.setItem(CACHE_KEY_PREFIX + page, JSON.stringify(pageCache));
      await AsyncStorage.setItem(CACHE_META_KEY, JSON.stringify(cacheMetadata));
      
      // Update cache index to track cached pages
      try {
        const indexStr = await AsyncStorage.getItem(CACHE_INDEX_KEY);
        const index = indexStr ? JSON.parse(indexStr) : { pages: [], location: { lat, lon } };
        if (!index.pages.includes(page)) {
          index.pages.push(page);
        }
        index.location = { lat, lon };
        await AsyncStorage.setItem(CACHE_INDEX_KEY, JSON.stringify(index));
      } catch (err) {
        console.warn('Could not update cache index:', err);
      }

      return formattedLeaderboard;
    } catch (err) {
      if (!useCacheFallback) throw err;

      // Try to use cache only if it's still fresh and valid
      try {
        const cachedMeta = await AsyncStorage.getItem(CACHE_META_KEY);

        if (!cachedMeta) {
          console.warn('⚠️ No cached leaderboard metadata found');
          return [];
        }

        const meta = JSON.parse(cachedMeta);
        const now = Date.now();
        const cacheAgeMinutes = (now - meta.timestamp) / (1000 * 60);
        
        // ⚠️ CHECK 1: Cache expiration (TTL)
        if (cacheAgeMinutes > CACHE_TTL_MINUTES) {
          console.warn(`⚠️ Cache expired (${cacheAgeMinutes.toFixed(1)} min old, TTL: ${CACHE_TTL_MINUTES} min)`);
          await clearLeaderboardCache();
          return [];
        }

        // ⚠️ CHECK 2: Location change validation
        const latDiff = Math.abs(meta.latitude - lat);
        const lonDiff = Math.abs(meta.longitude - lon);
        if (latDiff > 0.01 || lonDiff > 0.01) { // ~1km difference
          console.warn('⚠️ Location changed significantly, invalidating cache');
          await clearLeaderboardCache();
          return [];
        }

        // ⚠️ CHECK 3: Backend version sync (CRITICAL - NOW ACTUALLY VALIDATING)
        // NOTE: When offline, we can't validate current version
        // Best practice: On next online request, version will be checked
        // If mismatch detected, cache is invalidated
        console.log(`📦 Using offline cache with dataVersion: ${meta.dataVersion}`);
        console.log('   ⚠️ WARNING: Cannot validate version while offline - next online request will validate');

        // Try to get cached page
        const pageCache = await AsyncStorage.getItem(CACHE_KEY_PREFIX + page);
        if (!pageCache) {
          console.warn(`⚠️ Page ${page} not in cache`);
          return [];
        }

        const cachedPageData = JSON.parse(pageCache);
        const leaderboardData = cachedPageData.data;
        const boardData = leaderboardData.leaderboard || [];
        const formattedLeaderboard = mapLeaderboardRows(boardData);
        const formattedCurrentUserEntry = leaderboardData.currentUserEntry
          ? mapLeaderboardRows([leaderboardData.currentUserEntry])[0] || null
          : null;

        // Update pagination from cache
        setLeaderboardPagination({
          page: leaderboardData.pagination?.page || 1,
          pageSize: leaderboardData.pagination?.pageSize || 50,
          totalPages: leaderboardData.pagination?.totalPages || 1,
          hasNextPage: leaderboardData.pagination?.hasNextPage || false,
          loading: false,
        });

        if (append) {
          setLeaderboard(prev => [...prev, ...formattedLeaderboard]);
        } else {
          setLeaderboard(formattedLeaderboard);
        }
        setCurrentUserLeaderboardEntry(formattedCurrentUserEntry);

        console.log(`📦 Using cached leaderboard page ${page} (${cacheAgeMinutes.toFixed(1)} min old, v${meta.dataVersion})`);
        return formattedLeaderboard;
      } catch (cacheErr) {
        console.error('❌ Cache retrieval failed:', cacheErr);
        return [];
      }
    }
  }, [accessToken, authUser?.latitude, authUser?.longitude, mapLeaderboardRows]);

  // CRITICAL: Validate cached dataVersion against backend
  // Call this after network comes online or on app focus
  const validateCacheVersion = React.useCallback(async (token?: string | null) => {
    if (!token) return;
    
    try {
      const cachedMeta = await AsyncStorage.getItem('leaderboard_meta');
      if (!cachedMeta) return; // No cache to validate
      
      const meta = JSON.parse(cachedMeta);
      const cachedVersion = meta.dataVersion || 1;
      
      // Fetch leaderboard metadata to check current backend version
      // Try page 1 first (smallest payload)
      const res = await fetch(
        `${SERVER_URL}/leaderboard/contractors/by-district?lat=0&lon=0&page=1&limit=1`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      
      if (!res.ok) return;
      
      const data = await res.json();
      const backendVersion = data.version || 1;
      
      // ✅ NOW ACTUALLY COMPARING VERSIONS
      if (backendVersion !== cachedVersion) {
        console.warn(`🚨 VERSION MISMATCH DETECTED!`);
        console.warn(`   Cached: v${cachedVersion}`);
        console.warn(`   Backend: v${backendVersion}`);
        console.warn(`   → Backend logic changed, invalidating all cache`);
        
        // Invalidate all cached data
        await clearLeaderboardCache();
        return;
      }
      
      console.log(`✅ Cache version valid: v${cachedVersion} matches backend v${backendVersion}`);
    } catch (err) {
      console.warn('Could not validate cache version:', err);
      // Fail silently - not critical if validation fails
    }
  }, []);

  // CRITICAL: Clear all leaderboard cache (used for invalidation events)
  const clearLeaderboardCache = React.useCallback(async () => {
    try {
      // Get cache index to find all cached pages
      const indexStr = await AsyncStorage.getItem('leaderboard_cache_index');
      if (indexStr) {
        const index = JSON.parse(indexStr);
        if (Array.isArray(index.pages)) {
          for (const pageNum of index.pages) {
            await AsyncStorage.removeItem('leaderboard_v2_page_' + pageNum);
          }
        }
      }
      
      await AsyncStorage.removeItem('leaderboard_meta');
      await AsyncStorage.removeItem('leaderboard_cache_index');
      console.log('✅ All leaderboard cache cleared');
    } catch (err) {
      console.warn('Could not clear leaderboard cache:', err);
    }
  }, []);

  const loadMoreLeaderboard = React.useCallback(async () => {
    if (leaderboardPagination.loading || !leaderboardPagination.hasNextPage) return;

    setLeaderboardPagination(prev => ({ ...prev, loading: true }));

    try {
      await fetchLeaderboardByDistrict({
        page: leaderboardPagination.page + 1,
        limit: leaderboardPagination.pageSize,
        append: true,
      });
    } catch (err) {
      console.error('Error loading more leaderboard:', err);
      setLeaderboardPagination(prev => ({ ...prev, loading: false }));
    }
  }, [leaderboardPagination, fetchLeaderboardByDistrict]);

  const fetchPremiumStatus = React.useCallback(async (): Promise<boolean> => {
    if (!accessToken) {
      setHasPremium(false);
      setPremiumDetails(null);
      setPremiumStatusLoading(false);
      return false;
    }
    
    // If already checked, don't show loading again
    if (!premiumStatusCheckedRef.current) {
      setPremiumStatusLoading(true);
    }
    
    try {
      const data = await premiumCacheManager.getStatus(accessToken);
      const fallbackPlan = data?.premiumDetails || authUser?.premiumPlan || premiumDetails || null;
      const isActive = data?.success
        ? Boolean(data?.isActive)
        : isPremiumPlanActive(fallbackPlan);
      setHasPremium(isActive);
      setPremiumDetails(fallbackPlan);
      premiumStatusCheckedRef.current = true; // Mark as checked
      return isActive;
    } catch (err) {
      console.warn('Could not fetch premium status:', (err as Error).message);
      const fallbackPlan = authUser?.premiumPlan || premiumDetails || null;
      const isActive = isPremiumPlanActive(fallbackPlan);
      setHasPremium(isActive);
      setPremiumDetails(fallbackPlan);
      return isActive;
    } finally {
      setPremiumStatusLoading(false);
    }
  }, [accessToken, authUser?.premiumPlan, premiumDetails]);

  useEffect(() => {
    if (!accessToken) {
      setPremiumStatusLoading(false);
      setHasPremium(false);
      setPremiumDetails(null);
      setLeaderboard([]);
      premiumStatusCheckedRef.current = false; // Reset when token changes
      return;
    }
    // Prevent locked-banner flicker while status request is in-flight.
    if (!premiumStatusCheckedRef.current) {
      setPremiumStatusLoading(true);
    }
  }, [accessToken]);

  useEffect(() => {
    const plan = authUser?.premiumPlan || null;
    if (!plan) return;

    setPremiumDetails(plan);

    if (isPremiumPlanActive(plan)) {
      setHasPremium(true);
      setPremiumStatusLoading(false);
      premiumStatusCheckedRef.current = true;
      return;
    }

    if (String(plan.type || '').toLowerCase() === 'free') {
      setHasPremium(false);
      setPremiumStatusLoading(false);
      premiumStatusCheckedRef.current = true;
    }
  }, [authUser?.premiumPlan]);
  const topCards = [
    { id: 1, icon: 'work', amount: postedCount.toString(), label: t('jobsPosted') },
    { id: 2, icon: 'check-circle', amount: jobsDoneCount.toString(), label: t('jobsCompleted') },
    { id: 3, icon: 'people', amount: workersEngaged.toString(), label: t('workers') },
    { id: 4, icon: 'attach-money', amount: `₹${totalSpending}`, label: t('spending') },
  ];

  const bottomCard = { id: 3, icon: 'dashboard', amount: '', label: t('dashboard') };

  // Leaderboard is now populated from state in useFocusEffect

  const handleUpgrade = () => {
    setPremiumModalVisible(true);
  };

  const fetchJobs = React.useCallback(async () => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      const res = await fetch(`${SERVER_URL}/jobs`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch jobs');

      const data = await res.json();

      // Filter jobs posted by this contractor
      const myJobs = data.filter((job: any) => job.contractorPhone === currentUserPhone && !job.isCancelled);
      setPostedCount(myJobs.length);

      // Count active/unpaid workers for contractor jobs
      const unpaidJobs = myJobs.filter((job: any) => !isJobFullyPaid(job) && (job.acceptedBy || (job.acceptedWorkers && job.acceptedWorkers.length > 0)));
      const uniqueUnpaidWorkers = new Set(unpaidJobs.flatMap((job: any) => filterUnpaidWorkerPhones(job)));
      setWorkersEngaged(uniqueUnpaidWorkers.size);

      // Count jobs done (paid jobs for this contractor)
      const paidJobs = myJobs.filter((job: any) => isJobFullyPaid(job));
      setJobsDoneCount(paidJobs.length);

      // Total spending by contractor (sum of amounts for paid jobs)
      const spending = paidJobs.reduce((sum: number, j: any) => sum + (Number(j.amount) || 0), 0);
      setTotalSpending(spending);
      
      // ? Save last posted job ID for waiting screen access
      if (myJobs.length > 0) {
        const lastJob = myJobs[myJobs.length - 1]; // Most recent job
        try {
          await AsyncStorage.setItem('lastJobId', lastJob._id);
          console.log('? Last job ID saved:', lastJob._id);
        } catch (err) {
          console.warn('Could not save lastJobId:', err);
        }
      }
    } catch (err) {
      console.error('Job fetch error:', err);
    }
  }, [accessToken, currentUserPhone]);

  // ? Fetch notification count
  const fetchNotificationCount = React.useCallback(async () => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      const res = await fetch(`${SERVER_URL}/notifications?limit=100&skip=0`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch notifications');
      
      const data = await res.json();
      setNotificationCount(data.unreadCount || 0);
    } catch (err) {
      console.error('Failed to fetch notification count:', err);
    }
  }, [accessToken]);

  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        if (focusBootstrapInFlightRef.current) {
          return;
        }

        focusBootstrapInFlightRef.current = true;
        try {
          const savedToken = accessToken;

          if (savedToken) {
            let currentUser = null;

            if (authUser) {
              currentUser = authUser;
              if (currentUser.profilePhoto) {
                setUserProfilePhoto({ uri: currentUser.profilePhoto });
              }
            }

            if (!currentUser?.premiumPlan) {
              try {
                const response = await fetch(`${SERVER_URL}/users/profile`, {
                  headers: { Authorization: `Bearer ${savedToken}` },
                });
                if (response.ok) {
                  const data = await response.json();

                  if (data.success && data.user) {
                    currentUser = { ...currentUser, ...data.user };
                    await AsyncStorage.setItem('user', JSON.stringify(currentUser));
                  }
                } else {
                  console.warn(`Profile fetch returned status ${response.status}`);
                }
              } catch (err) {
                console.warn('Could not fetch fresh user data:', err);
              }
            }

            // ✅ NEW: Validate cache version against backend
            await validateCacheVersion(savedToken);

            const hasActivePremium = await fetchPremiumStatus();
            if (!hasActivePremium) {
              setLeaderboard([]);
              // Clear cache if no longer premium
              await clearLeaderboardCache();
            }

            if (hasActivePremium) {
              try {
                // Check if cache is still valid before using fallback
                const cachedMeta = await AsyncStorage.getItem('leaderboard_meta');
                const canUseCacheFallback = !!cachedMeta;
                
                await fetchLeaderboardByDistrict({
                  latitude: Number(currentUser?.latitude || 0),
                  longitude: Number(currentUser?.longitude || 0),
                  token: savedToken,
                  useCacheFallback: canUseCacheFallback,
                });
              } catch (err) {
                console.warn('⚠️ Error loading leaderboard:', (err as Error).message);
              }
            }

            if (!socket.connected && savedToken) {
              socket.auth = { token: savedToken };
              socket.connect();
            }

            await Promise.all([
              fetchJobs(),
              fetchNotificationCount(),
            ]);
          }
        } catch {
          // Silent fail on token loading
        } finally {
          focusBootstrapInFlightRef.current = false;
        }
      })();

      return () => {
        // ? Socket listener cleanup is now handled in separate useEffect
        // This useFocusEffect focuses on data fetching
      };
    }, [accessToken, authUser?.premiumPlan, authUser?.profilePhoto, fetchJobs, fetchLeaderboardByDistrict, fetchNotificationCount, fetchPremiumStatus, validateCacheVersion, clearLeaderboardCache])
  );

  // ? REQUEST AND UPDATE LOCATION FOR CONTRACTOR
  const requestAndUpdateLocation = async (): Promise<boolean> => {
    try {
      setRequestingLocation(true);
      console.log('Requesting location permission for contractor...');

      const { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        console.warn('Location permission denied');
        return false;
      }

      console.log('? Location permission granted, getting position...');
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      console.log(`Location obtained: lat=${latitude}, lon=${longitude}`);

      // Update location on backend
      console.log(`Sending location update to ${API_BASE}/user/update-location`);
      const response = await fetch(`${API_BASE}/user/update-location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ latitude, longitude }),
      });

      console.log(`Backend response status: ${response.status}`);
      const data = await response.json();
      console.log(`Backend response data:`, data);

      if (!response.ok) {
        console.error('? Backend returned error status:', response.status, data.message);
        return false;
      }

      if (!data.success) {
        console.error('? Backend returned success=false:', data.message);
        return false;
      }

      console.log('? Location updated on backend:', data.user);
      
      // CRITICAL: Invalidate ALL leaderboard cache pages when location changes
      await clearLeaderboardCache();
      
      // Update local user data
      const userStr = await AsyncStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        user.latitude = data.user.latitude;
        user.longitude = data.user.longitude;
        user.city = data.user.city;
        user.state = data.user.state;
        await AsyncStorage.setItem('user', JSON.stringify(user));
        console.log('? Contractor location data updated in local storage');
      }

      // Close modal after successful location update
      console.log('Closing location modal...');
      setShowLocationModal(false);
      console.log(`? Location enabled! City: ${data.user.city}, State: ${data.user.state}`);
      return true;
    } catch (err) {
      console.error('? Error requesting location:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Error details: ${errorMsg}`);
      return false;
    } finally {
      console.log('Cleanup: Setting requestingLocation to false');
      setRequestingLocation(false);
    }
  };

  // ? CHECK FOR DEFAULT LOCATION AND SHOW MODAL POST-LOGIN
  useEffect(() => {
    (async () => {
      if (!accessToken) return;

      try {
        const userStr = await AsyncStorage.getItem('user');
        if (!userStr) return;

        const user = JSON.parse(userStr);
        const locationProvidedOnLogin = await AsyncStorage.getItem('locationProvidedOnLogin');

        // Check if location is default (0,0) or missing
        const hasDefaultLocation = (user.latitude === 0 && user.longitude === 0) || 
                                   !(user.latitude && user.longitude);
        const shouldPromptForLocation = locationProvidedOnLogin !== 'true' && hasDefaultLocation;

        if (shouldPromptForLocation) {
          console.log("Contractor has default location (0,0) - showing location permission modal");
          setShowLocationModal(true);
        } else {
          console.log("? Contractor already has location set:", { lat: user.latitude, lon: user.longitude });
        }
      } catch (err) {
        console.error("Error checking contractor location:", err);
      }
    })();
  }, [accessToken]);

  const handlePlanSelected = React.useCallback(async (planId: string) => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      console.log(`Premium plan selected: ${planId}`);
      // Optimistic UI so contractor sees premium section immediately after successful payment.
      setHasPremium(true);
      if (authUser?.premiumPlan) {
        setPremiumDetails(authUser.premiumPlan);
      }
      
      // Close modal
      setPremiumModalVisible(false);
      
      // Confirm premium status from backend (source of truth)
      const isActive = await fetchPremiumStatus();
      if (!isActive) {
        setHasPremium(false);
        setLeaderboard([]);
        return;
      }
      
      try {
        await fetchLeaderboardByDistrict({
          latitude: Number(authUser?.latitude || 0),
          longitude: Number(authUser?.longitude || 0),
          token: accessToken,
        });
        // Note: fetchLeaderboardByDistrict now handles setLeaderboard internally
        console.log('Fresh leaderboard fetched after premium purchase');
      } catch (err) {
        console.error('Error fetching fresh leaderboard after premium purchase:', (err as Error).message);
      }
    } catch (err) {
      console.warn('Could not complete premium plan selection:', (err as Error).message);
    }
  }, [accessToken, authUser?.latitude, authUser?.longitude, authUser?.premiumPlan, fetchLeaderboardByDistrict, fetchPremiumStatus]);

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={styles.container}
    >
      <View>
      {/* Header with Gradient */}
      <LinearGradient 
        colors={['#17263A', '#243B55']} 
        start={{ x: 0, y: 0 }} 
        end={{ x: 1, y: 1 }}
        style={styles.headerContainer}
      >
        <View style={styles.headerContent}>
          {/* ? Circular Profile Photo on Left */}
          <TouchableOpacity 
            onPress={() => router.push('/home/contractor/profile' as any)}
            style={styles.headerProfileContainer}
          >
            {userProfilePhoto ? (
              <Image source={userProfilePhoto} style={styles.headerProfilePhoto} />
            ) : (
              <View style={styles.headerProfilePlaceholder}>
                <MaterialIcons name="person" size={24} color="#FFFFFF" />
              </View>
            )}
          </TouchableOpacity>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.supportContainer}
              onPress={() => setSupportModalVisible(true)}
            >
              <MaterialIcons name="support-agent" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.bellContainer}
              onPress={() => router.push("/NotificationHistory" as any)}
            >
              <MaterialIcons name="notifications-none" size={24} color="#fff" />
              {notificationCount > 0 && ( // ? Show badge if unread notifications exist
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {notificationCount > 9 ? '9+' : notificationCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </LinearGradient>

      {/* Top cards (show only Jobs Posted + Completed on home screen) */}
      <View style={styles.topRow}>
        {topCards.slice(0, 2).map((card) => (
          <TouchableOpacity key={card.id} style={styles.card}>
            <LinearGradient 
              colors={['#17263A', '#243B55']} 
              style={styles.gradientCard}
            >
              <View style={styles.bubble1} />
              <View style={styles.bubble2} />
              <MaterialIcons name={card.icon as any} size={32} color="#fff" />
              <Text style={styles.amountTextWhite}>{card.amount}</Text>
              <Text style={styles.labelTextWhite}>{card.label}</Text>
            </LinearGradient>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bottom card - Dashboard */}
      <TouchableOpacity style={styles.fullWidthCard} onPress={() => router.navigate('../../dashboard' as any)}>
        <LinearGradient colors={['#17263A', '#243B55']} style={styles.gradientCard}>
          <View style={styles.bubble1} />
          <View style={styles.bubble2} />
          <MaterialIcons name={bottomCard.icon as any} size={32} color="#fff" />
          <Text style={styles.amountTextWhite}>{bottomCard.amount}</Text>
          <Text style={styles.labelTextWhite}>{bottomCard.label}</Text>
        </LinearGradient>
      </TouchableOpacity>

      </View>{/* end top-area wrapper used for measuring height */}

      {/* Scrollable Leaderboard with Premium Overlay */}
      <View
        style={[
          styles.leaderboardWrapper,
          leaderboardExpanded && styles.leaderboardWrapperExpanded,
        ]}
      >
        {/* Gradient Background */}
        <LinearGradient
          colors={['#f7f5ff', '#efe8ff']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={styles.leaderboardBackgroundGradient}
        />
        
        {/* Bubbles in background */}
        <View style={styles.leaderboardBubbles1} />
        {/* <View style={styles.leaderboardBubbles2} /> */}

        <View style={styles.leaderboardContent}>
          {/* Leaderboard Header with Title and Expand Button */}
          <View style={styles.leaderboardHeader}>
            <Text style={styles.leaderboardTitle}>Leadership Board</Text>
            {!premiumStatusLoading && hasPremium && (
              <TouchableOpacity 
                onPress={() => setLeaderboardExpanded(!leaderboardExpanded)}
                style={styles.expandButton}
              >
                <MaterialIcons 
                  name={leaderboardExpanded ? "close" : "expand-more"} 
                  size={18} 
                  color="#1f3a5f" 
                />
              </TouchableOpacity>
            )}
          </View>

          {/* Premium Unlock Banner - only show if user doesn't have premium */}
          {premiumStatusLoading && (
            <View style={styles.premiumBanner}>
              <Text style={styles.premiumBannerTitle}>Checking premium status...</Text>
              <View style={{ marginTop: 10, gap: 8 }}>
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#d6dbe1' }} />
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#e4e7eb', width: '88%' }} />
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#eef0f3', width: '70%' }} />
              </View>
            </View>
          )}

          {!premiumStatusLoading && !hasPremium && (
            <View style={styles.premiumBanner}>
              <MaterialIcons name="lock" size={32} color="#1f3a5f" />
              <Text style={styles.premiumBannerTitle}>Unlock Leadership Board</Text>
              <Text style={styles.premiumBannerSubtitle}>{getPremiumStatusMessage()}</Text>
              <TouchableOpacity style={styles.premiumBannerButton} onPress={handleUpgrade}>
                <Text style={styles.premiumBannerButtonText}>Upgrade Now</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Leaderboard cards - Current user on top - Only render if premium */}
          {!premiumStatusLoading && hasPremium && sortedLeaderboard.length > 0 && (
            <View>
              {/* Podium rendered outside the FlatList so it sits directly under the header */}
              <Animated.View style={[styles.topThreeContainer, { opacity: topAnim, transform: [{ translateY: topAnim.interpolate({ inputRange: [0,1], outputRange: [8,0] }) }] }]}
              >
                <View style={styles.topThreeInner}>
                  {second ? (
                    <View style={styles.topThreeItem}>
                      <View style={{ position: 'relative' }}>
                        {profileSourceSecond ? (
                          <Animated.Image source={typeof profileSourceSecond === 'string' ? { uri: profileSourceSecond } : profileSourceSecond} style={[styles.topThreeAvatar, { opacity: 1 }]} />
                        ) : (
                          <Animated.View style={[styles.topThreeAvatar, styles.topThreePlaceholder]}>
                            <Text style={styles.topThreeInitial}>{second.name?.charAt(0)}</Text>
                          </Animated.View>
                        )}
                        <View style={[styles.topBadge, { left: 2, top: -6 }]}>
                          <Text style={styles.topBadgeText}>2</Text>
                        </View>
                      </View>
                      <Text style={styles.topThreeName}>{second.name}</Text>
                      <Text style={styles.topThreePoints}>{second.points} points</Text>
                    </View>
                  ) : <View style={styles.topThreeItemPlaceholder} />}

                  {first ? (
                    <View style={[styles.topThreeItem, styles.topThreeCenter]}>
                      {/* crown removed */}
                      <View style={{ position: 'relative', alignItems: 'center' }}>
                        {profileSourceFirst ? (
                          <Animated.Image source={typeof profileSourceFirst === 'string' ? { uri: profileSourceFirst } : profileSourceFirst} style={[styles.topThreeAvatarLarge, { opacity: 1 }]} />
                        ) : (
                          <Animated.View style={[styles.topThreeAvatarLarge, styles.topThreePlaceholder]}>
                            <Text style={styles.topThreeInitial}>{first.name?.charAt(0)}</Text>
                          </Animated.View>
                        )}
                        <View style={[styles.topBadge, { top: -8 }]}> 
                          <Text style={styles.topBadgeText}>1</Text>
                        </View>
                      </View>
                      <Text style={[styles.topThreeName, styles.topThreeNameCenter]}>{first.name}</Text>
                      <Text style={[styles.topThreePoints, styles.topThreePointsCenter]}>{first.points} points</Text>
                    </View>
                  ) : <View style={styles.topThreeItemPlaceholder} />}

                  {third ? (
                    <View style={styles.topThreeItem}>
                      <View style={{ position: 'relative' }}>
                        {profileSourceThird ? (
                          <Animated.Image source={typeof profileSourceThird === 'string' ? { uri: profileSourceThird } : profileSourceThird} style={[styles.topThreeAvatar, { opacity: 1 }]} />
                        ) : (
                          <Animated.View style={[styles.topThreeAvatar, styles.topThreePlaceholder]}>
                            <Text style={styles.topThreeInitial}>{third.name?.charAt(0)}</Text>
                          </Animated.View>
                        )}
                        <View style={[styles.topBadge, { right: 2, top: -6 }]}>
                          <Text style={styles.topBadgeText}>3</Text>
                        </View>
                      </View>
                      <Text style={styles.topThreeName}>{third.name}</Text>
                      <Text style={styles.topThreePoints}>{third.points} points</Text>
                    </View>
                  ) : <View style={styles.topThreeItemPlaceholder} />}
                </View>
              </Animated.View>

                <FlatList
                ref={remainingListRef}
                onScroll={onListScroll}
                scrollEventThrottle={16}
                data={remainingList}
                keyExtractor={(person: any) => String(person.id)}
                style={styles.leaderboardScroll}
                contentContainerStyle={{ paddingBottom: 0 }}
                showsVerticalScrollIndicator={false}
                initialNumToRender={6}
                ListHeaderComponent={() => (
                  <View style={[styles.tableHeader, { marginTop: 6 }]}> 
                    <Text style={styles.tableHeaderText}>Rank</Text>
                    <Text style={[styles.tableHeaderText, { flex: 1, textAlign: 'center' }]}>Player</Text>
                    <Text style={[styles.tableHeaderText, { textAlign: 'right' }]}>Points</Text>
                  </View>
                )}
                stickyHeaderIndices={[0]}
                renderItem={({ item: person, index }: { item: any; index: number }) => {
                  const isCurrent = Boolean(currentUserPhone && (person.id === currentUserPhone || person.phone === currentUserPhone));
                  const displayProfile = avatarSourceForEntry(person, (person?.rank || (index + 4)));

                  const anim = rowAnimsRef.current[index] || new Animated.Value(1);
                  return (
                    <Animated.View
                      style={[
                        styles.purpleRow,
                        {
                          opacity: anim,
                          transform: [
                            {
                              translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }),
                            },
                          ],
                        },
                      ]}
                    >
                      <View style={styles.rowLeft}>
                        <View style={styles.rowRankCircle}><Text style={styles.rowRankText}>{person.rank}</Text></View>
                        {displayProfile ? (
                          <Image source={typeof displayProfile === 'string' ? { uri: displayProfile } : displayProfile} style={styles.rowAvatar} />
                        ) : (
                          <View style={[styles.rowAvatar, styles.topThreePlaceholder]}>
                            <Text style={styles.topThreeInitial}>{person.name?.charAt(0)}</Text>
                          </View>
                        )}
                        <Text style={styles.rowNameText}>{person.name}{isCurrent ? ' (You)' : ''}</Text>
                      </View>
                        <Text style={styles.rowPointsText}>{person.points} points</Text>
                    </Animated.View>
                  );
                }}
              />

              {/* Load More Button */}
              {leaderboardPagination.hasNextPage && (
                <TouchableOpacity
                  style={styles.loadMoreButton}
                  onPress={loadMoreLeaderboard}
                  disabled={leaderboardPagination.loading}
                >
                  {leaderboardPagination.loading ? (
                    <Text style={styles.loadMoreButtonText}>Loading...</Text>
                  ) : (
                    <Text style={styles.loadMoreButtonText}>
                      Load More ({leaderboardPagination.page}/{leaderboardPagination.totalPages})
                    </Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      </View>

      {/* Premium Plans Modal */}
      <PremiumPlansModal
        visible={premiumModalVisible}
        onClose={() => setPremiumModalVisible(false)}
        onPlanSelected={handlePlanSelected}
      />

      <Modal visible={supportModalVisible} transparent animationType="fade" onRequestClose={() => setSupportModalVisible(false)}>
        <TouchableOpacity style={styles.supportModalOverlay} activeOpacity={1} onPress={() => setSupportModalVisible(false)}>
          <View style={styles.supportModalCard}>
            <MaterialIcons name="support-agent" size={28} color="#e74c3c" />
            <Text style={styles.supportModalTitle}>Support</Text>
            <Text style={styles.supportModalText}>Support will call you shortly.</Text>
            <TouchableOpacity style={styles.supportModalBtn} onPress={() => setSupportModalVisible(false)}>
              <Text style={styles.supportModalBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ? POST-LOGIN LOCATION PERMISSION MODAL FOR CONTRACTOR */}
      <Modal visible={showLocationModal} transparent animationType="fade">
        <TouchableOpacity 
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}
          activeOpacity={1}
        >
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <TouchableOpacity 
              style={{ 
                backgroundColor: '#fff', 
                borderRadius: 16, 
                padding: 24, 
                width: '100%',
                maxWidth: 350,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 3.84,
                elevation: 5,
              }}
              onPress={(e) => e.stopPropagation()}
            >
              {/* Icon */}
              <View style={{ alignItems: 'center', marginBottom: 16 }}>
                <MaterialIcons name="location-on" size={48} color="#3498db" />
              </View>

              {/* Title */}
              <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a2f4d', textAlign: 'center', marginBottom: 8 }}>
                Enable Location
              </Text>

              {/* Subtitle */}
              <Text style={{ fontSize: 14, color: '#7f8c8d', textAlign: 'center', marginBottom: 20 }}>
                We need your location to match you with nearby workers and to provide location-based job recommendations.
              </Text>

              {/* Enable Button */}
              <TouchableOpacity 
                style={{ 
                  backgroundColor: '#3498db', 
                  borderRadius: 10, 
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 10,
                  opacity: requestingLocation ? 0.6 : 1,
                }}
                onPress={requestAndUpdateLocation}
                disabled={requestingLocation}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  {requestingLocation ? 'Getting Location...' : 'Enable Location'}
                </Text>
              </TouchableOpacity>

              {/* Skip Button */}
              <TouchableOpacity 
                style={{ 
                  borderWidth: 1.5,
                  borderColor: '#bdc3c7',
                  borderRadius: 10, 
                  paddingVertical: 12,
                  alignItems: 'center',
                }}
                onPress={() => setShowLocationModal(false)}
                disabled={requestingLocation}
              >
                <Text style={{ color: '#7f8c8d', fontSize: 14, fontWeight: '700' }}>
                  Skip for Now
                </Text>
              </TouchableOpacity>

              {/* Info Text */}
              <Text style={{ fontSize: 12, color: '#95a5a6', textAlign: 'center', marginTop: 16 }}>
                You can enable location anytime in Settings
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}




