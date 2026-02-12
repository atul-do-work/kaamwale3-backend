import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  RefreshControl,
  Platform,
  Dimensions,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../utils/config';
import { LinearGradient } from 'expo-linear-gradient';
import { useLanguage } from '../context/LanguageContext';

const { width } = Dimensions.get('window');

const logActivity = async (action: string, details: string) => {
  try {
    const token = await AsyncStorage.getItem('token');
    await fetch(`${API_BASE}/activity`, {
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
}

interface IncentiveTracker {
  consecutiveDays: number;
  totalHours: number;
  cancellations: number;
  lastWorkDate: string | null;
  hoursToday: number;
  eligibleFor5Days: boolean;
  eligibleFor10Days: boolean;
  eligibleFor20Days: boolean;
}

interface Milestone {
  id: string;
  days: number;
  reward: number;
  icon: string;
  color: string;
  completed: boolean;
  progress: number;
}

export default function GigHistory() {
  const router = useRouter();
  const { t } = useLanguage();
  const [gigs, setGigs] = useState<GigHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [incentiveData, setIncentiveData] = useState<IncentiveTracker>({
    consecutiveDays: 0,
    totalHours: 0,
    cancellations: 0,
    lastWorkDate: null,
    hoursToday: 0,
    eligibleFor5Days: false,
    eligibleFor10Days: false,
    eligibleFor20Days: false,
  });
  const [milestones, setMilestones] = useState<Milestone[]>([
    {
      id: '5days',
      days: 5,
      reward: 50,
      icon: 'fire',
      color: '#FF6B6B',
      completed: false,
      progress: 0,
    },
    {
      id: '10days',
      days: 10,
      reward: 150,
      icon: 'star',
      color: '#FFD93D',
      completed: false,
      progress: 0,
    },
    {
      id: '20days',
      days: 20,
      reward: 300,
      icon: 'favorite',
      color: '#FF1493',
      completed: false,
      progress: 0,
    },
  ]);

  useEffect(() => {
    fetchGigHistory();
  }, []);

  const fetchGigHistory = async () => {
    try {
      setLoading(true);
      const token = await AsyncStorage.getItem('token');
      const res = await fetch(`${API_BASE}/jobs/my-accepted`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setGigs(data);
        calculateIncentiveProgress(data);
        await logActivity('GIG_HISTORY_VIEWED', 'User viewed their gig history');
      }
    } catch (err) {
      console.error('Error fetching gig history:', err);
    } finally {
      setLoading(false);
    }
  };

  const calculateIncentiveProgress = (gigsData: GigHistory[]) => {
    // This will be populated with backend data later
    // For now, we'll calculate from client-side gig data
    
    const completedGigs = gigsData.filter(g => g.paymentStatus === 'Paid');
    const cancelledGigs = gigsData.filter(g => g.status === 'cancelled');
    
    // Calculate consecutive days (placeholder - will be from backend)
    const consecutiveDays = Math.floor(Math.random() * 21); // For UI demo
    const totalHours = completedGigs.length * 8; // Assuming 8 hours per gig

    const tracker: IncentiveTracker = {
      consecutiveDays,
      totalHours,
      cancellations: cancelledGigs.length,
      lastWorkDate: new Date().toISOString(),
      hoursToday: 8,
      eligibleFor5Days: consecutiveDays >= 5 && cancelledGigs.length <= 1 && totalHours >= 35,
      eligibleFor10Days: consecutiveDays >= 10 && cancelledGigs.length <= 1 && totalHours >= 70,
      eligibleFor20Days: consecutiveDays >= 20 && cancelledGigs.length <= 1 && totalHours >= 140,
    };

    setIncentiveData(tracker);

    // Update milestones with progress
    const updatedMilestones = milestones.map(m => ({
      ...m,
      progress: Math.min(consecutiveDays / m.days, 1),
      completed: m.id === '5days' && tracker.eligibleFor5Days ||
                m.id === '10days' && tracker.eligibleFor10Days ||
                m.id === '20days' && tracker.eligibleFor20Days,
    }));
    setMilestones(updatedMilestones);
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchGigHistory();
    setRefreshing(false);
  };

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
    switch (status) {
      case 'Paid':
        return '#27AE60';
      case 'Pending':
        return '#F39C12';
      case 'cancelled':
        return '#E74C3C';
      default:
        return '#95A5A6';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Paid':
        return 'check-circle';
      case 'Pending':
        return 'schedule';
      case 'cancelled':
        return 'cancel';
      default:
        return 'info';
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
        <View style={styles.incentiveStats}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{incentiveData.consecutiveDays}</Text>
            <Text style={styles.statLabel}>Days</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{incentiveData.totalHours}</Text>
            <Text style={styles.statLabel}>{t('hours')}</Text>
          </View>
        </View>
      </View>
    </LinearGradient>
  );

  const renderConditionsCard = () => (
    <View style={styles.conditionsCard}>
      <Text style={styles.conditionsTitle}>✓ {t('requirementsStatus')}</Text>
      <View style={styles.conditionsList}>
        {/* 5 Days Requirement */}
        <View style={[styles.condition, { borderLeftColor: incentiveData.consecutiveDays >= 5 ? '#27AE60' : '#BDC3C7' }]}>
          <MaterialIcons 
            name={incentiveData.consecutiveDays >= 5 ? 'check' : 'close'} 
            size={24} 
            color={incentiveData.consecutiveDays >= 5 ? '#27AE60' : '#E74C3C'}
            style={{ fontWeight: 'bold' }}
          />
          <View style={styles.conditionText}>
            <Text style={styles.conditionLabel}>{t('consecutiveDays')}</Text>
            <Text style={styles.conditionValue}>{incentiveData.consecutiveDays}/5 days ({Math.round((incentiveData.consecutiveDays / 5) * 100)}%)</Text>
          </View>
        </View>

        {/* 7 Hours Per Day Requirement */}
        <View style={[styles.condition, { borderLeftColor: incentiveData.totalHours >= 35 ? '#27AE60' : '#BDC3C7' }]}>
          <MaterialIcons 
            name={incentiveData.totalHours >= 35 ? 'check' : 'close'} 
            size={24} 
            color={incentiveData.totalHours >= 35 ? '#27AE60' : '#E74C3C'}
            style={{ fontWeight: 'bold' }}
          />
          <View style={styles.conditionText}>
            <Text style={styles.conditionLabel}>{t('hoursPerDay')}</Text>
            <Text style={styles.conditionValue}>{incentiveData.totalHours}/35 hours ({Math.round((incentiveData.totalHours / 35) * 100)}%)</Text>
          </View>
        </View>

        {/* Cancellation Requirement */}
        <View style={[styles.condition, { borderLeftColor: incentiveData.cancellations <= 1 ? '#27AE60' : '#BDC3C7' }]}>
          <MaterialIcons 
            name={incentiveData.cancellations <= 1 ? 'check' : 'close'} 
            size={24} 
            color={incentiveData.cancellations <= 1 ? '#27AE60' : '#E74C3C'}
            style={{ fontWeight: 'bold' }}
          />
          <View style={styles.conditionText}>
            <Text style={styles.conditionLabel}>No Cancellations</Text>
            <Text style={styles.conditionValue}>{incentiveData.cancellations} cancelled ({incentiveData.cancellations <= 1 ? '✔ Allowed' : '✗ Exceeded'})</Text>
          </View>
        </View>
      </View>
    </View>
  );

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
          {milestone.completed && (
            <View style={styles.completedBadge}>
              <MaterialIcons name="check-circle" size={28} color="#27AE60" />
            </View>
          )}
        </View>

        {!milestone.completed && (
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
        )}

        {milestone.completed && (
          <View style={styles.completedStatus}>
            <Text style={styles.completedText}>🎉 {t('rewardUnlocked')}! ₹{milestone.reward}</Text>
          </View>
        )}
      </LinearGradient>
    </View>
  );

  const renderGigCard = (gig: GigHistory) => {
    const paymentStatus = gig.paymentStatus || 'Pending';
    const displayStatus = paymentStatus === 'Paid' ? t('completed') : t('pending');
    
    // ✅ Calculate work hours from workDuration if available
    const workHours = gig.workDuration ? parseFloat(gig.workDuration) : 0;
    const has8Hours = workHours >= 8;
    const isCancelled = gig.status === 'cancelled';

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
              {workHours > 0 ? `${workHours}h` : t('notAvailable')} {has8Hours ? '✔' : '✗'}
            </Text>
          </View>
          
          {isCancelled && (
            <View style={[styles.requirementBadge, { borderColor: '#E74C3C', backgroundColor: '#FFEBEE' }]}>
              <MaterialIcons name="cancel" size={18} color="#E74C3C" />
              <Text style={[styles.requirementText, { color: '#E74C3C' }]}>{t('cancelled')} ✗</Text>
            </View>
          )}
          
          {paymentStatus === 'Paid' && !isCancelled && (
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

  const completedGigs = gigs.filter(g => g.paymentStatus === 'Paid');
  const pendingGigs = gigs.filter(g => g.paymentStatus !== 'Paid' && g.status !== 'cancelled');
  const cancelledGigs = gigs.filter(g => g.status === 'cancelled');

  return (
    <View style={styles.container}>
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
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        >
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
              <Text style={styles.statusOverviewValue}>{completedGigs.length}</Text>
              <Text style={styles.statusOverviewLabel}>{t('completed')}</Text>
            </View>

            <View style={styles.statusOverviewCard}>
              <View style={styles.statusOverviewIcon}>
                <MaterialIcons name="schedule" size={28} color="#F39C12" />
              </View>
              <Text style={styles.statusOverviewValue}>{pendingGigs.length}</Text>
              <Text style={styles.statusOverviewLabel}>{t('pending')}</Text>
            </View>

            <View style={styles.statusOverviewCard}>
              <View style={styles.statusOverviewIcon}>
                <MaterialIcons name="cancel" size={28} color="#E74C3C" />
              </View>
              <Text style={styles.statusOverviewValue}>{cancelledGigs.length}</Text>
              <Text style={styles.statusOverviewLabel}>{t('cancelled')}</Text>
            </View>
          </View>

          {/* Gigs List Section */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>📋 {t('allGigs')}</Text>
            {gigs.length === 0 ? (
              <View style={styles.emptyState}>
                <MaterialIcons name="work-outline" size={64} color="#BDC3C7" />
                <Text style={styles.emptyTitle}>{t('noGigsYet')}</Text>
                <Text style={styles.emptyText}>{t('startAcceptingJobs')}</Text>
              </View>
            ) : (
              gigs.map(gig => renderGigCard(gig))
            )}
          </View>

          <View style={{ height: 30 }} />
        </ScrollView>
      )}
    </View>
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
});
