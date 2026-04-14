import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Platform,
  Dimensions,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../context/AuthContext';
import { API_BASE } from '../utils/config';
import { LinearGradient } from 'expo-linear-gradient';
import { useLanguage } from '../context/LanguageContext';

const { width } = Dimensions.get('window');

// ✅ Utility: Log user activity
const logActivity = async (token: string | null, action: string, details: string) => {
  try {
    await fetch(`${API_BASE}/activity/log`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
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

interface GigHistory {
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

interface IncentiveProgress {
  consecutiveDays: number;
  totalHours: number;
  cancellationsInWindow: number;
  requiredDailyHours?: number;
  requiredDaysFor5?: number;
  fiveDayWindow?: {
    requiredDays: number;
    requiredDailyHours: number;
    daysMetMinimumHours: number;
    allDaysHaveMinHours: boolean;
    startDate: string | null;
    endDate: string | null;
    dailyStatus: Array<{
      date: string;
      jobsCompleted: number;
      hoursWorked: number;
      hasCompletedJob: boolean;
      meetsMinimumHours: boolean;
    }>;
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
  
  // ✅ State management
  const [gigs, setGigs] = useState<GigHistory[]>([]);
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
  const [claimingId, setClaimingId] = useState<string | null>(null); // ✅ Prevent claim race condition
  const [milestones, setMilestones] = useState<Milestone[]>([
    { id: '5days', days: 5, reward: 50, icon: 'fire', color: '#FF6B6B', completed: false, claimed: false, progress: 0 },
    { id: '10days', days: 10, reward: 150, icon: 'star', color: '#FFD93D', completed: false, claimed: false, progress: 0 },
    { id: '20days', days: 20, reward: 300, icon: 'favorite', color: '#FF1493', completed: false, claimed: false, progress: 0 },
  ]);

  const buildFallbackIncentiveData = (reason?: string): IncentiveProgress => ({
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
      failureReason: reason || 'No completed paid job history found',
    },
    eligibleFor5Days: false,
    eligibleFor10Days: false,
    eligibleFor20Days: false,
    unlockedMilestones: [],
    claimedMilestones: [],
    availableMilestones: [],
    lastWorkDate: null,
  });

  // ✅ Refs for cleanup (separate controllers for gigs vs incentive)
  const gigsAbortRef = useRef<AbortController | null>(null);
  const incentiveAbortRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  // ✅ Cleanup on unmount (abort both controllers)
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
      if (gigsAbortRef.current) gigsAbortRef.current.abort();
      if (incentiveAbortRef.current) incentiveAbortRef.current.abort();
    };
  }, []);

  // Re-render at local midnight so today's hours reset automatically.
  useEffect(() => {
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setHours(24, 0, 0, 0);
    const ms = Math.max(1000, nextMidnight.getTime() - now.getTime());
    const timer = setTimeout(() => setDayTick((v) => v + 1), ms);
    return () => clearTimeout(timer);
  }, [dayTick]);

  const formatHoursDotMinutes = (totalMinutes: number) => {
    const safe = Math.max(0, Number(totalMinutes) || 0);
    const hours = Math.floor(safe / 60);
    const minutes = safe % 60;
    return `${hours}.${String(minutes).padStart(2, '0')}`;
  };

  const getGigPaymentStatus = (gig: GigHistory): 'paid' | 'pending' => {
    if (Array.isArray(gig.acceptedWorkers) && gig.acceptedWorkers.length > 0) {
      return gig.acceptedWorkers.every((w) => String(w?.paymentStatus || '').toLowerCase() === 'paid') ? 'paid' : 'pending';
    }
    return String(gig.paymentStatus || '').toLowerCase() === 'paid' ? 'paid' : 'pending';
  };

  const todayWorkedMinutes = React.useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const d = now.getDate();

    return gigs.reduce((sum, gig) => {
      const isPaid = getGigPaymentStatus(gig) === 'paid';
      const isCompleted = String(gig.status || '').toLowerCase() === 'completed';
      if (!isPaid && !isCompleted) return sum;

      const sourceDate = gig.paymentTime || gig.date || gig.acceptedAt;
      if (!sourceDate) return sum;
      const ts = new Date(sourceDate);
      if (Number.isNaN(ts.getTime())) return sum;
      if (ts.getFullYear() !== y || ts.getMonth() !== m || ts.getDate() !== d) return sum;

      const explicitMinutes = Number(gig.timeSpentMinutes || 0);
      if (explicitMinutes > 0) return sum + explicitMinutes;
      const fallbackMinutes = Math.round((Number(gig.hoursWorked || 0) || 0) * 60);
      return sum + Math.max(0, fallbackMinutes);
    }, 0);
  }, [gigs, dayTick]);

  // ✅ Fetch gigs and incentive progress when screen focuses
  useFocusEffect(
    React.useCallback(() => {
      isMountedRef.current = true;
      fetchGigHistory();
      fetchIncentiveProgress();
      return () => {
        isMountedRef.current = false;
      };
    }, [accessToken])
  );

  // ✅ Fetch gigs with pagination
  const fetchGigHistory = async (pageNum: number = 1, isFresh: boolean = true) => {
    try {
      if (isFresh) setLoading(true);
      else setLoadingMore(true);
      setGigError(null);

      if (!accessToken) {
        setGigError('Not authenticated');
        return;
      }

      // ✅ Create new AbortController for gigs request
      gigsAbortRef.current = new AbortController();

      const res = await fetch(`${API_BASE}/jobs/my-accepted?page=${pageNum}&limit=20`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: gigsAbortRef.current.signal,
      });

      // ✅ Handle authentication errors
      if (res.status === 401) {
        if (isMountedRef.current) {
          setGigError('Session expired. Please log in again.');
          Alert.alert('Session Expired', 'Your session has expired. Please log in again.', [
            { text: 'OK', onPress: () => router.push('/') }
          ]);
        }
        return;
      }

      if (res.ok) {
        const data = await res.json();
        
        if (isMountedRef.current) {
          // ✅ Handle both new format (with gigs property) and legacy format (array)
          const gigsData = data.gigs || (Array.isArray(data) ? data : []);
          
          if (isFresh) {
            setGigs(gigsData);
          } else {
            setGigs(prev => [...prev, ...gigsData]);
          }
          
          // ✅ Check if more pages available
          setHasMore(data.hasMore !== undefined ? data.hasMore : gigsData.length === 20);
          setPage(pageNum);
          
          await logActivity(accessToken, 'GIG_HISTORY_VIEWED', 'User viewed their gig history');
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('Fetch aborted');
        return; // ✅ Request was cancelled
      }
      
      if (isMountedRef.current) {
        console.error('Error fetching gig history:', err);
        setGigError('Failed to load gigs. Pull to refresh.');
      }
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  };

  // ✅ Fetch incentive progress from backend (NOT calculated on frontend)
  const fetchIncentiveProgress = async () => {
    try {
      setIncentiveLoading(true);
      setIncentiveError(null);

      if (!accessToken) {
        setIncentiveData(buildFallbackIncentiveData('Not authenticated'));
        setIncentiveError(null);
        return;
      }

      // ✅ Create new AbortController for incentive request
      incentiveAbortRef.current = new AbortController();

      const res = await fetch(`${API_BASE}/incentives/progress`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: incentiveAbortRef.current.signal,
      });

      // ✅ Handle authentication errors
      if (res.status === 401) {
        if (isMountedRef.current) {
          setIncentiveData(buildFallbackIncentiveData('Please log in to view incentives'));
          setIncentiveError(null);
        }
        return;
      }

      if (res.ok) {
        const data: IncentiveProgress = await res.json();
        
        if (isMountedRef.current) {
          setIncentiveData(data);
          setIncentiveError(null);

          // ✅ Update milestones based on backend data (functional update to avoid stale closure)
          setMilestones(prev => prev.map(m => {
            const isClaimed = data.claimedMilestones?.includes(m.id) || false;
            const isEligible = data.unlockedMilestones?.includes(m.id) || false;
            
            return {
              ...m,
              progress: Math.min(data.consecutiveDays / m.days, 1),
              completed: isEligible,
              claimed: isClaimed,
            };
          }));
        }
      } else {
        const errData = await res.json().catch(() => ({}));
        if (isMountedRef.current) {
          setIncentiveData(buildFallbackIncentiveData(errData.message || 'Failed to load incentive data'));
          setIncentiveError(null);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return; // ✅ Request was cancelled
      }
      
      if (isMountedRef.current) {
        console.error('Error fetching incentive progress:', err);
        setIncentiveData(buildFallbackIncentiveData('Failed to load incentive data'));
        setIncentiveError(null);
      }
    } finally {
      if (isMountedRef.current) {
        setIncentiveLoading(false);
      }
    }
  };

  // ✅ Handle infinite scroll - load more gigs
  const handleLoadMore = () => {
    if (!loadingMore && hasMore) {
      fetchGigHistory(page + 1, false);
    }
  };

  // ✅ Handle refresh
  const onRefresh = async () => {
    setRefreshing(true);
    setPage(1);
    await Promise.all([
      fetchGigHistory(1, true),
      fetchIncentiveProgress(),
    ]);
    setRefreshing(false);
  };

  // ✅ Claim milestone reward
  const claimMilestone = async (milestoneId: string) => {
    // ✅ Prevent race condition - don't allow concurrent claims
    if (claimingId) {
      Alert.alert('Processing', 'Please wait for the current claim to complete');
      return;
    }

    try {
      Alert.alert('Claim Reward', `Claim ₹${milestones.find(m => m.id === milestoneId)?.reward || 0} reward?`, [
        { text: 'Cancel' },
        {
          text: 'Claim',
          onPress: async () => {
            // ✅ Lock: Mark this milestone as claiming
            setClaimingId(milestoneId);
            
            try {
              const res = await fetch(`${API_BASE}/incentives/claim/${milestoneId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}` },
              });

              if (res.status === 401) {
                Alert.alert('Session Expired', 'Please log in again', [
                  { text: 'OK', onPress: () => router.push('/') }
                ]);
                return;
              }

              const data = await res.json();
              
              if (data.success) {
                Alert.alert('Success', `₹${data.rewardAmount} added to your wallet!`);
                await fetchIncentiveProgress(); // ✅ Refresh eligibility
              } else if (res.status === 403) {
                Alert.alert('Not Eligible', data.message || 'You are not eligible for this reward yet');
              } else {
                Alert.alert('Error', data.message || 'Failed to claim reward');
              }
            } catch (err) {
              Alert.alert('Error', 'Failed to claim reward');
              console.error(err);
            } finally {
              // ✅ Unlock: Clear claiming lock
              setClaimingId(null);
            }
          }
        }
      ]);
    } catch (err) {
      console.error('Error claiming milestone:', err);
    }
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
          <Text style={styles.incentiveTitle}>🎁 {t('earnIncentives')}</Text>
          <Text style={styles.incentiveSubtitle}>{t('completeTasksToUnlockRewards')}</Text>
        </View>
        {incentiveLoading ? (
          <ActivityIndicator color="#fff" />
        ) : incentiveError ? (
          <Text style={styles.incentiveError}>{incentiveError}</Text>
        ) : incentiveData ? (
          <View style={styles.incentiveStats}>
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{incentiveData.consecutiveDays}</Text>
              <Text style={styles.statLabel}>Days</Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{formatHoursDotMinutes(todayWorkedMinutes)}</Text>
              <Text style={styles.statLabel}>{t('hours')}</Text>
            </View>
          </View>
        ) : null}
      </View>
    </LinearGradient>
  );

  const renderConditionsCard = () => {
    const safeIncentiveData: IncentiveProgress = incentiveData || buildFallbackIncentiveData(incentiveError || undefined);

    return (
      <View style={styles.conditionsCard}>
        <Text style={styles.conditionsTitle}>✓ {t('requirementsStatus')} - 5 Day Milestone</Text>
        <View style={styles.conditionsList}>
          {/* 5 Days Requirement */}
          <View style={[styles.condition, { borderLeftColor: safeIncentiveData.consecutiveDays >= 5 ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons 
              name={safeIncentiveData.consecutiveDays >= 5 ? 'check-circle' : 'cancel'} 
              size={24} 
              color={safeIncentiveData.consecutiveDays >= 5 ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>📅 {t('consecutiveDays')}</Text>
              <Text style={styles.conditionValue}>{safeIncentiveData.consecutiveDays}/5 days ({Math.round((Math.min(safeIncentiveData.consecutiveDays / 5, 1)) * 100)}%)</Text>
            </View>
          </View>

          {/* 8 Hours Per Day Requirement */}
          <View style={[styles.condition, { borderLeftColor: (safeIncentiveData.fiveDayWindow?.allDaysHaveMinHours || false) ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons 
              name={(safeIncentiveData.fiveDayWindow?.allDaysHaveMinHours || false) ? 'check-circle' : 'cancel'} 
              size={24} 
              color={(safeIncentiveData.fiveDayWindow?.allDaysHaveMinHours || false) ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>⏰ 8 Hours Per Day</Text>
              <Text style={styles.conditionValue}>
                {(safeIncentiveData.fiveDayWindow?.daysMetMinimumHours || 0)}/{safeIncentiveData.requiredDaysFor5 || 5} days met ({safeIncentiveData.requiredDailyHours || 8}h/day)
              </Text>
              {!!safeIncentiveData.fiveDayWindow?.failureReason && (
                <Text style={[styles.conditionValue, { color: '#E74C3C' }]}>{safeIncentiveData.fiveDayWindow.failureReason}</Text>
              )}
            </View>
          </View>

          {/* NO Declines Requirement */}
          <View style={[styles.condition, { borderLeftColor: safeIncentiveData.cancellationsInWindow === 0 ? '#27AE60' : '#BDC3C7' }]}>
            <MaterialIcons 
              name={safeIncentiveData.cancellationsInWindow === 0 ? 'check-circle' : 'cancel'} 
              size={24} 
              color={safeIncentiveData.cancellationsInWindow === 0 ? '#27AE60' : '#E74C3C'}
            />
            <View style={styles.conditionText}>
              <Text style={styles.conditionLabel}>🚫 No Declines in Period</Text>
              <Text style={styles.conditionValue}>{safeIncentiveData.cancellationsInWindow} job declines ({safeIncentiveData.cancellationsInWindow === 0 ? '✔ Pass' : '✗ Failed'})</Text>
            </View>
          </View>
        </View>

      </View>
    );
  };

  // ✅ Utility functions
  const formatDate = (date: string) => {
    try {
      return new Date(date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return 'N/A';
    }
  };

  const getStatusColor = (status: string) => {
    switch ((status || '').toLowerCase()) {
      case 'paid':
        return '#27AE60';
      case 'pending':
        return '#F39C12';
      case 'cancelled':
        return '#E74C3C';
      case 'completed':
        return '#27AE60';
      default:
        return '#95A5A6';
    }
  };

  const getStatusIcon = (status: string) => {
    switch ((status || '').toLowerCase()) {
      case 'paid':
        return 'check-circle';
      case 'pending':
        return 'schedule';
      case 'cancelled':
        return 'cancel';
      case 'completed':
        return 'check-circle';
      default:
        return 'info';
    }
  };

  // ✅ Render milestone card with claim button
  const renderMilestoneCard = (milestone: Milestone) => (
    <View key={milestone.id} style={styles.milestoneCard}>
      <LinearGradient
        colors={[milestone.color + '20', milestone.color + '05']}
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
          {milestone.claimed && (
            <View style={styles.completedBadge}>
              <MaterialIcons name="check-circle" size={28} color="#27AE60" />
            </View>
          )}
        </View>

        {!milestone.claimed && (
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
                {Math.round(milestone.progress * 100)}% Complete
              </Text>
            </View>

            {milestone.completed && !milestone.claimed && (
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
                <MaterialIcons
                  name="card-giftcard"
                  size={20}
                  color="#fff"
                />
                <Text style={styles.claimButtonText}>
                  {claimingId === milestone.id ? 'Claiming...' : `Claim ₹${milestone.reward}`}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}

        {milestone.claimed && (
          <View style={styles.completedStatus}>
            <Text style={styles.completedText}>🎉 {t('rewardUnlocked')}! ₹{milestone.reward}</Text>
          </View>
        )}
      </LinearGradient>
    </View>
  );

  // ✅ Render single gig card
  const renderGigCard = ({ item: gig }: { item: GigHistory }) => {
    const paymentStatus = getGigPaymentStatus(gig);
    const displayStatus = paymentStatus === 'paid' ? t('completed') : t('pending');
    const workHours =
      Number(gig.hoursWorked || 0) > 0
        ? Number(gig.hoursWorked || 0)
        : Math.round(((Number(gig.timeSpentMinutes || 0) / 60) || 0) * 10) / 10;
    const has8Hours = workHours >= 8;
    const isCancelled = String(gig.status || '').toLowerCase() === 'cancelled';

    return (
      <View style={styles.gigCard}>
        <View style={styles.gigHeader}>
          <View style={styles.gigInfo}>
            <Text style={styles.gigTitle} numberOfLines={2}>
              {gig.title}
            </Text>
            <Text style={styles.contractorName}>
              👤 {gig.contractorName}
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: getStatusColor(paymentStatus) },
            ]}
          >
            <MaterialIcons name={getStatusIcon(paymentStatus) as any} size={16} color="#fff" />
            <Text style={styles.statusBadgeText}>{displayStatus}</Text>
          </View>
        </View>

        <View style={styles.gigDetails}>
          <View style={styles.detailItem}>
            <MaterialIcons name="attach-money" size={18} color="#27AE60" />
            <Text style={styles.detailText}>₹{gig.amount}</Text>
          </View>
          <View style={styles.detailItem}>
            <MaterialIcons name="calendar-today" size={18} color="#3498db" />
            <Text style={styles.detailText}>{formatDate(gig.date)}</Text>
          </View>
          {gig.rating && (
            <View style={styles.detailItem}>
              <MaterialIcons name="star" size={18} color="#F39C12" />
              <Text style={styles.detailText}>{gig.rating.stars} ⭐</Text>
            </View>
          )}
        </View>

        {/* ✅ Work Hours & Requirement Status */}
        <View style={styles.requirementsRow}>
          <View style={[styles.requirementBadge, { borderColor: has8Hours ? '#27AE60' : '#E74C3C' }]}>
            <MaterialIcons 
              name={has8Hours ? 'check-circle' : 'cancel'} 
              size={18} 
              color={has8Hours ? '#27AE60' : '#E74C3C'} 
            />
            <Text style={[styles.requirementText, { color: has8Hours ? '#27AE60' : '#E74C3C' }]}>
              {workHours > 0 ? `${workHours}h` : 'N/A'} {has8Hours ? '✔' : '✗'}
            </Text>
          </View>
          
          {isCancelled && (
            <View style={[styles.requirementBadge, { borderColor: '#E74C3C', backgroundColor: '#FFEBEE' }]}>
              <MaterialIcons name="cancel" size={18} color="#E74C3C" />
              <Text style={[styles.requirementText, { color: '#E74C3C' }]}>{t('cancelled')} ✗</Text>
            </View>
          )}
          
          {paymentStatus === 'paid' && !isCancelled && (
            <View style={[styles.requirementBadge, { borderColor: '#27AE60', backgroundColor: '#E8F5E9' }]}> 
              <MaterialIcons name="check-circle" size={18} color="#27AE60" />
              <Text style={[styles.requirementText, { color: '#27AE60' }]}>{t('completed')} ✔</Text>
            </View>
          )}
        </View>

        {gig.rating && (
          <View style={styles.ratingBox}>
            <Text style={styles.ratingLabel}>💬 {t('feedback')}</Text>
            <Text style={styles.ratingText}>{gig.rating.feedback || t('noFeedbackProvided')}</Text>
          </View>
        )}
      </View>
    );
  };

  // ✅ Memoize gig counts with single-pass optimization (avoid 3 separate filter calls)
  const { completedCount, pendingCount, cancelledCount } = React.useMemo(() => {
    let completed = 0;
    let pending = 0;
    let cancelled = 0;

    gigs.forEach(g => {
      if (String(g.status || '').toLowerCase() === 'cancelled') {
        cancelled++;
      } else if (getGigPaymentStatus(g) === 'paid') {
        completed++;
      } else {
        pending++;
      }
    });

    return { completedCount: completed, pendingCount: pending, cancelledCount: cancelled };
  }, [gigs]);

  // ✅ FlatList header component
  // ✅ Memoize ListHeader to prevent unnecessary FlatList re-renders
  const ListHeader = React.useMemo(
    () => (
      <>
        {/* Incentive Header */}
        {renderIncentiveHeader()}

        {/* Conditions Card */}
        {renderConditionsCard()}

        {/* Milestones Section */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>📊 {t('milestones')}</Text>
          {milestones.map(milestone => renderMilestoneCard(milestone))}
        </View>

        {/* Gig Status Overview */}
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
    [incentiveData, milestones, completedCount, pendingCount, cancelledCount, t, renderIncentiveHeader, renderConditionsCard, renderMilestoneCard]
  );

  // ✅ FlatList empty component
  const ListEmpty = () => (
    <View style={styles.emptyState}>
      <MaterialIcons name="work-outline" size={64} color="#BDC3C7" />
      <Text style={styles.emptyTitle}>{t('noGigsYet')}</Text>
      <Text style={styles.emptyText}>{t('startAcceptingJobs')}</Text>
    </View>
  );

  // ✅ FlatList footer for load more
  const ListFooter = () => {
    if (!hasMore) return <View style={{ height: 30 }} />;
    if (!loadingMore) return <View style={{ height: 10 }} />;
    return <ActivityIndicator size="small" color="#667EEA" style={{ marginVertical: 20 }} />;
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={[styles.container, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('gigHistory')}</Text>
        <View style={{ width: 44 }} />
      </View>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#667EEA" />
        </View>
      ) : (
        <>
          {gigError ? (
            <View style={{ marginHorizontal: 16, marginVertical: 8, backgroundColor: '#FEE2E2', borderRadius: 8, padding: 10 }}>
              <Text style={{ color: '#991B1B', fontWeight: '600' }}>{gigError}</Text>
            </View>
          ) : null}
          <FlatList
            data={[]}
            renderItem={renderGigCard}
            keyExtractor={(item) => item._id}
            ListHeaderComponent={ListHeader}
            ListEmptyComponent={null}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
            showsVerticalScrollIndicator={false}
            scrollIndicatorInsets={{ right: 1 }}
            contentContainerStyle={{ flexGrow: 1 }}
            removeClippedSubviews={true}
            initialNumToRender={10}
            maxToRenderPerBatch={20}
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
    borderBottomColor: '#e0e0e0',
  },
  backButton: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    flex: 1,
    textAlign: 'center',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  // Incentive Header Styles
  incentiveHeader: {
    paddingHorizontal: 16,
    paddingVertical: 20,
    marginHorizontal: 12,
    marginTop: 12,
    borderRadius: 12,
    shadowColor: '#667EEA',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
  },
  incentiveContent: {
    gap: 16,
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
  // Conditions Card
  conditionsCard: {
    backgroundColor: '#fff',
    marginHorizontal: 12,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  conditionsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
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
    gap: 2,
  },
  conditionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#000',
  },
  conditionValue: {
    fontSize: 11,
    color: '#7F8C8D',
    fontWeight: '500',
  },
  dailyBreakdown: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 8,
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
  // Milestone Styles
  section: {
    paddingHorizontal: 12,
    paddingTop: 20,
    paddingBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000',
    marginBottom: 12,
  },
  milestoneCard: {
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
  },
  milestoneGradient: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E8EAFF',
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
    borderRadius: 10,
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
    color: '#000',
  },
  milestoneReward: {
    fontSize: 12,
    color: '#7F8C8D',
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
    backgroundColor: '#E8EAFF',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 11,
    color: '#7F8C8D',
    fontWeight: '600',
    textAlign: 'right',
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
  // Status Overview
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
    color: '#000',
  },
  statusOverviewLabel: {
    fontSize: 11,
    color: '#7F8C8D',
    fontWeight: '500',
  },
  // Gig Card Styles
  gigCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
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
  },
  gigInfo: {
    flex: 1,
    marginRight: 8,
  },
  gigTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
    marginBottom: 4,
  },
  contractorName: {
    fontSize: 12,
    color: '#7F8C8D',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
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
    borderBottomColor: '#f0f0f0',
    flexWrap: 'wrap',
  },
  detailItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  detailText: {
    fontSize: 12,
    color: '#555',
    fontWeight: '500',
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
    color: '#555',
    lineHeight: 18,
  },
  // ✅ New styles for requirement tracking
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
    borderRadius: 6,
    borderWidth: 1,
    backgroundColor: '#f5f5f5',
  },
  requirementText: {
    fontSize: 11,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000',
  },
  emptyText: {
    fontSize: 13,
    color: '#7F8C8D',
    textAlign: 'center',
  },
  // ✅ Claim button styles
  claimButton: {
    marginTop: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    gap: 6,
  },
  claimButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  // ✅ Error styles
  incentiveError: {
    fontSize: 12,
    color: '#E74C3C',
    fontStyle: 'italic',
  },
});
