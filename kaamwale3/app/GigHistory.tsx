import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  FlatList,
  RefreshControl,
  Platform,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import { useAuth } from '../context/AuthContext';
import { API_BASE } from '../utils/config';
import { LinearGradient } from 'expo-linear-gradient';
import { useLanguage } from '../context/LanguageContext';
import { connectSocket, socket } from '../utils/socket';
import { translations } from '../constants/translations';

const logActivity = async (token: string | null, action: string, details: string) => {
  try {
    await fetch(`${API_BASE}/activity/log`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action,
        details,
        timestamp: new Date(),
      }),
    });
  } catch (err) {
    console.error('Activity log error:', err);
  }
};

interface GigHistoryItem {
  _id: string;
  title: string;
  amount: number;
  status: string;
  paymentStatus: string;
  attendanceStatus: string;
  acceptedWorkers?: Array<{
    paymentStatus?: string;
  }>;
  contractorName: string;
  date: string;
  rating?: {
    stars: number;
    feedback: string;
  };
  acceptedAt: string;
  paymentTime: string;
  description?: string;
  location?: string;
  skills?: string[];
  workDuration?: string;
  hoursWorked?: number;
  timeSpentMinutes?: number;
}

interface FiveDayStatus {
  date: string;
  jobsCompleted: number;
  hoursWorked: number;
  hasCompletedJob: boolean;
  meetsMinimumHours: boolean;
  meetsNoDeclines?: boolean;
  dayQualified?: boolean;
}

interface IncentiveProgress {
  consecutiveDays: number;
  totalHours: number;
  cancellationsInWindow: number;
  dailyQualificationTrail?: Array<{
    date: string;
    jobsCompleted?: number;
    hoursWorked?: number;
    declinesCount?: number;
    hasCompletedJob?: boolean;
    meetsMinimumHours?: boolean;
    meetsNoDeclines?: boolean;
    qualified?: boolean;
  }>;
  requiredDailyHours?: number;
  requiredDaysFor5?: number;
  fiveDayWindow?: {
    requiredDays: number;
    requiredDailyHours: number;
    daysMetMinimumHours: number;
    allDaysHaveMinHours: boolean;
    startDate: string | null;
    endDate: string | null;
    dailyStatus: FiveDayStatus[];
    failedDates: string[];
    failureReason: string | null;
  } | null;
  eligibleFor5Days: boolean;
  eligibleFor10Days: boolean;
  eligibleFor20Days: boolean;
  unlockedMilestones: string[];
  claimedMilestones: string[];
  availableMilestones: string[];
  lastWorkDate: string | null;
  error?: string;
}

interface Milestone {
  id: string;
  days: number;
  reward: number;
  icon: string;
  color: string;
  completed: boolean;
  claimed: boolean;
  progress: number;
}

