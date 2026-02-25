import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Modal,
  Image,
  Linking,
  TextInput,
} from 'react-native';
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useLanguage } from '../../context/LanguageContext';
import { useAuth } from '../../context/AuthContext';
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
  contractorPhone?: string;
  acceptedBy: string;
  status: string;
  timestamp: string;
  createdAt?: string;
  date?: string;
  isCancelled?: boolean;
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

interface AdminStats {
  totalUsers: number;
  totalWorkers: number;
  totalJobs: number;
  openTickets: number;
  pendingDocuments: number;
}

interface AdminLookupData {
  user?: any;
  worker?: any;
  wallet?: any;
  bankAccount?: any;
  verification?: any;
  contractorStats?: any[];
  supportTickets?: any[];
  activityLogs?: any[];
  cancellationLogs?: any[];
  jobs?: {
    asContractor?: any[];
    asWorker?: any[];
  };
  summaries?: {
    worker?: any;
    contractor?: any;
  };
}

interface AdminContractorUser {
  _id?: string;
  phone: string;
  name?: string;
  email?: string;
  role?: string;
  createdAt?: string;
}

interface AdminWorkerUser {
  _id?: string;
  phone: string;
  name?: string;
  workerType?: string;
  avgRating?: number;
  jobsCompleted?: number;
  skills?: string[];
  isVerified?: boolean;
  isAvailable?: boolean;
  city?: string;
  createdAt?: string;
}

