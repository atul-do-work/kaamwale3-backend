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
  Modal,
  Alert,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../utils/config';

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

interface AvailableJob {
  _id: string;
  title: string;
  amount: number;
  description: string;
  location: string;
  contractorName: string;
  skills?: string[];
  workDuration?: string;
  deadline?: string;
}

export default function GigHistory() {
  const router = useRouter();
  const [gigs, setGigs] = useState<GigHistory[]>([]);
  const [availableJobs, setAvailableJobs] = useState<AvailableJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'completed' | 'cancelled' | 'pending'>('all');
  const [showBookingModal, setShowBookingModal] = useState(false);
  const [bookingLoading, setBookingLoading] = useState(false);

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
        await logActivity('GIG_HISTORY_VIEWED', 'User viewed their gig history');
      }
    } catch (err) {
      console.error('Error fetching gig history:', err);
      Alert.alert('Error', 'Failed to load gig history');
    } finally {
      setLoading(false);
    }
  };

  const fetchAvailableJobs = async () => {
    try {
      setBookingLoading(true);
      const token = await AsyncStorage.getItem('token');
      const res = await fetch(`${API_BASE}/jobs/available`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setAvailableJobs(data.slice(0, 5));
      }
    } catch (err) {
      console.error('Error fetching available jobs:', err);
    } finally {
      setBookingLoading(false);
    }
  };

  const handleBookJob = async (jobId: string) => {
    try {
      const token = await AsyncStorage.getItem('token');
      const res = await fetch(`${API_BASE}/jobs/accept`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ jobId }),
      });

      if (res.ok) {
        Alert.alert('Success', 'Job booked successfully!');
        await logActivity('JOB_BOOKED', `Booked job: ${jobId}`);
        setShowBookingModal(false);
        await fetchGigHistory();
      } else {
        Alert.alert('Error', 'Failed to book job');
      }
    } catch (err) {
      Alert.alert('Error', 'Failed to book job. Please try again.');
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchGigHistory();
    setRefreshing(false);
  };

  const getFilteredGigs = () => {
    return gigs.filter(gig => {
      if (filter === 'all') return true;
      if (filter === 'completed') return gig.paymentStatus === 'Paid';
      if (filter === 'cancelled') return gig.status === 'cancelled';
      if (filter === 'pending') return gig.paymentStatus !== 'Paid' && gig.status !== 'cancelled';
      return true;
    });
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'Paid':
        return '#27AE60';
      case 'cancelled':
        return '#E74C3C';
      case 'Pending':
        return '#F39C12';
      default:
        return '#95A5A6';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Paid':
        return 'check-circle';
      case 'cancelled':
        return 'cancel';
      case 'Pending':
        return 'schedule';
      default:
        return 'info';
    }
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    } catch {
      return 'N/A';
    }
  };

  const renderGigCard = (gig: GigHistory) => {
    const paymentStatus = gig.paymentStatus || 'Pending';
    const isCompleted = paymentStatus === 'Paid';

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
            <Text style={styles.statusBadgeText}>
              {paymentStatus === 'Paid' ? 'Completed' : paymentStatus}
            </Text>
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

        {gig.rating && (
          <View style={styles.ratingBox}>
            <Text style={styles.ratingLabel}>💬 Feedback</Text>
            <Text style={styles.ratingText}>{gig.rating.feedback}</Text>
          </View>
        )}
      </View>
    );
  };

  const filteredGigs = getFilteredGigs();

  const renderAvailableJobCard = (job: AvailableJob) => (
    <View style={styles.availableJobCard}>
      <View style={styles.jobHeader}>
        <View style={styles.jobInfo}>
          <Text style={styles.jobTitle} numberOfLines={1}>{job.title}</Text>
          <Text style={styles.jobContractor}>by {job.contractorName}</Text>
        </View>
        <Text style={styles.jobAmount}>₹{job.amount}</Text>
      </View>
      <Text style={styles.jobDescription} numberOfLines={2}>{job.description}</Text>
      <View style={styles.jobMeta}>
        <View style={styles.jobMetaItem}>
          <MaterialIcons name="location-on" size={14} color="#E74C3C" />
          <Text style={styles.jobMetaText}>{job.location}</Text>
        </View>
        {job.workDuration && (
          <View style={styles.jobMetaItem}>
            <MaterialIcons name="schedule" size={14} color="#3498db" />
            <Text style={styles.jobMetaText}>{job.workDuration}</Text>
          </View>
        )}
      </View>
      <TouchableOpacity
        style={styles.bookButton}
        onPress={() => handleBookJob(job._id)}
        disabled={bookingLoading}
      >
        <MaterialIcons name="add-circle" size={18} color="#fff" />
        <Text style={styles.bookButtonText}>Book Now</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Gig History</Text>
        <TouchableOpacity
          onPress={() => {
            fetchAvailableJobs();
            setShowBookingModal(true);
          }}
          style={styles.bookingButton}
        >
          <MaterialIcons name="add" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Status Overview Cards */}
      <View style={styles.statusCardsContainer}>
        <TouchableOpacity
          style={[styles.statusCard, styles.completedCard, filter === 'completed' && styles.statusCardActive]}
          onPress={() => setFilter('completed')}
        >
          <View style={styles.statusCardContent}>
            <MaterialIcons name="check-circle" size={24} color="#27AE60" />
            <Text style={styles.statusCardValue}>{gigs.filter(g => g.paymentStatus === 'Paid').length}</Text>
            <Text style={styles.statusCardLabel}>Completed</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.statusCard, styles.pendingCard, filter === 'pending' && styles.statusCardActive]}
          onPress={() => setFilter('pending')}
        >
          <View style={styles.statusCardContent}>
            <MaterialIcons name="schedule" size={24} color="#F39C12" />
            <Text style={styles.statusCardValue}>{gigs.filter(g => g.paymentStatus !== 'Paid' && g.status !== 'cancelled').length}</Text>
            <Text style={styles.statusCardLabel}>Pending</Text>
          </View>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.statusCard, styles.cancelledCard, filter === 'cancelled' && styles.statusCardActive]}
          onPress={() => setFilter('cancelled')}
        >
          <View style={styles.statusCardContent}>
            <MaterialIcons name="cancel" size={24} color="#E74C3C" />
            <Text style={styles.statusCardValue}>{gigs.filter(g => g.status === 'cancelled').length}</Text>
            <Text style={styles.statusCardLabel}>Cancelled</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Filter Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
      >
        <View style={styles.filterContainer}>
          {(['all', 'completed', 'pending', 'cancelled'] as const).map((filterOption) => (
            <TouchableOpacity
              key={filterOption}
              style={[
                styles.filterButton,
                filter === filterOption && styles.filterButtonActive,
              ]}
              onPress={() => setFilter(filterOption)}
            >
              <Text
                style={[
                  styles.filterButtonText,
                  filter === filterOption && styles.filterButtonTextActive,
                ]}
              >
                {filterOption === 'all' ? 'All' : filterOption.charAt(0).toUpperCase() + filterOption.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </ScrollView>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#3498db" />
        </View>
      ) : filteredGigs.length === 0 ? (
        <View style={styles.emptyContainer}>
          <MaterialIcons name="work-outline" size={64} color="#BDC3C7" />
          <Text style={styles.emptyTitle}>No Gigs Found</Text>
          <Text style={styles.emptyText}>
            {filter === 'all'
              ? 'Start accepting jobs to see your gig history'
              : `No ${filter} gigs yet`}
          </Text>
          <TouchableOpacity
            style={styles.emptyActionButton}
            onPress={() => {
              fetchAvailableJobs();
              setShowBookingModal(true);
            }}
          >
            <MaterialIcons name="add-circle-outline" size={20} color="#fff" />
            <Text style={styles.emptyActionText}>Browse Available Jobs</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filteredGigs}
          keyExtractor={(item) => item._id}
          renderItem={({ item }) => renderGigCard(item)}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListFooterComponent={
            <>
              {/* Summary Card */}
              {filteredGigs.length > 0 && (
                <View style={styles.summaryCard}>
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>Total Gigs</Text>
                    <Text style={styles.summaryValue}>{filteredGigs.length}</Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>Earnings</Text>
                    <Text style={styles.summaryValue}>
                      ₹{filteredGigs.reduce((sum, gig) => sum + gig.amount, 0)}
                    </Text>
                  </View>
                  <View style={styles.summaryDivider} />
                  <View style={styles.summaryItem}>
                    <Text style={styles.summaryLabel}>Completed</Text>
                    <Text style={styles.summaryValue}>
                      {filteredGigs.filter(g => g.paymentStatus === 'Paid').length}
                    </Text>
                  </View>
                </View>
              )}
              <View style={{ height: 20 }} />
            </>
          }
        />
      )}

      {/* Booking Modal */}
      <Modal
        visible={showBookingModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowBookingModal(false)}
      >
        <View style={styles.modalContainer}>
          <View style={[styles.modalHeader, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
            <Text style={styles.modalTitle}>Available Jobs</Text>
            <TouchableOpacity onPress={() => setShowBookingModal(false)}>
              <MaterialIcons name="close" size={28} color="#000" />
            </TouchableOpacity>
          </View>

          {bookingLoading ? (
            <View style={styles.centerContainer}>
              <ActivityIndicator size="large" color="#3498db" />
            </View>
          ) : availableJobs.length === 0 ? (
            <View style={styles.emptyContainer}>
              <MaterialIcons name="inbox" size={64} color="#BDC3C7" />
              <Text style={styles.emptyTitle}>No Jobs Available</Text>
              <Text style={styles.emptyText}>Check back later for new opportunities</Text>
            </View>
          ) : (
            <ScrollView style={styles.modalContent} showsVerticalScrollIndicator={false}>
              {availableJobs.map(job => (
                <View key={job._id}>
                  {renderAvailableJobCard(job)}
                </View>
              ))}
              <View style={{ height: 20 }} />
            </ScrollView>
          )}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
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
  bookingButton: {
    padding: 8,
    backgroundColor: '#3498db',
    borderRadius: 20,
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
  filterScroll: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  filterContainer: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  filterButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  filterButtonActive: {
    backgroundColor: '#3498db',
    borderColor: '#3498db',
  },
  filterButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#7F8C8D',
  },
  filterButtonTextActive: {
    color: '#fff',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    marginTop: 16,
  },
  emptyText: {
    fontSize: 14,
    color: '#7F8C8D',
    marginTop: 8,
    textAlign: 'center',
  },
  emptyActionButton: {
    flexDirection: 'row',
    backgroundColor: '#3498db',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    gap: 8,
    marginTop: 20,
  },
  emptyActionText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 12,
  },
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
  summaryCard: {
    backgroundColor: '#fff',
    flexDirection: 'row',
    marginHorizontal: 0,
    marginBottom: 16,
    marginTop: 16,
    borderRadius: 12,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  summaryItem: {
    flex: 1,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryLabel: {
    fontSize: 11,
    color: '#7F8C8D',
    marginBottom: 4,
    fontWeight: '500',
  },
  summaryValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
  },
  summaryDivider: {
    width: 1,
    backgroundColor: '#e0e0e0',
  },
  // Modal Styles
  modalContainer: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
  },
  modalContent: {
    flex: 1,
    padding: 12,
  },
  availableJobCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  jobHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  jobInfo: {
    flex: 1,
    marginRight: 8,
  },
  jobTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000',
    marginBottom: 2,
  },
  jobContractor: {
    fontSize: 12,
    color: '#7F8C8D',
  },
  jobAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#27AE60',
  },
  jobDescription: {
    fontSize: 12,
    color: '#555',
    marginBottom: 8,
    lineHeight: 16,
  },
  jobMeta: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 10,
  },
  jobMetaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  jobMetaText: {
    fontSize: 11,
    color: '#7F8C8D',
  },
  bookButton: {
    flexDirection: 'row',
    backgroundColor: '#3498db',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  bookButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 13,
  },
  // Status Cards Styles
  statusCardsContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  statusCard: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  statusCardActive: {
    borderColor: '#3498db',
    backgroundColor: '#E8F4F8',
  },
  completedCard: {
    backgroundColor: '#F0FDF4',
  },
  pendingCard: {
    backgroundColor: '#FEF8E8',
  },
  cancelledCard: {
    backgroundColor: '#FEF2F2',
  },
  statusCardContent: {
    alignItems: 'center',
    gap: 4,
  },
  statusCardValue: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    marginTop: 2,
  },
  statusCardLabel: {
    fontSize: 11,
    color: '#666',
    fontWeight: '500',
    marginTop: 2,
  },
});