export default function GigHistory() {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken } = useAuth();

  const tx = useCallback(
    (key: keyof typeof translations.en, fallback: string) => {
      const value = t(key);
      return value === key ? fallback : value;
    },
    [t]
  );

  const [gigs, setGigs] = useState<GigHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [incentiveData, setIncentiveData] = useState<IncentiveProgress | null>(null);
  const [gigError, setGigError] = useState<string | null>(null);
  const [incentiveLoading, setIncentiveLoading] = useState(false);
  const [incentiveError, setIncentiveError] = useState<string | null>(null);
  const [dayTick, setDayTick] = useState(0);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [isLiveRefreshing, setIsLiveRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [milestones, setMilestones] = useState<Milestone[]>([
    { id: '5days', days: 5, reward: 50, icon: 'local-fire-department', color: '#FF6B6B', completed: false, claimed: false, progress: 0 },
    { id: '10days', days: 10, reward: 150, icon: 'star', color: '#FFD93D', completed: false, claimed: false, progress: 0 },
    { id: '20days', days: 20, reward: 300, icon: 'favorite', color: '#FF1493', completed: false, claimed: false, progress: 0 },
  ]);

  const gigsAbortRef = useRef<AbortController | null>(null);
  const incentiveAbortRef = useRef<AbortController | null>(null);
  const realtimeRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRealtimeRefreshingRef = useRef(false);
  const incentiveRequestIdRef = useRef<number | null>(null);
  const gigsRequestIdRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);
  // v2 removed: the backend `/incentives/progress` (v1) is authoritative
  const loadingMoreRef = useRef(false);
  const simpleModalVisibleRef = useRef(false);
  const scheduleRef = useRef<() => void>(() => {});
  const [simpleModalVisible, setSimpleModalVisible] = useState(false);
  const [simpleModalTitle, setSimpleModalTitle] = useState('');
  const [simpleModalMessage, setSimpleModalMessage] = useState('');
  const [fiveDayModalVisible, setFiveDayModalVisible] = useState(false);

  const buildFallbackIncentiveData = useCallback(
    (reason?: string): IncentiveProgress => ({
      consecutiveDays: 0,
      totalHours: 0,
      cancellationsInWindow: 0,
      requiredDailyHours: 8,
      requiredDaysFor5: 5,
      fiveDayWindow: {
        requiredDays: 5,
        requiredDailyHours: 8,
        daysMetMinimumHours: 0,
        allDaysHaveMinHours: false,
        startDate: null,
        endDate: null,
        dailyStatus: [],
        failedDates: [],
        failureReason: reason || tx('noCompletedPaidJobHistoryFound', 'No completed paid job history found'),
      },
      eligibleFor5Days: false,
      eligibleFor10Days: false,
      eligibleFor20Days: false,
      unlockedMilestones: [],
      claimedMilestones: [],
      availableMilestones: [],
      lastWorkDate: null,
    }),
    [tx]
  );

  const getGigPaymentStatus = useCallback((gig: GigHistoryItem) => {
    return String(gig.paymentStatus || '').toLowerCase() === 'paid' ? 'paid' : 'pending';
  }, []);

  const todayWorkedMinutes = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();

    return gigs.reduce((sum, gig) => {
      const isPaid = getGigPaymentStatus(gig) === 'paid';
      const isCompleted = String(gig.status || '').toLowerCase() === 'completed';
      // Count gig minutes for today if the gig is completed OR paid (allow completed but unpaid to show today's progress)
      if (!isPaid && !isCompleted) return sum;

      const sourceDate = gig.paymentTime || gig.date || gig.acceptedAt;
      if (!sourceDate) return sum;
      const timestamp = new Date(sourceDate);
      if (Number.isNaN(timestamp.getTime())) return sum;
      if (timestamp.getFullYear() !== year || timestamp.getMonth() !== month || timestamp.getDate() !== day) return sum;

      const explicitMinutes = Number(gig.timeSpentMinutes || 0);
      if (explicitMinutes > 0) return sum + explicitMinutes;
      return sum + Math.max(0, Math.round((Number(gig.hoursWorked || 0) || 0) * 60));
    }, 0);
  }, [gigs, dayTick]);

  const fetchGigHistory = useCallback(
    async (pageNum: number = 1, isFresh: boolean = true) => {
      const reqId = Date.now();
      gigsRequestIdRef.current = reqId;
      try {
        if (isFresh) setLoading(true);
        else setLoadingMore(true);
        setGigError(null);

        if (!accessToken) {
          setGigError(tx('notAuthenticated', 'Not authenticated'));
          return;
        }

        gigsAbortRef.current = new AbortController();

        const response = await fetch(`${API_BASE}/jobs/my-accepted?page=${pageNum}&limit=20`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: gigsAbortRef.current.signal,
        });

        if (response.status === 401) {
          if (isMountedRef.current) {
              const message = tx('sessionExpiredPleaseLoginAgain', 'Your session has expired. Please log in again.');
              setGigError(message);
              // show simple modal once to avoid repeated native alerts spamming the user
              if (!simpleModalVisibleRef.current) {
                simpleModalVisibleRef.current = true;
                setSimpleModalTitle(tx('sessionExpiredTitle', 'Session Expired'));
                setSimpleModalMessage(message);
                setSimpleModalVisible(true);
              }
          }
          return;
        }

        if (!response.ok) {
          if (isMountedRef.current) {
            setGigError(tx('failedToLoadGigsPullToRefresh', 'Failed to load gigs. Pull to refresh.'));
          }
          return;
        }

        const data = await response.json();
        if (!isMountedRef.current) return;

        // Only apply response if this is the latest request
        if (gigsRequestIdRef.current !== reqId) return;

        const gigsData = data.gigs || (Array.isArray(data) ? data : []);
        if (isFresh) setGigs(gigsData);
        else setGigs((prev) => [...prev, ...gigsData]);

        setHasMore(data.hasMore !== undefined ? data.hasMore : gigsData.length === 20);
        setPage(pageNum);
        setLastUpdatedAt(new Date());

        await logActivity(accessToken, 'GIG_HISTORY_VIEWED', 'User viewed their gig history');
      } catch (err: any) {
        if (err.name === 'AbortError') return;
        if (isMountedRef.current) {
          console.error('Error fetching gig history:', err);
          setGigError(tx('failedToLoadGigsPullToRefresh', 'Failed to load gigs. Pull to refresh.'));
        }
      } finally {
          if (isMountedRef.current) {
            // only update loading state if this is the latest request
            if (gigsRequestIdRef.current === reqId) {
              setLoading(false);
              setLoadingMore(false);
              loadingMoreRef.current = false;
            }
          }
      }
    },
    [accessToken, router, tx]
  );

  const fetchIncentiveProgress = useCallback(async () => {
    const reqId = Date.now();
    incentiveRequestIdRef.current = reqId;
    try {
      setIncentiveLoading(true);
      setIncentiveError(null);

      if (!accessToken) {
        setIncentiveData(buildFallbackIncentiveData(tx('notAuthenticated', 'Not authenticated')));
        return;
      }

      incentiveAbortRef.current = new AbortController();

      // Use authoritative v1 endpoint
      const response = await fetch(`${API_BASE}/incentives/progress`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: incentiveAbortRef.current.signal,
      });

      if (response.status === 401) {
        if (isMountedRef.current) {
          setIncentiveData(buildFallbackIncentiveData(tx('pleaseLoginToViewIncentives', 'Please log in to view incentives')));
        }
        return;
      }

      if (response.ok) {
        const result = await response.json();
        if (!isMountedRef.current) return;

        // only apply if this is the latest incentive request
        if (incentiveRequestIdRef.current !== reqId) return;

        // legacy v1 response (authoritative)
        const data: IncentiveProgress = result;
        setIncentiveData(data);
        setLastUpdatedAt(new Date());
        setMilestones((prev) =>
          prev.map((milestone) => {
            const prevItem = prev.find((p) => p.id === milestone.id);
            const days = milestone.days || 1;

            // If server explicitly marks eligible, consider fully progressed
            const eligibleFlag = days === 5 ? data.eligibleFor5Days : days === 10 ? data.eligibleFor10Days : days === 20 ? data.eligibleFor20Days : false;

            // Compute progress using server dailyQualificationTrail and lastWorkDate to ensure calendar-day alignment
            let qualifiedCount = 0;
            try {
              const trail = Array.isArray(data.dailyQualificationTrail) ? data.dailyQualificationTrail : [];
              const lastKey = data.lastWorkDate;
              if (lastKey) {
                const toDateKey = (d: Date) => {
                  try {
                    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
                  } catch (e) {
                    return d.toISOString().slice(0, 10);
                  }
                };
                const latest = new Date(`${lastKey}T00:00:00.000+05:30`);
                for (let i = 0; i < days; i++) {
                  const check = new Date(latest);
                  check.setDate(latest.getDate() - i);
                  const key = toDateKey(check);
                  const entry = trail.find((r: any) => String(r.date || '') === String(key));
                  if (entry && entry.qualified) qualifiedCount++;
                }
              }
            } catch (e) {
              qualifiedCount = 0;
            }

            const computedProgress = days > 0 ? Math.min(qualifiedCount / days, 1) : 0;
            const progress = eligibleFlag ? 1 : computedProgress;

            return {
              ...milestone,
              progress,
              completed: (prevItem?.completed ?? false) || (data.unlockedMilestones?.includes(milestone.id) || false),
              claimed: (prevItem?.claimed ?? false) || (data.claimedMilestones?.includes(milestone.id) || false),
            };
          })
        );
        return;
      }

      const errData = await response.json().catch(() => ({}));
      if (isMountedRef.current) {
        setIncentiveData(buildFallbackIncentiveData(errData.message || tx('failedToLoadIncentiveData', 'Failed to load incentive data')));
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      if (isMountedRef.current) {
        console.error('Error fetching incentive progress:', err);
        setIncentiveData(buildFallbackIncentiveData(tx('failedToLoadIncentiveData', 'Failed to load incentive data')));
      }
    } finally {
      if (isMountedRef.current) {
        if (incentiveRequestIdRef.current === reqId) setIncentiveLoading(false);
      }
    }
  }, [accessToken, buildFallbackIncentiveData, tx]);

  const refreshAll = useCallback(
    async ({ showPullRefresh = false, showLiveRefresh = false }: { showPullRefresh?: boolean; showLiveRefresh?: boolean } = {}) => {
      if (showPullRefresh && isMountedRef.current) setRefreshing(true);
      if (showLiveRefresh && isMountedRef.current) setIsLiveRefreshing(true);

      try {
        setPage(1);
        // Run sequentially to avoid race conditions where independent responses overwrite each other
        await fetchGigHistory(1, true);
        await fetchIncentiveProgress();
      } finally {
        if (isMountedRef.current) {
          if (showPullRefresh) setRefreshing(false);
          if (showLiveRefresh) setIsLiveRefreshing(false);
        }
      }
    },
    [fetchGigHistory, fetchIncentiveProgress]
  );

  const scheduleRealtimeRefresh = useCallback(() => {
    if (isRealtimeRefreshingRef.current) return;
    if (realtimeRefreshTimeoutRef.current) clearTimeout(realtimeRefreshTimeoutRef.current);

    realtimeRefreshTimeoutRef.current = setTimeout(async () => {
      isRealtimeRefreshingRef.current = true;
      try {
        await refreshAll({ showLiveRefresh: true });
      } finally {
        isRealtimeRefreshingRef.current = false;
      }
    }, 500);
  }, [refreshAll]);

  useFocusEffect(
    useCallback(() => {
      isMountedRef.current = true;
      refreshAll();
      return () => {
        isMountedRef.current = false;
      };
    }, [refreshAll])
  );

  useEffect(() => {
    if (!accessToken) return;

    try {
      if (!socket || !socket.connected) {
        connectSocket();
      }
    } catch (e) {
      console.warn('Socket connect check failed', e);
    }
    // Keep a stable scheduleRef that always points to the latest scheduler function
    scheduleRef.current = scheduleRealtimeRefresh;

    // Stable handler that uses scheduleRef to call the latest scheduler without re-registering listeners
    const stableHandler = () => {
      if (!isMountedRef.current) return;
      try {
        scheduleRef.current();
      } catch (e) {
        console.warn('Live refresh handler error', e);
      }
    };

    // Ensure we don't register duplicate handlers: remove prior then add (safe even if not present)
    socket.off('jobUpdated', stableHandler);
    socket.off('walletUpdated', stableHandler);
    socket.off('workerStatusUpdate', stableHandler);
    socket.off('incentiveUpdated', stableHandler);

    socket.on('jobUpdated', stableHandler);
    socket.on('walletUpdated', stableHandler);
    socket.on('workerStatusUpdate', stableHandler);
    socket.on('incentiveUpdated', stableHandler);

    return () => {
      socket.off('jobUpdated', stableHandler);
      socket.off('walletUpdated', stableHandler);
      socket.off('workerStatusUpdate', stableHandler);
      // Do NOT disconnect socket here; app-level socket handler should manage connection lifecycle
    };
  }, [accessToken, scheduleRealtimeRefresh]);

  const handleLoadMore = () => {
    if (!loadingMoreRef.current && hasMore) {
      loadingMoreRef.current = true;
      fetchGigHistory(page + 1, false).finally(() => {
        loadingMoreRef.current = false;
      });
    }
  };

  const onRefresh = async () => {
    await refreshAll({ showPullRefresh: true });
  };

  // Ensure today's minutes recompute at local midnight
  useEffect(() => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(24, 0, 0, 0);
    const msUntilMidnight = next.getTime() - now.getTime();
    const t = setTimeout(() => {
      try {
        setDayTick((d) => d + 1);
      } finally {
        // schedule daily tick thereafter
        const daily = setInterval(() => setDayTick((d) => d + 1), 24 * 60 * 60 * 1000);
        (realtimeRefreshTimeoutRef.current as any) = daily;
      }
    }, msUntilMidnight + 50);

    return () => {
      clearTimeout(t);
      if (realtimeRefreshTimeoutRef.current) {
        clearInterval(realtimeRefreshTimeoutRef.current as any);
        realtimeRefreshTimeoutRef.current = null;
      }
    };
  }, []);

  const claimMilestone = async (milestoneId: string) => {
    if (claimingId) {
      Alert.alert(tx('processing', 'Processing'), tx('pleaseWaitCurrentClaim', 'Please wait for the current claim to complete'));
      return;
    }

    const rewardAmount = milestones.find((milestone) => milestone.id === milestoneId)?.reward || 0;

    Alert.alert(tx('claimReward', 'Claim Reward'), `${tx('claimRewardPrompt', 'Claim')} ₹${rewardAmount} ${tx('reward', 'reward')}?`, [
      { text: t('cancel') },
      {
        text: tx('claim', 'Claim'),
        onPress: async () => {
          setClaimingId(milestoneId);
          try {
            const response = await fetch(`${API_BASE}/incentives/claim/${milestoneId}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (response.status === 401) {
              Alert.alert(tx('sessionExpiredTitle', 'Session Expired'), tx('pleaseLoginAgain', 'Please log in again'), [
                { text: tx('ok', 'OK'), onPress: () => router.push('/') },
              ]);
              return;
            }

            const data = await response.json();
            if (data.success) {
              Alert.alert(tx('success', 'Success'), `₹${data.rewardAmount} ${tx('addedToWallet', 'added to your wallet!')}`);
              await refreshAll({ showLiveRefresh: true });
            } else if (response.status === 403) {
              Alert.alert(tx('notEligible', 'Not Eligible'), data.message || tx('notEligibleForRewardYet', 'You are not eligible for this reward yet'));
            } else {
              Alert.alert(tx('error', 'Error'), data.message || tx('failedToClaimReward', 'Failed to claim reward'));
            }
          } catch (err) {
            console.error('Error claiming milestone:', err);
            Alert.alert(tx('error', 'Error'), tx('failedToClaimReward', 'Failed to claim reward'));
          } finally {
            setClaimingId(null);
          }
        },
      },
    ]);
  };

  const formatDate = (date: string) => {
    try {
      return new Date(date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return tx('notAvailable', 'N/A');
    }
  };

  const getStatusColor = (status: string) => {
    switch ((status || '').toLowerCase()) {
      case 'paid':
      case 'completed':
        return '#27AE60';
      case 'pending':
        return '#F39C12';
      case 'cancelled':
        return '#E74C3C';
      default:
        return '#95A5A6';
    }
  };

  const getStatusIcon = (status: string) => {
    switch ((status || '').toLowerCase()) {
      case 'paid':
      case 'completed':
        return 'check-circle';
      case 'pending':
        return 'schedule';
      case 'cancelled':
        return 'cancel';
      default:
        return 'info';
    }
  };

  const formatHoursDotMinutes = (minutes: number | null | undefined) => {
    const mins = Math.max(0, Number(minutes || 0));
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${hrs}.${String(Math.round((rem / 60) * 10)).padStart(1, '0')}`;
  };

  const getFiveDayFailureMessage = (data: IncentiveProgress) => {
    const fiveDayWindow = data.fiveDayWindow;
    if (!fiveDayWindow) return null;
    if (data.cancellationsInWindow > 0) {
      return `${tx('declinesCancellationsInWindow', 'Declines/cancellations in streak window')}: ${data.cancellationsInWindow}`;
    }
    // Do not show the verbose failed-dates list in the UI (privacy/clarity)
    if (fiveDayWindow.failedDates?.length) {
      return null;
    }
    if (fiveDayWindow.failureReason && fiveDayWindow.failureReason.toLowerCase().includes('no completed')) {
      return tx('noCompletedPaidJobHistoryFound', 'No completed paid job history found');
    }
    return fiveDayWindow.failureReason || null;
  };

  const renderIncentiveHeader = () => (
    <LinearGradient
      colors={['#667EEA', '#764BA2']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.incentiveHeader}
    >
      <View style={styles.incentiveContent}>
        <View style={styles.incentiveInfo}>
          <Text style={styles.incentiveTitle}>{t('earnIncentives')}</Text>
          <Text style={styles.incentiveSubtitle}>{t('completeTasksToUnlockRewards')}</Text>
        </View>

        {incentiveLoading ? (
          <ActivityIndicator color="#fff" />
        ) : incentiveData ? (
          <View style={styles.incentiveStats}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{incentiveData.consecutiveDays}</Text>
              <Text style={styles.statLabel}>{tx('days', 'Days')}</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatHoursDotMinutes(todayWorkedMinutes)}</Text>
              <Text style={styles.statLabel}>{t('hours')}</Text>
            </View>
          </View>
          ) : null}

        {/* Next milestone hint */}
        {incentiveData ? (() => {
          const nextMilestone = milestones.find(m => !m.completed && !m.claimed);
          if (!nextMilestone) return null;
          const remainingDays = Math.max(0, nextMilestone.days - (incentiveData.consecutiveDays || 0));
          const requiredDailyHours = incentiveData.requiredDailyHours || 8;
          const hoursToday = (todayWorkedMinutes ?? 0) / 60;
          const hoursNeededToday = Math.max(0, requiredDailyHours - hoursToday);
          return (
            <View style={{ marginTop: 8 }}>
              <Text style={{ color: '#E8EAFF', fontSize: 13, fontWeight: '700' }}>{`You need ${remainingDays} more day${remainingDays===1?'':'s'} with ${requiredDailyHours}h to unlock ₹${nextMilestone.reward}`}</Text>
              {hoursNeededToday > 0 ? (
                <Text style={{ color: '#E8EAFF', fontSize: 12, marginTop: 4 }}>{`Today: ${hoursNeededToday.toFixed(1)}h remaining towards today's ${requiredDailyHours}h`}</Text>
              ) : null}
            </View>
          );
        })() : null}

        <View style={styles.liveRow}>
          <View style={styles.liveBadge}>
            <View style={[styles.liveDot, isLiveRefreshing ? styles.liveDotRefreshing : null]} />
            <Text style={styles.liveBadgeText}>
              {isLiveRefreshing ? tx('refreshingLive', 'Refreshing live...') : tx('liveUpdatesOn', 'Live updates on')}
            </Text>
          </View>
          {lastUpdatedAt ? (
            <Text style={styles.lastUpdatedText}>
              {tx('updatedNow', 'Updated')} {lastUpdatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          ) : null}
        </View>
      </View>
    </LinearGradient>
  );

  const renderConditionsCard = () => {
    const safeIncentiveData = incentiveData || buildFallbackIncentiveData(incentiveError || undefined);
    const fiveDayWindow = safeIncentiveData.fiveDayWindow;
    const failureMessage = getFiveDayFailureMessage(safeIncentiveData);

    // backend v1 is authoritative for reasons
    let streakBroken = Boolean((safeIncentiveData.cancellationsInWindow || 0) > 0 || (fiveDayWindow?.failedDates && fiveDayWindow.failedDates.length > 0) || (fiveDayWindow?.failureReason && /fail|no completed|not met/i.test(String(fiveDayWindow.failureReason))));

    return (
      <View style={styles.conditionsCard}>
        <Text style={styles.conditionsTitle}>
          {t('requirementsStatus')} - 5 {tx('day', 'Day')} {tx('milestone', 'Milestone')}
        </Text>

        {streakBroken ? (
          <View style={styles.streakBrokenBanner}>
            <MaterialIcons name="cancel" size={20} color="#fff" />
            <Text style={styles.streakBrokenText}>{tx('streakBroken' as any, 'Streak Broken')}</Text>
          </View>
        ) : null}

        <View style={styles.conditionsList}>
          <View style={[styles.condition, { borderLeftColor: safeIncentiveData.consecutiveDays >= 5 ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons
              name={safeIncentiveData.consecutiveDays >= 5 ? 'check-circle' : 'cancel'}
              size={24}
              color={safeIncentiveData.consecutiveDays >= 5 ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>{t('consecutiveDays')}</Text>
              <Text style={styles.conditionValue}>
                {safeIncentiveData.consecutiveDays}/5 {tx('days', 'days')}
              </Text>
            </View>
          </View>

          <View style={[styles.condition, { borderLeftColor: fiveDayWindow?.allDaysHaveMinHours ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons
              name={fiveDayWindow?.allDaysHaveMinHours ? 'check-circle' : 'cancel'}
              size={24}
              color={fiveDayWindow?.allDaysHaveMinHours ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>{t('hoursPerDay')}</Text>
              <Text style={styles.conditionValue}>
                {fiveDayWindow?.daysMetMinimumHours || 0}/{safeIncentiveData.requiredDaysFor5 || 5} {tx('days', 'days')} {tx('metMinimum', 'met')} ({(safeIncentiveData.requiredDailyHours || 8)}{tx('hoursPerDayShort', 'h/day')})
              </Text>
              {failureMessage ? <Text style={styles.conditionError}>{failureMessage}</Text> : null}
            </View>
          </View>

          <View style={[styles.condition, { borderLeftColor: safeIncentiveData.cancellationsInWindow === 0 ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons
              name={safeIncentiveData.cancellationsInWindow === 0 ? 'check-circle' : 'cancel'}
              size={24}
              color={safeIncentiveData.cancellationsInWindow === 0 ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>{tx('noDeclinesOrCancellations', 'No Declines/Cancellations')}</Text>
              <Text style={styles.conditionValue}>
                {safeIncentiveData.cancellationsInWindow} {tx('jobDeclinesOrCancellations', 'job declines/cancellations')} ({safeIncentiveData.cancellationsInWindow === 0 ? tx('pass', 'Pass') : tx('failed', 'Failed')})
              </Text>
            </View>
          </View>
        </View>

        {/** Replace inline breakdown with an info icon that opens a modal */}
        <View style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <TouchableOpacity onPress={() => setFiveDayModalVisible(true)} style={{ padding: 6 }}>
            <MaterialIcons name="info" size={18} color="#6B7280" />
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  const renderFiveDayModal = () => {
    const safeIncentiveData = incentiveData || buildFallbackIncentiveData(incentiveError || undefined);
    const fiveDayWindow = safeIncentiveData.fiveDayWindow;
    return (
      <Modal transparent visible={fiveDayModalVisible} animationType="slide" onRequestClose={() => setFiveDayModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContainer, { maxWidth: 520 }]}>
            <View style={[styles.modalHeader, { backgroundColor: '#EEF2FF' }]}>
              <View style={[styles.modalIconBg, { backgroundColor: '#667EEA' }]}>
                <MaterialIcons name="today" size={28} color="#fff" />
              </View>
            </View>
            <View style={[styles.modalContent, { alignItems: 'flex-start' }]}>
              <Text style={[styles.modalTitle, { color: '#111827' }]}>{tx('recent5DayBreakdown', 'Recent 5-day breakdown')}</Text>
              <View style={{ width: '100%', marginTop: 8 }}>
                {fiveDayWindow?.dailyStatus?.length ? (
                  fiveDayWindow.dailyStatus.map((dayStatus) => {
                    const isQualified = Boolean(dayStatus.dayQualified ?? (dayStatus.meetsMinimumHours && dayStatus.meetsNoDeclines !== false));
                    const reasons: string[] = Array.isArray((dayStatus as any).reasons) ? (dayStatus as any).reasons : [];
                    const reasonText = reasons.length
                      ? reasons
                          .map((r) => (String(r).toUpperCase().includes('CANCEL') ? tx('cancelled', 'Cancelled') : tx('lowHours' as any, 'Less than required hours')))
                          .join(', ')
                      : null;
                    return (
                      <View key={dayStatus.date} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#F3F4F6' }}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.dailyDate}>{formatDate(dayStatus.date)}</Text>
                          {reasonText ? <Text style={[styles.conditionError, { marginTop: 4 }]}>{reasonText}</Text> : null}
                        </View>
                        <Text style={[styles.dailyHours, { color: isQualified ? '#27AE60' : '#E74C3C' }]}>
                          {Number(dayStatus.hoursWorked || 0).toFixed(1)}{tx('hoursShort', 'h')} · {isQualified ? tx('qualified', 'Qualified') : tx('notQualified', 'Not Qualified')}
                        </Text>
                      </View>
                    );
                  })
                ) : (
                  <Text style={{ color: '#6B7280' }}>{tx('noRecentData', 'No recent data')}</Text>
                )}
              </View>
            </View>
            <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#667EEA' }]} onPress={() => setFiveDayModalVisible(false)}>
              <Text style={styles.modalButtonText}>{tx('close', 'Close')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  const renderMilestoneCard = (milestone: Milestone) => (
    <View key={milestone.id} style={styles.milestoneCard}>
      <LinearGradient
        colors={[`${milestone.color}20`, `${milestone.color}08`]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.milestoneGradient}
      >
        <View style={styles.milestoneHeader}>
          <View style={[styles.milestoneIcon, { backgroundColor: milestone.color }]}>
            <MaterialIcons name={milestone.icon as any} size={24} color="#fff" />
          </View>
          <View style={styles.milestoneInfo}>
            <Text style={styles.milestoneTitle}>{milestone.days} {t('daysChallenge')}</Text>
            <Text style={styles.milestoneReward}>₹{milestone.reward} {t('reward')}</Text>
          </View>
          {milestone.claimed ? (
            <View style={styles.completedBadge}>
              <MaterialIcons name="check-circle" size={28} color="#27AE60" />
            </View>
          ) : null}
        </View>

        {!milestone.claimed ? (
          <>
            <View style={styles.progressSection}>
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    {
                      width: `${Math.min(milestone.progress * 100, 100)}%`,
                      backgroundColor: milestone.color,
                    },
                  ]}
                />
              </View>
              <Text style={styles.progressText}>
                {Math.round(milestone.progress * 100)}% {tx('complete', 'Complete')}
              </Text>
            </View>

            <Text style={styles.ruleText}>
              {tx('streakRuleShort', 'Needs consecutive 8h days with no declines/cancellations')}
            </Text>

            {milestone.completed ? (
              <TouchableOpacity
                style={[
                  styles.claimButton,
                  {
                    backgroundColor: milestone.color,
                    opacity: claimingId === milestone.id ? 0.6 : 1,
                  },
                ]}
                onPress={() => claimMilestone(milestone.id)}
                disabled={claimingId === milestone.id}
              >
                <MaterialIcons name="card-giftcard" size={20} color="#fff" />
                <Text style={styles.claimButtonText}>
                  {claimingId === milestone.id ? tx('claiming', 'Claiming...') : `${tx('claim', 'Claim')} ₹${milestone.reward}`}
                </Text>
              </TouchableOpacity>
            ) : null}
          </>
        ) : (
          <View style={styles.completedStatus}>
            <Text style={styles.completedText}>{t('rewardUnlocked')} ₹{milestone.reward}</Text>
          </View>
        )}
      </LinearGradient>
    </View>
  );

  const renderGigCard = useCallback(({ item: gig }: { item: GigHistoryItem }) => {
    const paymentStatus = getGigPaymentStatus(gig);
    const isCancelled = String(gig.status || '').toLowerCase() === 'cancelled';
    const displayStatus = isCancelled ? t('cancelled') : paymentStatus === 'paid' ? t('completed') : t('pending');
    const statusKey = isCancelled ? 'cancelled' : paymentStatus;
    const workHours =
      Number(gig.hoursWorked || 0) > 0
        ? Number(gig.hoursWorked || 0)
        : Math.round(((Number(gig.timeSpentMinutes || 0) / 60) || 0) * 10) / 10;
    const has8Hours = workHours >= 8;

    return (
      <View style={styles.gigCard}>
        <View style={styles.gigHeader}>
          <View style={styles.gigInfo}>
            <Text style={styles.gigTitle} numberOfLines={2}>
              {gig.title}
            </Text>
            <Text style={styles.contractorName}>{gig.contractorName}</Text>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: getStatusColor(statusKey) }]}>
            <MaterialIcons name={getStatusIcon(statusKey) as any} size={16} color="#fff" />
            <Text style={styles.statusBadgeText}>{displayStatus}</Text>
          </View>
        </View>

        <View style={styles.gigDetails}>
          <View style={styles.detailItem}>
            <MaterialIcons name="currency-rupee" size={18} color="#27AE60" />
            <Text style={styles.detailText}>₹{gig.amount}</Text>
          </View>
          <View style={styles.detailItem}>
            <MaterialIcons name="calendar-today" size={18} color="#3498DB" />
            <Text style={styles.detailText}>{formatDate(gig.date)}</Text>
          </View>
          {gig.rating ? (
            <View style={styles.detailItem}>
              <MaterialIcons name="star" size={18} color="#F39C12" />
              <Text style={styles.detailText}>{gig.rating.stars} ★</Text>
            </View>
          ) : null}
        </View>

        <View style={styles.requirementsRow}>
          <View style={[styles.requirementBadge, { borderColor: has8Hours ? '#27AE60' : '#E74C3C' }]}>
            <MaterialIcons name={has8Hours ? 'check-circle' : 'cancel'} size={18} color={has8Hours ? '#27AE60' : '#E74C3C'} />
            <Text style={[styles.requirementText, { color: has8Hours ? '#27AE60' : '#E74C3C' }]}>
              {workHours > 0 ? `${workHours}${tx('hoursShort', 'h')}` : tx('notAvailable', 'N/A')}
            </Text>
          </View>

          {isCancelled ? (
            <View style={[styles.requirementBadge, styles.requirementDangerBadge]}>
              <MaterialIcons name="cancel" size={18} color="#E74C3C" />
              <Text style={[styles.requirementText, { color: '#E74C3C' }]}>{t('cancelled')}</Text>
            </View>
          ) : null}

          {paymentStatus === 'paid' && !isCancelled ? (
            <View style={[styles.requirementBadge, styles.requirementSuccessBadge]}>
              <MaterialIcons name="check-circle" size={18} color="#27AE60" />
              <Text style={[styles.requirementText, { color: '#27AE60' }]}>{t('completed')}</Text>
            </View>
          ) : null}
        </View>

        {gig.rating ? (
          <View style={styles.ratingBox}>
            <Text style={styles.ratingLabel}>{t('feedback')}</Text>
            <Text style={styles.ratingText}>{gig.rating.feedback || t('noFeedbackProvided')}</Text>
          </View>
        ) : null}
      </View>
    );
  }, [tx, t, getGigPaymentStatus, getStatusColor, getStatusIcon, formatDate]);

  const { completedCount, pendingCount, cancelledCount } = useMemo(() => {
    let completed = 0;
    let pending = 0;
    let cancelled = 0;

    gigs.forEach((gig) => {
      if (String(gig.status || '').toLowerCase() === 'cancelled') cancelled += 1;
      else if (getGigPaymentStatus(gig) === 'paid') completed += 1;
      else pending += 1;
    });

    return { completedCount: completed, pendingCount: pending, cancelledCount: cancelled };
  }, [gigs]);

  const ListHeader = useMemo(
    () => (
      <>
        {renderIncentiveHeader()}
        {renderConditionsCard()}

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('milestones')}</Text>
          {milestones.map((milestone) => renderMilestoneCard(milestone))}
          <Text style={styles.streakRuleText}>
            {tx('streakRuleSummary', 'Rewards unlock only after consecutive workdays with at least 8 hours and no declines/cancellations.')}
          </Text>
        </View>

        <View style={styles.statusOverview}>
          <View style={styles.statusOverviewCard}>
            <View style={styles.statusOverviewIcon}>
              <MaterialIcons name="check-circle" size={28} color="#27AE60" />
            </View>
            <Text style={styles.statusOverviewValue}>{completedCount}</Text>
            <Text style={styles.statusOverviewLabel}>{t('completed')}</Text>
          </View>

          <View style={styles.statusOverviewCard}>
            <View style={styles.statusOverviewIcon}>
              <MaterialIcons name="schedule" size={28} color="#F39C12" />
            </View>
            <Text style={styles.statusOverviewValue}>{pendingCount}</Text>
            <Text style={styles.statusOverviewLabel}>{t('pending')}</Text>
          </View>

          <View style={styles.statusOverviewCard}>
            <View style={styles.statusOverviewIcon}>
              <MaterialIcons name="cancel" size={28} color="#E74C3C" />
            </View>
            <Text style={styles.statusOverviewValue}>{cancelledCount}</Text>
            <Text style={styles.statusOverviewLabel}>{t('cancelled')}</Text>
          </View>
        </View>
      </>
    ),
    [cancelledCount, claimingId, completedCount, incentiveData, incentiveLoading, isLiveRefreshing, lastUpdatedAt, milestones, pendingCount, t, todayWorkedMinutes, tx]
  );

  const ListEmpty = () => (
    <View style={styles.emptyState}>
      <MaterialIcons name="work-outline" size={64} color="#BDC3C7" />
      <Text style={styles.emptyTitle}>{t('noGigsYet')}</Text>
      <Text style={styles.emptyText}>{t('startAcceptingJobs')}</Text>
    </View>
  );

  const ListFooter = () => (
    <View style={styles.listFooter}>
      {loadingMore ? <ActivityIndicator size="small" color="#667EEA" style={{ marginVertical: 12 }} /> : null}
    </View>
  );

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('gigHistory')}</Text>
        <View style={{ width: 44 }} />
      </View>

      {/* Simple modal used to avoid native alert spam for repeated API failures */}
      <Modal transparent visible={simpleModalVisible} animationType="fade" onRequestClose={() => { setSimpleModalVisible(false); simpleModalVisibleRef.current = false; }}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            <View style={[styles.modalHeader, { backgroundColor: '#FEE2E2' }]}>
              <View style={[styles.modalIconBg, { backgroundColor: '#E11D48' }]}>
                <MaterialIcons name="error" size={32} color="#fff" />
              </View>
            </View>
            <View style={styles.modalContent}>
              <Text style={[styles.modalTitle, { color: '#991B1B' }]}>{simpleModalTitle}</Text>
              <Text style={[styles.modalMessage, { color: '#4B5563' }]}>{simpleModalMessage}</Text>
            </View>
            <TouchableOpacity style={[styles.modalButton, { backgroundColor: '#E11D48' }]} onPress={() => { setSimpleModalVisible(false); simpleModalVisibleRef.current = false; router.push('/'); }}>
              <Text style={styles.modalButtonText}>{tx('ok', 'OK')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#667EEA" />
        </View>
      ) : (
        <>
          {gigError ? (
            <View style={styles.errorBanner}>
              <Text style={styles.errorBannerText}>{gigError}</Text>
            </View>
          ) : null}
          <FlatList
            data={gigs}
            renderItem={renderGigCard}
            keyExtractor={(item) => item._id}
            ListHeaderComponent={ListHeader}
            ListEmptyComponent={ListEmpty}
            ListFooterComponent={ListFooter}
            onEndReached={handleLoadMore}
            onEndReachedThreshold={0.5}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} title={tx('pullToRefresh', 'Pull to refresh')} />}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ flexGrow: 1, paddingBottom: 20 }}
            removeClippedSubviews
            initialNumToRender={10}
            maxToRenderPerBatch={20}
            windowSize={5}
          />
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FA',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  backButton: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    flex: 1,
    textAlign: 'center',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorBanner: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: '#FEE2E2',
    borderRadius: 10,
    padding: 10,
  },
  errorBannerText: {
    color: '#991B1B',
    fontWeight: '600',
  },
  incentiveHeader: {
    paddingHorizontal: 16,
    paddingVertical: 18,
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 14,
  },
  todayProgressBar: {
    height: 8,
    backgroundColor: 'rgba(232,234,255,0.2)',
    borderRadius: 4,
    overflow: 'hidden',
    marginTop: 6,
  },
  todayProgressFill: {
    height: '100%',
    backgroundColor: '#22c55e',
    borderRadius: 4,
  },
  incentiveContent: {
    gap: 14,
  },
  incentiveInfo: {
    gap: 4,
  },
  incentiveTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  incentiveSubtitle: {
    fontSize: 13,
    color: '#E8EAFF',
    fontWeight: '500',
  },
  incentiveStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
    color: '#fff',
  },
  statLabel: {
    fontSize: 11,
    color: '#E8EAFF',
    marginTop: 2,
    fontWeight: '600',
  },
  statDivider: {
    width: 1,
    height: 40,
    backgroundColor: '#E8EAFF',
  },
  liveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: 8,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#86EFAC',
  },
  liveDotRefreshing: {
    backgroundColor: '#FDE68A',
  },
  liveBadgeText: {
    fontSize: 11,
    color: '#fff',
    fontWeight: '700',
  },
  lastUpdatedText: {
    fontSize: 11,
    color: '#E8EAFF',
    fontWeight: '600',
  },
  conditionsCard: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 14,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  conditionsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  conditionsList: {
    gap: 12,
  },
  condition: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 12,
    paddingVertical: 8,
    borderLeftWidth: 3,
  },
  conditionText: {
    flex: 1,
    gap: 3,
  },
  conditionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#111827',
  },
  conditionValue: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  conditionError: {
    fontSize: 11,
    color: '#E74C3C',
    fontWeight: '600',
  },
  dailyBreakdown: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
    gap: 8,
  },
  streakBrokenBanner: {
    marginTop: 10,
    backgroundColor: '#E11D48',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  streakBrokenText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 13,
  },
  dailyBreakdownTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#111827',
  },
  dailyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  dailyDate: {
    fontSize: 12,
    color: '#374151',
    fontWeight: '600',
  },
  dailyHours: {
    fontSize: 12,
    fontWeight: '700',
  },
  section: {
    paddingHorizontal: 12,
    paddingTop: 20,
    paddingBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
  },
  milestoneCard: {
    marginBottom: 12,
    borderRadius: 14,
    overflow: 'hidden',
  },
  milestoneGradient: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  milestoneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 12,
  },
  milestoneIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  milestoneInfo: {
    flex: 1,
    gap: 2,
  },
  milestoneTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },
  milestoneReward: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '500',
  },
  completedBadge: {
    width: 36,
    height: 36,
    justifyContent: 'center',
    alignItems: 'center',
  },
  progressSection: {
    gap: 6,
  },
  progressBar: {
    height: 6,
    backgroundColor: '#E5E7EB',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
    textAlign: 'right',
  },
  ruleText: {
    marginTop: 8,
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '600',
  },
  streakRuleText: {
    marginTop: 6,
    fontSize: 12,
    color: '#6B7280',
    lineHeight: 18,
  },
  claimButton: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    gap: 6,
  },
  claimButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  completedStatus: {
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: '#F0FDF4',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#27AE60',
  },
  completedText: {
    fontSize: 12,
    color: '#27AE60',
    fontWeight: '700',
    textAlign: 'center',
  },
  statusOverview: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 10,
    marginTop: 8,
  },
  statusOverviewCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  statusOverviewIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#F8F9FA',
    justifyContent: 'center',
    alignItems: 'center',
  },
  statusOverviewValue: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  statusOverviewLabel: {
    fontSize: 11,
    color: '#6B7280',
    fontWeight: '500',
  },
  gigCard: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 12,
    marginTop: 10,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  gigHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 8,
  },
  gigInfo: {
    flex: 1,
  },
  gigTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 4,
  },
  contractorName: {
    fontSize: 12,
    color: '#6B7280',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    gap: 4,
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#fff',
  },
  gigDetails: {
    flexDirection: 'row',
    gap: 12,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
    flexWrap: 'wrap',
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  detailText: {
    fontSize: 12,
    color: '#4B5563',
    fontWeight: '500',
  },
  requirementsRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 10,
    flexWrap: 'wrap',
  },
  requirementBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: '#F9FAFB',
  },
  requirementSuccessBadge: {
    borderColor: '#27AE60',
    backgroundColor: '#E8F5E9',
  },
  requirementDangerBadge: {
    borderColor: '#E74C3C',
    backgroundColor: '#FFEBEE',
  },
  requirementText: {
    fontSize: 11,
    fontWeight: '600',
  },
  ratingBox: {
    marginTop: 10,
    backgroundColor: '#FEF5E7',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#F39C12',
  },
  ratingLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#A04000',
    marginBottom: 4,
  },
  ratingText: {
    fontSize: 12,
    color: '#4B5563',
    lineHeight: 18,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#111827',
  },
  emptyText: {
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },
  listFooter: {
    paddingHorizontal: 12,
    paddingTop: 14,
    paddingBottom: 10,
  },
  // Simple modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  modalContainer: {
    backgroundColor: '#fff',
    borderRadius: 12,
    width: '100%',
    maxWidth: 360,
    overflow: 'hidden',
    elevation: 8,
  },
  modalHeader: {
    paddingVertical: 18,
    alignItems: 'center',
  },
  modalIconBg: {
    width: 56,
    height: 56,
    borderRadius: 28,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    alignItems: 'center',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 8,
  },
  modalMessage: {
    fontSize: 14,
    color: '#4B5563',
    textAlign: 'center',
  },
  modalButton: {
    paddingVertical: 12,
    margin: 16,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  footerRefreshButton: {
    backgroundColor: '#1F6FEB',
    borderRadius: 12,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  footerRefreshButtonDisabled: {
    opacity: 0.7,
  },
  footerRefreshText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
});
