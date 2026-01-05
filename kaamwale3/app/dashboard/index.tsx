import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StyleSheet,
  Modal,
  Image,
  Linking,
} from 'react-native';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { API_BASE } from '../../utils/config';
import { socket } from '../../utils/socket';
import * as Location from 'expo-location';

interface Job {
  _id: string;
  id?: string;
  title: string;
  description: string;
  amount: string;
  contractorName: string;
  acceptedBy: string;
  status: string;
  timestamp: string;
  attendanceStatus?: 'Present' | 'Absent' | null;
  paymentStatus?: 'Paid' | null;
  acceptedWorker?: {
    id: string;
    name: string;
    phone: string;
    profilePhoto?: string;
    location?: {
      type: string;
      coordinates: [number, number];
    };
    skills?: string[];
  };
}

interface AggregatedStats {
  totalJobsPosted: number;
  totalJobsCompleted: number;
  totalWorkersEngaged: number;
  totalSpending: number;
  avgJobsPerDay: string | number;
  avgCompletionPerDay: string | number;
}

export default function DashboardScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string>('');
  const [contractorName, setContractorName] = useState<string>('');
  const [dateRange, setDateRange] = useState<'today' | 'week' | 'month'>('today');
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  const [historicalStats, setHistoricalStats] = useState<any[]>([]);
  
  // Worker details modal state
  const [showWorkerModal, setShowWorkerModal] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [workerDetails, setWorkerDetails] = useState<any | null>(null);
  const [workerLocationName, setWorkerLocationName] = useState<string>('Loading location...');
  const [workerCurrentLocation, setWorkerCurrentLocation] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem('user');
        const savedToken = await AsyncStorage.getItem('token');

        if (savedToken) setToken(savedToken);
        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setContractorName(user.name);
        }

        if (savedToken) {
          await fetchJobs(savedToken, userStr ? JSON.parse(userStr).name : '');
          await fetchStats(savedToken, 'today');
        }
      } catch (err) {
        console.error('Failed to load user or token', err);
      }
    })();
  }, []);

  // Listen for real-time worker location updates
  useEffect(() => {
    if (!showWorkerModal || !selectedJob || !workerDetails) return;

    const handleWorkerLocationUpdate = (data: any) => {
      // Match by worker phone from acceptedWorker data
      if (data.phone === workerDetails.phone && data.location?.coordinates) {
        const [lon, lat] = data.location.coordinates;
        setWorkerCurrentLocation({ lat, lon });
        getLocationName(lat, lon).then(setWorkerLocationName);
      }
    };

    socket.on("workerLocationUpdate", handleWorkerLocationUpdate);

    return () => {
      socket.off("workerLocationUpdate", handleWorkerLocationUpdate);
    };
  }, [showWorkerModal, selectedJob, workerDetails]);

  const fetchJobs = async (savedToken: string, name: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/jobs`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${savedToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch jobs');

      const data: Job[] = await res.json();
      const myJobs = data.filter(
        (j) => j.contractorName === name && j.status === 'accepted'
      );

      setJobs(myJobs);
    } catch (err) {
      console.error('Job fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchStats = async (savedToken: string, range: 'today' | 'week' | 'month') => {
    try {
      const res = await fetch(`${API_BASE}/contractor/stats?range=${range}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${savedToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch stats');

      const data = await res.json();
      if (data.success) {
        setStats(data.aggregated);
        setHistoricalStats(data.stats);
      }
    } catch (err) {
      console.error('Stats fetch error:', err);
      // Fallback to calculating from jobs
      calculateStatsFromJobs();
    }
  };

  const calculateStatsFromJobs = () => {
    const today = new Date().toDateString();
    const jobsPosted = jobs.length;
    const jobsCompleted = jobs.filter(
      (j) => new Date(j.timestamp).toDateString() === today && j.paymentStatus === 'Paid'
    ).length;
    const workersEngaged = new Set(
      jobs
        .filter((j) => new Date(j.timestamp).toDateString() === today)
        .map((j) => j.acceptedBy)
    ).size;
    const totalSpending = jobs.reduce((sum, j) => sum + Number(j.amount), 0);

    setStats({
      totalJobsPosted: jobsPosted,
      totalJobsCompleted: jobsCompleted,
      totalWorkersEngaged: workersEngaged,
      totalSpending,
      avgJobsPerDay: jobsPosted,
      avgCompletionPerDay: jobsCompleted,
    });
  };

  const handleDateRangeChange = async (newRange: 'today' | 'week' | 'month') => {
    setDateRange(newRange);
    if (token) {
      await fetchStats(token, newRange);
    }
  };

  // Get location name from coordinates
  const getLocationName = async (latitude: number, longitude: number) => {
    try {
      const address = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (address && address[0]) {
        const { name, street, city, district } = address[0];
        const locationParts = [name, street, city, district].filter(Boolean);
        const locationText = locationParts.join(", ");
        return locationText || `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
      }
      return `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    } catch (err) {
      console.error("Failed to reverse geocode:", err);
      return `${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`;
    }
  };

  // Open worker details modal
  const handleJobCardClick = async (job: Job) => {
    // Don't show modal if job is already paid
    if (job.paymentStatus === 'Paid') {
      Alert.alert('Job Completed', 'This job has already been paid.');
      return;
    }

    setSelectedJob(job);
    setShowWorkerModal(true);
    setWorkerLocationName('Loading location...');

    try {
      // Use acceptedWorker data from job (already has phone, profile photo, location)
      if (job.acceptedWorker) {
        setWorkerDetails(job.acceptedWorker);
        
        // Get location name if available
        if (job.acceptedWorker.location?.coordinates && job.acceptedWorker.location.coordinates.length === 2) {
          const [lon, lat] = job.acceptedWorker.location.coordinates;
          setWorkerCurrentLocation({ lat, lon });
          const locationName = await getLocationName(lat, lon);
          setWorkerLocationName(locationName);
        }
      }
    } catch (err) {
      console.error('Failed to fetch worker details:', err);
      setWorkerLocationName('Location unavailable');
    }
  };

  // Close worker modal
  const handleCloseWorkerModal = () => {
    setShowWorkerModal(false);
    setSelectedJob(null);
    setWorkerDetails(null);
  };

  const today = new Date().toDateString();
  const jobsWithAttendance = jobs.filter(
    (j) => j.attendanceStatus && new Date(j.timestamp).toDateString() === today
  );

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <MaterialIcons name="arrow-back" size={28} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Dashboard</Text>
        <View style={{ width: 28 }} />
      </View>

      {/* Date Range Filter */}
      <View style={styles.dateFilterContainer}>
        <TouchableOpacity
          style={[styles.filterButton, dateRange === 'today' && styles.filterButtonActive]}
          onPress={() => handleDateRangeChange('today')}
        >
          <Text style={[styles.filterText, dateRange === 'today' && styles.filterTextActive]}>Today</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, dateRange === 'week' && styles.filterButtonActive]}
          onPress={() => handleDateRangeChange('week')}
        >
          <Text style={[styles.filterText, dateRange === 'week' && styles.filterTextActive]}>This Week</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, dateRange === 'month' && styles.filterButtonActive]}
          onPress={() => handleDateRangeChange('month')}
        >
          <Text style={[styles.filterText, dateRange === 'month' && styles.filterTextActive]}>This Month</Text>
        </TouchableOpacity>
      </View>

      {/* Stats Cards */}
      <View style={styles.statsContainer}>
        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="assignment" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalJobsPosted || 0}</Text>
          <Text style={styles.statLabel}>Jobs Posted</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="check-circle" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalJobsCompleted || 0}</Text>
          <Text style={styles.statLabel}>Completed</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="people" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalWorkersEngaged || 0}</Text>
          <Text style={styles.statLabel}>Workers</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="attach-money" size={32} color="#fff" />
          <Text style={styles.statValue}>₹{stats?.totalSpending || 0}</Text>
          <Text style={styles.statLabel}>Spending</Text>
        </LinearGradient>
      </View>

      {/* Trends Section */}
      {dateRange !== 'today' && historicalStats.length > 0 && (
        <View style={styles.trendContainer}>
          <Text style={styles.trendTitle}>📊 Trends & Insights</Text>
          <View style={styles.trendCard}>
            <Text style={styles.trendText}>Average Jobs/Day: {stats?.avgJobsPerDay || 0}</Text>
            <Text style={styles.trendText}>Avg Completion/Day: {stats?.avgCompletionPerDay || 0}</Text>
          </View>
        </View>
      )}

      {/* Today's Worker Activity */}
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>Today's Worker Activity</Text>

        {loading ? (
          <ActivityIndicator size="large" color="#1a2f4d" style={{ marginTop: 20 }} />
        ) : jobsWithAttendance.length === 0 ? (
          <Text style={styles.noDataText}>No workers marked attendance today</Text>
        ) : (
          jobsWithAttendance.map((job) => (
            <View key={job._id} style={styles.workerCard}>
              {/* Background bubbles for visual appeal */}
              <View style={[styles.cardBubble, { position: 'absolute', left: 10, top: 10, backgroundColor: 'rgba(108, 92, 231, 0.08)' }]} />
              <View style={[styles.cardBubble, { position: 'absolute', right: 10, bottom: 10, backgroundColor: 'rgba(0, 184, 148, 0.08)', width: 60, height: 60 }]} />
              
              <View style={styles.workerInfo}>
                <Text style={styles.workerName}>{job.acceptedBy}</Text>
                <Text style={styles.jobTitle}>{job.title}</Text>
                <View style={styles.jobDetails}>
                  <Text style={styles.detailText}>₹{job.amount}</Text>
                  <Text
                    style={[
                      styles.detailText,
                      {
                        color:
                          job.attendanceStatus === 'Present'
                            ? '#00b894'
                            : '#e17055',
                      },
                    ]}
                  >
                    {job.attendanceStatus}
                  </Text>
                </View>
              </View>

              <View style={styles.paymentBadge}>
                {job.paymentStatus === 'Paid' ? (
                  <>
                    <MaterialIcons name="check-circle" size={20} color="#00b894" />
                    <Text style={{ color: '#00b894', fontWeight: '700' }}>Paid</Text>
                  </>
                ) : (
                  <>
                    <MaterialIcons name="pending" size={20} color="#f39c12" />
                    <Text style={{ color: '#f39c12', fontWeight: '700' }}>Pending</Text>
                  </>
                )}
              </View>
            </View>
          ))
        )}
      </View>

      {/* All Jobs Section */}
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>All Posted Jobs</Text>

        {jobs.length === 0 ? (
          <Text style={styles.noDataText}>No jobs posted yet</Text>
        ) : (
          jobs.map((job) => (
            <TouchableOpacity key={job._id} style={styles.jobCard} onPress={() => handleJobCardClick(job)}>
              <View style={styles.jobCardHeader}>
                <Text style={styles.jobCardTitle}>{job.title}</Text>
                <Text style={styles.jobAmount}>₹{job.amount}</Text>
              </View>
              <Text style={styles.jobDescription}>{job.description}</Text>
              <View style={styles.jobCardFooter}>
                <Text style={styles.workerAccepted}>Worker: {job.acceptedBy}</Text>
                <View
                  style={[
                    styles.statusBadge,
                    {
                      backgroundColor:
                        job.paymentStatus === 'Paid' ? '#00b894' : '#f39c12',
                    },
                  ]}
                >
                  <Text style={styles.statusText}>
                    {job.paymentStatus || 'Pending'}
                  </Text>
                </View>
              </View>
            </TouchableOpacity>
          ))
        )}
      </View>

      {/* Performance Tips */}
      <View style={styles.tipsContainer}>
        <Text style={styles.tipsTitle}>💡 Performance Tips</Text>
        <Text style={styles.tipText}>
          • Pay workers on time to improve satisfaction and get better ratings
        </Text>
        <Text style={styles.tipText}>
          • Clearly describe jobs to attract more qualified workers
        </Text>
        <Text style={styles.tipText}>
          • Complete at least 1 job weekly to maintain active status
        </Text>
      </View>

      <View style={{ height: 40 }} />

      {/* Worker Details Modal */}
      <Modal visible={showWorkerModal} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {/* Close Button */}
            <TouchableOpacity style={styles.modalCloseBtn} onPress={handleCloseWorkerModal}>
              <Ionicons name="close" size={28} color="#2d3436" />
            </TouchableOpacity>

            {/* Worker Profile Photo */}
            {workerDetails?.profilePhoto ? (
              <Image 
                source={{ uri: workerDetails.profilePhoto }} 
                style={styles.workerProfilePhoto}
              />
            ) : (
              <View style={[styles.workerProfilePhoto, { backgroundColor: "#e5e7eb", justifyContent: "center", alignItems: "center" }]}>
                <Ionicons name="person" size={50} color="#9ca3af" />
              </View>
            )}

            {/* Worker Info */}
            <Text style={styles.workerModalName}>{selectedJob?.acceptedBy || 'Worker'}</Text>
            
            {/* Worker ID */}
            <View style={styles.workerIdContainer}>
              <MaterialIcons name="badge" size={16} color="#667eea" />
              <Text style={styles.workerIdText}>ID: {workerDetails?.id || 'N/A'}</Text>
            </View>

            {/* Action Buttons */}
            <View style={styles.actionButtonsContainer}>
              {/* Call Button */}
              <TouchableOpacity style={styles.actionBtn} onPress={() => Linking.openURL(`tel:${workerDetails?.phone}`)}>
                <Ionicons name="call" size={20} color="#fff" />
                <Text style={styles.actionBtnText}>Call</Text>
              </TouchableOpacity>

              {/* Message Button */}
              <TouchableOpacity style={styles.actionBtn} onPress={() => Linking.openURL(`sms:${workerDetails?.phone}`)}>
                <Ionicons name="chatbubble" size={20} color="#fff" />
                <Text style={styles.actionBtnText}>Message</Text>
              </TouchableOpacity>
            </View>

            {/* Location Section */}
            <View style={styles.locationSection}>
              <Ionicons name="location" size={20} color="#6366f1" />
              <Text style={styles.locationLabel}>Current Location</Text>
            </View>
            
            {workerCurrentLocation ? (
              <View style={styles.locationCard}>
                <Text style={styles.locationText}>{workerLocationName}</Text>
                <Text style={styles.coordinatesText}>
                  {workerCurrentLocation.lat.toFixed(4)}°, {workerCurrentLocation.lon.toFixed(4)}°
                </Text>
              </View>
            ) : (
              <View style={styles.locationCard}>
                <ActivityIndicator size="small" color="#667eea" />
                <Text style={styles.locationText}>{workerLocationName}</Text>
              </View>
            )}

            {/* Close Modal Button */}
            <TouchableOpacity style={styles.closeModalBtn} onPress={handleCloseWorkerModal}>
              <Text style={styles.closeModalBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f6fa',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#2d3436',
    paddingHorizontal: 16,
    paddingVertical: 20,
    paddingTop: 40,
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#fff',
  },
  dateFilterContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
    backgroundColor: '#fff',
  },
  filterButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: '#f5f6fa',
    borderWidth: 1,
    borderColor: '#dfe6e9',
    alignItems: 'center',
  },
  filterButtonActive: {
    backgroundColor: '#1a2f4d ',
    borderColor: '#6c5ce7',
  },
  filterText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#636e72',
  },
  filterTextActive: {
    color: '#fff',
  },
  statsContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 12,
    gap: 12,
  },
  statCard: {
    width: '48%',
    borderRadius: 16,
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    overflow: 'hidden',
  },
  statValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#fff',
    marginTop: 8,
  },
  statLabel: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
    textAlign: 'center',
  },
  cardBubble: {
    width: 40,
    height: 40,
    borderRadius: 100,
    position: 'absolute',
    zIndex: 0,
  },
  trendContainer: {
    marginHorizontal: 16,
    marginTop: 16,
  },
  trendTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2d3436',
    marginBottom: 10,
  },
  trendCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  trendText: {
    fontSize: 13,
    color: '#636e72',
    marginBottom: 6,
    fontWeight: '600',
  },
  sectionContainer: {
    marginHorizontal: 16,
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#2d3436',
    marginBottom: 12,
  },
  workerCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  workerInfo: {
    flex: 1,
  },
  workerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#2d3436',
  },
  jobTitle: {
    fontSize: 13,
    color: '#636e72',
    marginTop: 4,
  },
  jobDetails: {
    flexDirection: 'row',
    marginTop: 8,
    gap: 12,
  },
  detailText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#636e72',
  },
  paymentBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: '#f5f6fa',
    borderRadius: 8,
  },
  jobCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  jobCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  jobCardTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#2d3436',
    flex: 1,
  },
  jobAmount: {
    fontSize: 15,
    fontWeight: '700',
    color: '#00b894',
  },
  jobDescription: {
    fontSize: 13,
    color: '#636e72',
    marginBottom: 10,
  },
  jobCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  workerAccepted: {
    fontSize: 12,
    color: '#636e72',
  },
  statusBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  statusText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  noDataText: {
    textAlign: 'center',
    color: '#b2bec3',
    fontSize: 14,
    paddingVertical: 20,
  },
 
  tipsContainer: {
    marginHorizontal: 16,
    marginTop: 24,
    backgroundColor: '#fff3cd',
    borderRadius: 12,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#ffc107',
  },
  tipsTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#856404',
    marginBottom: 10,
  },
  tipText: {
    fontSize: 13,
    color: '#856404',
    marginBottom: 6,
    lineHeight: 18,
  },
  // Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  modalCard: {
    width: '90%',
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  modalCloseBtn: {
    position: 'absolute',
    top: 12,
    right: 12,
    zIndex: 10,
  },
  workerProfilePhoto: {
    width: 120,
    height: 120,
    borderRadius: 60,
    marginBottom: 16,
    borderWidth: 3,
    borderColor: '#667eea',
  },
  workerModalName: {
    fontSize: 24,
    fontWeight: '700',
    color: '#2d3436',
    marginBottom: 8,
  },
  workerIdContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 16,
  },
  workerIdText: {
    marginLeft: 6,
    fontSize: 14,
    color: '#374151',
    fontWeight: '600',
  },
  actionButtonsContainer: {
    flexDirection: 'row',
    gap: 12,
    width: '100%',
    marginBottom: 20,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#667eea',
    paddingVertical: 12,
    borderRadius: 10,
    gap: 6,
  },
  actionBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  locationSection: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 12,
  },
  locationLabel: {
    marginLeft: 8,
    fontSize: 16,
    fontWeight: '700',
    color: '#2d3436',
  },
  locationCard: {
    width: '100%',
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  locationText: {
    fontSize: 14,
    color: '#374151',
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
  coordinatesText: {
    fontSize: 12,
    color: '#9ca3af',
    textAlign: 'center',
  },
  closeModalBtn: {
    width: '100%',
    backgroundColor: '#667eea',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  closeModalBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