export default function DashboardScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState<string>('');
  const [dateRange, setDateRange] = useState<'today' | 'week' | 'month'>('today');
  const [showAllTodayAcceptances, setShowAllTodayAcceptances] = useState(false);
  const todayLabel = String(t('today') || '').trim() || 'Today';
  const [stats, setStats] = useState<AggregatedStats | null>(null);
  
  // Worker details modal state
  const [showWorkerModal, setShowWorkerModal] = useState(false);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [workerDetails, setWorkerDetails] = useState<any | null>(null);
  const [workerLocationName, setWorkerLocationName] = useState<string>('Loading location...');
  const [workerCurrentLocation, setWorkerCurrentLocation] = useState<{ lat: number; lon: number } | null>(null);
  
  // ✅ Modal state for alerts
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<"success" | "error" | "info">("success");

  // Admin dashboard state
  const [adminStats, setAdminStats] = useState<AdminStats | null>(null);
  const [pendingVerifications, setPendingVerifications] = useState<any[]>([]);
  const [pendingBankAccounts, setPendingBankAccounts] = useState<any[]>([]);
  const [supportTickets, setSupportTickets] = useState<any[]>([]);
  const [premiumSubscriptions, setPremiumSubscriptions] = useState<any[]>([]);
  const [adminUsers, setAdminUsers] = useState<AdminContractorUser[]>([]);
  const [adminWorkers, setAdminWorkers] = useState<AdminWorkerUser[]>([]);
  const [adminJobs, setAdminJobs] = useState<any[]>([]);
  const [adminOverview, setAdminOverview] = useState<any | null>(null);
  const [premiumRecon, setPremiumRecon] = useState<{ latestRun: any | null; mismatches: any[]; mismatchCount: number }>({
    latestRun: null,
    mismatches: [],
    mismatchCount: 0,
  });
  const [lookupPhone, setLookupPhone] = useState('');
  const [lookupData, setLookupData] = useState<AdminLookupData | null>(null);
  const [selectedContractorDetails, setSelectedContractorDetails] = useState<AdminLookupData | null>(null);
  const [selectedContractorPhone, setSelectedContractorPhone] = useState<string>('');
  const [contractorDetailModalVisible, setContractorDetailModalVisible] = useState(false);
  const [selectedWorkerDetails, setSelectedWorkerDetails] = useState<AdminLookupData | null>(null);
  const [selectedWorkerPhone, setSelectedWorkerPhone] = useState<string>('');
  const [workerDetailModalVisible, setWorkerDetailModalVisible] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminActionLoading, setAdminActionLoading] = useState(false);
  
  const showModal = (type: "success" | "error" | "info", title: string, message: string) => {
    setModalType(type);
    setModalTitle(title);
    setModalMessage(message);
    setModalVisible(true);
  };

  const isAdmin = authUser?.role === 'admin';

  const adminFetch = async (path: string, options: RequestInit = {}) => {
    if (!token) throw new Error('Missing auth token');
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.success === false) {
      throw new Error(data?.message || 'Request failed');
    }

    return data;
  };

  useEffect(() => {
    (async () => {
      try {
        const userStr = authUser ? JSON.stringify(authUser) : null;
        const savedToken = accessToken;

        if (savedToken) setToken(savedToken);
        if (savedToken && isAdmin) {
          await loadAdminData(savedToken);
        } else if (savedToken) {
          await fetchJobs(savedToken, userStr ? JSON.parse(userStr).name : '');
          await fetchStats(savedToken, 'today');
        }
      } catch (err) {
        console.error('Failed to load user or token', err);
      }
    })();
  }, [accessToken, authUser, isAdmin]);

  // Listen for real-time worker location updates
  useEffect(() => {
    if (isAdmin) return;
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

  const loadAdminData = async (providedToken?: string) => {
    const currentToken = providedToken || token;
    if (!currentToken) return;

    setAdminLoading(true);
    try {
      const headers = {
        Authorization: `Bearer ${currentToken}`,
        'Content-Type': 'application/json',
      };

      const fetchAllPages = async (path: string, listKey: string, pageSize = 500) => {
        let page = 1;
        const allItems: any[] = [];

        while (true) {
          const separator = path.includes('?') ? '&' : '?';
          const response = await fetch(`${API_BASE}${path}${separator}page=${page}&limit=${pageSize}`, { headers });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || data?.success === false) {
            throw new Error(data?.message || `Failed loading ${path}`);
          }

          const chunk = Array.isArray(data?.[listKey]) ? data[listKey] : [];
          allItems.push(...chunk);

          const total = Number(data?.total ?? allItems.length);
          if (chunk.length === 0 || chunk.length < pageSize || allItems.length >= total) {
            break;
          }
          page += 1;
        }

        return allItems;
      };

      const [dashboardRes, users, workers, jobs, verifications, bankAccounts, tickets, premiumSubs, premiumReconRes] = await Promise.all([
        fetch(`${API_BASE}/admin/dashboard`, { headers }),
        fetchAllPages('/admin/users', 'users'),
        fetchAllPages('/admin/workers', 'workers'),
        fetchAllPages('/admin/jobs', 'jobs'),
        fetchAllPages('/admin/verifications', 'verifications'),
        fetchAllPages('/admin/bank-accounts', 'bankAccounts'),
        fetchAllPages('/admin/support-tickets', 'tickets'),
        fetchAllPages('/admin/premium/subscriptions', 'subscriptions', 200),
        fetch(`${API_BASE}/admin/premium/reconciliation/latest`, { headers }),
      ]);

      const dashboardData = await dashboardRes.json().catch(() => ({}));
      const premiumReconData = await premiumReconRes.json().catch(() => ({}));

      if (dashboardData?.success) {
        setAdminOverview(dashboardData.stats || null);
        setAdminStats({
          totalUsers: dashboardData.stats?.totalUsers || 0,
          totalWorkers: dashboardData.stats?.totalWorkers || 0,
          totalJobs: dashboardData.stats?.totalJobs || 0,
          openTickets: dashboardData.stats?.openTickets || 0,
          pendingDocuments: dashboardData.stats?.pendingDocuments || 0,
        });
      }

      setAdminUsers(Array.isArray(users) ? users : []);

      setAdminWorkers(Array.isArray(workers) ? workers : []);

      setAdminJobs(Array.isArray(jobs) ? jobs : []);

      const verificationsList = Array.isArray(verifications) ? verifications : [];
      const pending = verificationsList.filter((v: any) =>
        Array.isArray(v.documents) && v.documents.some((d: any) => d.verificationStatus === 'pending')
      );
      setPendingVerifications(pending);

      const bankList = Array.isArray(bankAccounts) ? bankAccounts : [];
      setPendingBankAccounts(bankList.filter((b: any) => b.verificationStatus === 'pending'));

      setSupportTickets(Array.isArray(tickets) ? tickets : []);

      setPremiumSubscriptions(Array.isArray(premiumSubs) ? premiumSubs : []);

      if (premiumReconData?.success) {
        setPremiumRecon({
          latestRun: premiumReconData.latestRun || null,
          mismatches: Array.isArray(premiumReconData.mismatches) ? premiumReconData.mismatches : [],
          mismatchCount: Number(premiumReconData.mismatchCount || 0),
        });
      } else {
        setPremiumRecon({ latestRun: null, mismatches: [], mismatchCount: 0 });
      }
    } catch (err) {
      console.error('Admin dashboard load error:', err);
      showModal('error', 'Admin Error', err instanceof Error ? err.message : 'Failed to load admin data');
    } finally {
      setAdminLoading(false);
    }
  };

  const handlePhoneLookup = async () => {
    const phone = lookupPhone.trim();
    if (!/^\d{10}$/.test(phone)) {
      showModal('error', 'Invalid Phone', 'Enter a valid 10-digit phone number.');
      return;
    }

    setAdminActionLoading(true);
    try {
      const data = await adminFetch(`/admin/lookup/${phone}`);
      setLookupData(data.data || null);
    } catch (err) {
      setLookupData(null);
      showModal('error', 'Lookup Failed', err instanceof Error ? err.message : 'Failed to lookup phone');
    } finally {
      setAdminActionLoading(false);
    }
  };

  const handleViewContractor = async (phone: string) => {
    if (!/^\d{10}$/.test(phone)) {
      showModal('error', 'Invalid Phone', 'Contractor phone is invalid.');
      return;
    }

    setAdminActionLoading(true);
    try {
      const data = await adminFetch(`/admin/lookup/${phone}`);
      setSelectedContractorPhone(phone);
      setSelectedContractorDetails(data.data || null);
      setContractorDetailModalVisible(true);
    } catch (err) {
      showModal('error', 'View Failed', err instanceof Error ? err.message : 'Failed to load contractor details');
    } finally {
      setAdminActionLoading(false);
    }
  };

  const handleViewWorker = async (phone: string) => {
    if (!/^\d{10}$/.test(phone)) {
      showModal('error', 'Invalid Phone', 'Worker phone is invalid.');
      return;
    }

    setAdminActionLoading(true);
    try {
      const data = await adminFetch(`/admin/lookup/${phone}`);
      setSelectedWorkerPhone(phone);
      setSelectedWorkerDetails(data.data || null);
      setWorkerDetailModalVisible(true);
    } catch (err) {
      showModal('error', 'View Failed', err instanceof Error ? err.message : 'Failed to load worker details');
    } finally {
      setAdminActionLoading(false);
    }
  };

  const handleVerifyBank = async (bankId: string, approve: boolean) => {
    setAdminActionLoading(true);
    try {
      const path = approve ? `/admin/bank-accounts/${bankId}/verify` : `/admin/bank-accounts/${bankId}/reject`;
      await adminFetch(path, {
        method: 'POST',
        body: JSON.stringify({ reason: approve ? '' : 'Rejected by admin from mobile dashboard' }),
      });
      await loadAdminData();
      showModal('success', 'Bank Updated', `Bank account ${approve ? 'approved' : 'rejected'} successfully.`);
    } catch (err) {
      showModal('error', 'Bank Action Failed', err instanceof Error ? err.message : 'Failed to update bank account');
    } finally {
      setAdminActionLoading(false);
    }
  };

  const handleVerifyDocument = async (verificationId: string, documentId: string, approve: boolean) => {
    setAdminActionLoading(true);
    try {
      await adminFetch('/admin/verify-document', {
        method: 'POST',
        body: JSON.stringify({
          verificationId,
          documentId,
          status: approve ? 'approved' : 'rejected',
          rejectionReason: approve ? '' : 'Rejected by admin from mobile dashboard',
        }),
      });
      await loadAdminData();
      showModal('success', 'Verification Updated', `Document ${approve ? 'approved' : 'rejected'} successfully.`);
    } catch (err) {
      showModal('error', 'Verification Failed', err instanceof Error ? err.message : 'Failed to update document');
    } finally {
      setAdminActionLoading(false);
    }
  };

  const handleSupportStatus = async (ticketId: string, status: string) => {
    setAdminActionLoading(true);
    try {
      await adminFetch(`/admin/support-tickets/${ticketId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({
          status,
          resolutionNotes: status === 'resolved' ? 'Resolved by admin from mobile dashboard' : '',
        }),
      });
      await loadAdminData();
      showModal('success', 'Ticket Updated', `Ticket moved to ${status}.`);
    } catch (err) {
      showModal('error', 'Support Update Failed', err instanceof Error ? err.message : 'Failed to update support ticket');
    } finally {
      setAdminActionLoading(false);
    }
  };

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
      const authPhone = authUser?.phone;
      const myJobs = data.filter((j) => {
        const isMineByPhone = !!authPhone && j.contractorPhone === authPhone;
        const isMineByName = !authPhone && j.contractorName === name;
        const isCancelled = j.isCancelled === true || String(j.status || '').toLowerCase() === 'cancelled';
        return (isMineByPhone || isMineByName) && !isCancelled;
      });

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
        .flatMap((j) => [
          ...(j.acceptedBy ? [j.acceptedBy] : []),
          ...((Array.isArray((j as any).acceptedWorkers) ? (j as any).acceptedWorkers : [])
            .map((w: any) => w?.phone)
            .filter(Boolean)),
        ])
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
    setShowAllTodayAcceptances(false);
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
      showModal('info', 'Job Completed', 'This job has already been paid.');
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

  // Single source of truth for admin: web admin panel.
  if (isAdmin) {
    const webAdminUrl = `${API_BASE}/admin/index.html`;
    return (
      <ScrollView style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()}>
            <MaterialIcons name="arrow-back" size={28} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Admin Console</Text>
          <View style={{ width: 24 }} />
        </View>

        <View style={styles.sectionContainer}>
          <View style={styles.adminListCard}>
            <Text style={styles.lookupTitle}>Admin Panel Moved</Text>
            <Text style={styles.lookupLine}>
              To keep one source of truth, admin operations now run from the web panel.
            </Text>
            <Text style={[styles.lookupLine, { marginTop: 8 }]}>URL: {webAdminUrl}</Text>

            <View style={styles.adminActionRow}>
              <TouchableOpacity
                style={styles.reviewBtn}
                onPress={async () => {
                  try {
                    await Linking.openURL(webAdminUrl);
                  } catch (err) {
                    showModal('error', 'Open Failed', 'Could not open web admin panel.');
                  }
                }}
              >
                <Text style={styles.actionBtnText}>Open Web Admin</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScrollView>
    );
  }

  const getJobDate = (job: Job) => {
    const raw = job.timestamp || job.createdAt || job.date;
    const parsed = raw ? new Date(raw) : new Date(0);
    return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  };

  const isJobInSelectedRange = (job: Job) => {
    const jobDate = getJobDate(job);
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (dateRange === 'today') {
      const tomorrowStart = new Date(todayStart);
      tomorrowStart.setDate(tomorrowStart.getDate() + 1);
      return jobDate >= todayStart && jobDate < tomorrowStart;
    }

    if (dateRange === 'week') {
      const weekStart = new Date(todayStart);
      weekStart.setDate(weekStart.getDate() - 6);
      return jobDate >= weekStart;
    }

    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 29);
    return jobDate >= monthStart;
  };

  const today = new Date().toDateString();
  // ✅ Show jobs that were ACCEPTED today (not just jobs with attendance marked)
  const jobsWithAttendance = jobs.filter((j) => {
    if (!j.acceptedBy) return false;
    const acceptedDate = getJobDate(j).toDateString();
    return acceptedDate === today;
  });
  const visibleTodayAcceptances = showAllTodayAcceptances ? jobsWithAttendance : jobsWithAttendance.slice(0, 2);
  const hasMoreTodayAcceptances = jobsWithAttendance.length > 2;
  const jobsForWeekOrMonth = jobs.filter((j) => isJobInSelectedRange(j));

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
          <Text style={[styles.filterText, dateRange === 'today' && styles.filterTextActive]}>{todayLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, dateRange === 'week' && styles.filterButtonActive]}
          onPress={() => handleDateRangeChange('week')}
        >
          <Text style={[styles.filterText, dateRange === 'week' && styles.filterTextActive]}>Week</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.filterButton, dateRange === 'month' && styles.filterButtonActive]}
          onPress={() => handleDateRangeChange('month')}
        >
          <Text style={[styles.filterText, dateRange === 'month' && styles.filterTextActive]}>Month</Text>
        </TouchableOpacity>
      </View>

      {/* Stats Cards */}
      <View style={styles.statsContainer}>
        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="assignment" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalJobsPosted || 0}</Text>
          <Text style={styles.statLabel}>{t('jobsPosted')}</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="check-circle" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalJobsCompleted || 0}</Text>
          <Text style={styles.statLabel}>{t('completed')}</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="people" size={32} color="#fff" />
          <Text style={styles.statValue}>{stats?.totalWorkersEngaged || 0}</Text>
          <Text style={styles.statLabel}>{t('workers')}</Text>
        </LinearGradient>

        <LinearGradient colors={['#1a2f4d', '#22344eff']} style={styles.statCard}>
          <View style={[styles.cardBubble, { position: 'absolute', left: -10, top: -10, backgroundColor: 'rgba(255, 255, 255, 0.15)' }]} />
          <View style={[styles.cardBubble, { position: 'absolute', right: -15, bottom: -15, width: 80, height: 80, backgroundColor: 'rgba(255, 255, 255, 0.1)' }]} />
          <MaterialIcons name="attach-money" size={32} color="#fff" />
          <Text style={styles.statValue}>₹{stats?.totalSpending || 0}</Text>
          <Text style={styles.statLabel}>{t('spending')}</Text>
        </LinearGradient>
      </View>

      {/* Today's Worker Activity - Show only for today view */}
      {dateRange === 'today' && ( // ✅ Only show for today view, hide for week/month
        <View style={styles.sectionContainer}>
          <Text style={styles.sectionTitle}>{t('todaysWorkerAcceptances')}</Text>

          {loading ? (
            <ActivityIndicator size="large" color="#1a2f4d" style={{ marginTop: 20 }} />
          ) : jobsWithAttendance.length === 0 ? (
            <Text style={styles.noDataText}>{t('noWorkersAcceptedJobToday')}</Text>
          ) : (
            visibleTodayAcceptances.map((job) => (
              <View key={job._id} style={styles.workerCard}>
                {/* Background bubbles for visual appeal */}
                <View style={[styles.cardBubble, { position: 'absolute', left: 10, top: 10, backgroundColor: 'rgba(108, 92, 231, 0.08)' }]} />
                <View style={[styles.cardBubble, { position: 'absolute', right: 10, bottom: 10, backgroundColor: 'rgba(0, 184, 148, 0.08)', width: 60, height: 60 }]} />
                
                <View style={styles.workerInfo}>
                  <Text style={styles.workerName}>{job.acceptedBy || 'Unknown'}</Text>
                  <Text style={styles.jobTitle}>{job.title}</Text>
                  <View style={styles.jobDetails}>
                    <Text style={styles.detailText}>₹{job.amount}</Text>
                    <Text style={[styles.detailText, { color: '#00b894' }]}>
                      Accepted {job.timestamp ? new Date(job.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'today'}
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
          {!loading && hasMoreTodayAcceptances && !showAllTodayAcceptances && (
            <TouchableOpacity onPress={() => setShowAllTodayAcceptances(true)} style={styles.seeMoreBtn}>
              <Text style={styles.seeMoreText}>See more</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {/* All Jobs Section */}
      {dateRange !== 'today' && (
      <View style={styles.sectionContainer}>
        <Text style={styles.sectionTitle}>{t('allPostedJobs')}</Text>

        {jobsForWeekOrMonth.length === 0 ? (
          <Text style={styles.noDataText}>{t('noJobsPostedYet')}</Text>
        ) : (
          jobsForWeekOrMonth.map((job) => (
            <TouchableOpacity key={job._id} style={styles.jobCard} onPress={() => handleJobCardClick(job)}>
              <View style={styles.jobCardHeader}>
                <Text style={styles.jobCardTitle}>{job.title}</Text>
                <Text style={styles.jobAmount}>₹{job.amount}</Text>
              </View>
              <Text style={styles.jobDescription}>{job.description}</Text>
              <View style={styles.jobCardFooter}>
                <Text style={styles.workerAccepted}>Worker: {job.acceptedBy || 'Not accepted yet'}</Text>
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
      )}

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

      {/* ✅ Custom Alert Modal */}
      <Modal
        transparent={true}
        animationType="fade"
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.alertModalOverlay}>
          <View style={styles.alertModalContainer}>
            {/* Modal Header with Icon */}
            <View style={[
              styles.alertModalHeader,
              {
                backgroundColor: modalType === "success" ? "#10B98120" : modalType === "error" ? "#EF444420" : "#3B82F620",
              }
            ]}>
              <View style={[
                styles.alertModalIconBg,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}>
                <MaterialIcons
                  name={
                    modalType === "success" ? "check-circle" :
                    modalType === "error" ? "error" :
                    "info"
                  }
                  size={32}
                  color="#fff"
                />
              </View>
            </View>

            {/* Modal Content */}
            <View style={styles.alertModalContent}>
              <Text style={styles.alertModalTitle}>{modalTitle}</Text>
              <Text style={styles.alertModalMessage}>{modalMessage}</Text>
            </View>

            {/* Modal Footer - OK Button */}
            <TouchableOpacity
              style={[
                styles.alertModalButton,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.alertModalButtonText}>OK</Text>
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
    backgroundColor: '#1a2f4d',
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
  adminStatsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    marginTop: 14,
    gap: 10,
  },
  adminStatCard: {
    width: '47%',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  adminStatNumber: {
    fontSize: 20,
    color: '#111827',
    fontWeight: '800',
  },
  adminStatLabel: {
    fontSize: 12,
    color: '#6b7280',
    marginTop: 4,
  },
  lookupRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  lookupInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#fff',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#111827',
  },
  lookupBtn: {
    backgroundColor: '#1f2937',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  lookupBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
  lookupCard: {
    marginTop: 10,
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  lookupTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#111827',
    marginBottom: 4,
  },
  lookupLine: {
    fontSize: 12,
    color: '#374151',
    marginTop: 3,
  },
  adminListCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  adminActionRow: {
    flexDirection: 'row',
    marginTop: 10,
    gap: 8,
  },
  approveBtn: {
    flex: 1,
    backgroundColor: '#10b981',
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  rejectBtn: {
    flex: 1,
    backgroundColor: '#ef4444',
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: 8,
  },
  reviewBtn: {
    flex: 1,
    backgroundColor: '#f59e0b',
    borderRadius: 8,
    alignItems: 'center',
    paddingVertical: 8,
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
  seeMoreBtn: {
    alignSelf: 'center',
    marginTop: 4,
    paddingHorizontal: 8,
    paddingVertical: 8,
  },
  seeMoreText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1a2f4d',
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

  // ✅ Alert Modal Styles
  alertModalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },

  alertModalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 320,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  contractorDetailModalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    width: "100%",
    maxWidth: 360,
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },

  alertModalHeader: {
    paddingVertical: 24,
    alignItems: "center",
  },

  alertModalIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },

  alertModalContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: "center",
  },

  alertModalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 8,
    textAlign: "center",
  },

  alertModalMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },

  alertModalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },

  alertModalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
