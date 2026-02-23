import React, { useEffect, useState, memo, useRef, ErrorInfo, useCallback } from "react";
import {
  View,
  ScrollView,
  StyleSheet,
  FlatList,
  Text,
  TouchableOpacity,
  Alert,
  Modal,
  Platform,
  Image,
} from "react-native";
import * as Notifications from 'expo-notifications'; // ✅ For foreground notifications
import { useFocusEffect } from "@react-navigation/native";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import WorkerMap from "../../../components/WorkerMap";
import FullContainer from "../../../components/FullContainer";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { socket } from "../../../utils/socket"; // ✅ Use global socket instead
import { API_BASE } from "../../../utils/config";
import { useLanguage } from "../../../context/LanguageContext";
import { 
  triggerJobAlert,
  cleanupJobAlert,
  initializeAudioSession,
} from "../../../services/jobNotificationService";

const WORKER_NAME_FALLBACK = "Test Worker";
const AUTO_DECLINE_SECONDS = 30;

// ============= ERROR BOUNDARY CLASS =============
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("🔴 ERROR BOUNDARY CAUGHT:", error);
    console.error("Component Stack:", errorInfo.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#fff' }}>
          <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#e74c3c', marginBottom: 10 }}>⚠️ Something went wrong</Text>
          <Text style={{ fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20 }}>
            {this.state.error?.message || 'Unknown error'}
          </Text>
          <TouchableOpacity
            style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#3498db', borderRadius: 8 }}
            onPress={() => this.setState({ hasError: false, error: null })}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

// ✅ Helper function to get dynamic greeting based on time of day (will be translated via context)
const getGreeting = (t: any): string => {
  const hour = new Date().getHours();
  if (hour < 12) return t('goodMorning');
  if (hour < 18) return t('goodAfternoon');
  return t('goodEvening');
};


interface Job {
  _id: string; // ✅ MongoDB ObjectId
  id?: string; // ✅ Fallback for legacy id field
  title: string;
  description: string;
  amount: string;
  contractorName: string;
  contractorPhone?: string; // ✅ Contractor phone for help
  location?: string;
  lat: number;
  lon: number;
  timestamp: string;
  date?: string; // ✅ Job date
  startTime?: string; // ✅ Start time like "09:00"
  endTime?: string; // ✅ End time like "18:00"
  numberOfDays?: number; // ✅ Job duration in days
  distanceKm?: number;
  attendanceStatus?: "Present" | "Absent" | null;
  paymentStatus?: "Paid" | null;
  workerType?: string;
  declinedBy?: string[];
  status?: string;
  acceptedBy?: string;
}

interface JobItemProps {
  item: Job;
  onAccept: (id: string) => void; // ✅ Changed from number to string
  onDecline: (id: string, auto?: boolean) => void; // ✅ Changed from number to string
  timer: number;
  t: (key: string) => string; // ✅ Translation function
}

// ---------------- JOB CARD COMPONENT ----------------
const JobItem = memo(({ item, onAccept, onDecline, timer, t }: JobItemProps) => (
  <View style={styles.jobCard}>
    <Text style={styles.title}>{item.title}</Text>

    <Text style={{ fontWeight: "600", marginTop: 5 }}>
      Contractor: {item.contractorName || "Unknown"}
    </Text>

    <Text style={{ marginTop: 3 }}>Location: {item.location || "Loading..."}</Text>

    <Text style={{ marginTop: 3 }}>{item.description}</Text>

    <Text style={{ marginTop: 3 }}>Payment: ₹{item.amount}</Text>

    <Text style={{ color: "red", marginTop: 5 }}>Auto decline in: {timer}s</Text>

    {item.attendanceStatus && (
      <Text
        style={{
          marginTop: 5,
          fontWeight: "700",
          color: item.attendanceStatus === "Present" ? "#2ecc71" : "#e74c3c",
        }}
      >
        Attendance: {item.attendanceStatus}
      </Text>
    )}

    {item.paymentStatus === "Paid" && (
      <Text style={{ marginTop: 5, fontWeight: "700", color: "#3498db" }}>Paid</Text>
    )}

    {item.attendanceStatus === null && (
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, { backgroundColor: "#2ecc71" }]}
          onPress={() => onAccept(item._id)}
        >
          <Text style={styles.buttonText}>{t('accept')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: "#e74c3c" }]}
          onPress={() => onDecline(item._id)}
        >
          <Text style={styles.buttonText}>{t('decline')}</Text>
        </TouchableOpacity>
      </View>
    )}
  </View>
));

// ---------------- WORKER HOME COMPONENT ----------------
function WorkerHome() {
  const { t } = useLanguage();
  const [error, setError] = useState<string | null>(null);
  const [currentJob, setCurrentJob] = useState<Job | null>(null);
  const [currentLocation, setCurrentLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [handledJobs, setHandledJobs] = useState<Set<string>>(new Set<string>());
  const [workerName, setWorkerName] = useState<string>(WORKER_NAME_FALLBACK);
  const [workerType, setWorkerType] = useState<string>("");
  const [token, setToken] = useState<string | null>(null);
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const previousUserPhoneRef = useRef<string | null>(null); // ✅ Track previous user to detect changes

  // Dashboard metrics state
  const [todayEarnings, setTodayEarnings] = useState<number>(0);
  const [timeOnOrder, setTimeOnOrder] = useState<number>(0);
  const [todayJobs, setTodayJobs] = useState<number>(0);
  const [historyCount, setHistoryCount] = useState<number>(0);
  const [totalEarnings, setTotalEarnings] = useState<number>(0);
  const [jobsCompleted, setJobsCompleted] = useState<number>(0);
  const [avgCompletedRating, setAvgCompletedRating] = useState<number>(0);
  const [todayIncentiveEarnings, setTodayIncentiveEarnings] = useState<number>(0);
  const [notificationCount, setNotificationCount] = useState<number>(0);
  const [workerProfilePhoto, setWorkerProfilePhoto] = useState<string | null>(null); // ✅ Worker profile photo
  const [showHelpModal, setShowHelpModal] = useState<boolean>(false); // ✅ Help modal state

  // Online/Offline toggle state
  const [isOnline, setIsOnline] = useState<boolean>(false);
  const [togglingStatus, setTogglingStatus] = useState<boolean>(false);
  const [profileIncompleteModalVisible, setProfileIncompleteModalVisible] = useState<boolean>(false);
  
  // ✅ Location permission modal state (shown post-login)
  const [showLocationModal, setShowLocationModal] = useState<boolean>(false);
  const [requestingLocation, setRequestingLocation] = useState<boolean>(false);
  
  // One-time profile setup modal
  const [showProfileSetupModal, setShowProfileSetupModal] = useState<boolean>(false);
  const [setupModalSkill, setSetupModalSkill] = useState<string>("");
  const [setupModalWage, setSetupModalWage] = useState<string>("");
  const [showSetupSkillMenu, setShowSetupSkillMenu] = useState<boolean>(false);
  const [showSetupWageMenu, setShowSetupWageMenu] = useState<boolean>(false);

  const router = useRouter();

  const [timer, setTimer] = useState<number>(AUTO_DECLINE_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentJobRef = useRef<Job | null>(null);
  const displayedJobIds = useRef<Set<string>>(new Set()); // ✅ Track displayed jobs to prevent duplicates
  const fetchAbortControllers = useRef<Map<string, AbortController>>(new Map()); // ✅ Track fetch abort controllers
  const profilePhotoWriteTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null); // ✅ Debounce AsyncStorage writes

  const ensureSocketConnectedWithToken = (authToken: string | null | undefined): boolean => {
    if (!authToken || authToken.trim() === "") {
      console.warn("⚠️ Cannot connect socket without auth token");
      return false;
    }

    const currentAuthToken = ((socket as any).auth && (socket as any).auth.token) || null;
    const hasSameToken = currentAuthToken === authToken;

    // If connected anonymously or with stale token, force reconnect with fresh token.
    if (socket.connected && !hasSameToken) {
      socket.disconnect();
    }

    (socket as any).auth = { token: authToken };
    if (!socket.connected) {
      socket.connect();
    }
    return true;
  };

  useEffect(() => {
    currentJobRef.current = currentJob;
  }, [currentJob]);

  // Always stop alert loop when modal/job is cleared, regardless of close path.
  useEffect(() => {
    if (!currentJob) {
      cleanupJobAlert().catch(() => {});
    }
  }, [currentJob]);

  // ✅ Error catching wrapper
  useEffect(() => {
    console.log("✅ WorkerHome component mounted");
    
    return () => {
      console.log("🔄 WorkerHome component unmounting");
      if (timerRef.current) clearInterval(timerRef.current);
      // ✅ Abort all pending fetches on unmount
      fetchAbortControllers.current.forEach(controller => controller.abort());
      fetchAbortControllers.current.clear();
      // ✅ Clear pending AsyncStorage writes
      if (profilePhotoWriteTimeoutRef.current) {
        clearTimeout(profilePhotoWriteTimeoutRef.current);
      }
    };
  }, []);

  // ✅ SOCKET OFFLINE MANAGEMENT: Disconnect socket when going offline
  useEffect(() => {
    if (isOnline === false) {
      // Worker went offline
      console.log('🔴 Worker offline - notifying server');
      socket.emit('workerOffline', { phone: currentUserPhone });
      // ✅ Optional: Truly disconnect to prevent server from emitting jobs
      // socket.disconnect();
    } else if (isOnline === true) {
      // Worker went online
      console.log('🟢 Worker online - ensuring authenticated socket connected');
      ensureSocketConnectedWithToken(token);
    }
  }, [isOnline, token, currentUserPhone]);

  // ✅ Check for user changes when screen comes into focus (no dependency on currentUserPhone to avoid stale closures)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const userStr = await AsyncStorage.getItem("user");
        const userPhone = userStr ? JSON.parse(userStr).phone : null;
        const userObj = userStr ? JSON.parse(userStr) : null;
        
        // ✅ RELOAD PROFILE PHOTO when screen comes into focus (after profile update)
        const profilePhotoStr = await AsyncStorage.getItem("profilePhoto");
        const effectivePhoto = profilePhotoStr || userObj?.profilePhoto || null;
        if (effectivePhoto) {
          setWorkerProfilePhoto(effectivePhoto);
          // Keep local cache in sync for faster next loads
          if (!profilePhotoStr) {
            await AsyncStorage.setItem("profilePhoto", effectivePhoto);
          }
          console.log("📸 Profile photo reloaded on focus");
        } else {
          setWorkerProfilePhoto(null);
        }
        
        // If user changed (compare with ref, not state), reset everything immediately
        if (userPhone && userPhone !== previousUserPhoneRef.current) {
          console.log(`👤 Worker Home: User changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting metrics`);
          previousUserPhoneRef.current = userPhone;
          setCurrentUserPhone(userPhone);
          setTodayEarnings(0);
          setTodayJobs(0);
          setTimeOnOrder(0);
          setHistoryCount(0);
          setTotalEarnings(0);
          setJobsCompleted(0);
          setAvgCompletedRating(0);
          setTodayIncentiveEarnings(0);
          setCurrentJob(null);
          displayedJobIds.current.clear(); // 🔄 Clear dedup set for new user
          setHandledJobs(new Set());
          
          // Load online status from user data
          if (userStr) {
            const user = JSON.parse(userStr);
            setIsOnline(user.isAvailable || false);
            console.log(`📋 Loaded online status: ${user.isAvailable}`);
          }
        } else if (!userPhone && previousUserPhoneRef.current !== null) {
          // User logged out
          console.log(`👤 Worker Home: User logged out, resetting metrics`);
          previousUserPhoneRef.current = null;
          setCurrentUserPhone(null);
          setTodayEarnings(0);
          setTodayJobs(0);
          setTimeOnOrder(0);
          setHistoryCount(0);
          setTotalEarnings(0);
          setJobsCompleted(0);
          setAvgCompletedRating(0);
          setTodayIncentiveEarnings(0);
          setCurrentJob(null);
          displayedJobIds.current.clear(); // 🔄 Clear dedup set on logout
          setHandledJobs(new Set());
          setIsOnline(false);
        } else if (userPhone && userStr) {
          // Same user, just load status
          const user = JSON.parse(userStr);
          setIsOnline(user.isAvailable || false);
        }
      })();
    }, [])
  );

  // ✅ TOKEN REFRESH HELPER - Attempt to refresh expired token
  const refreshAccessToken = async (maxRetries = 3): Promise<string | null> => {
    try {
      const refreshToken = await AsyncStorage.getItem('refreshToken');
      if (!refreshToken) {
        console.warn('⚠️ No refresh token available');
        return null;
      }

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`🔄 Attempting token refresh (attempt ${attempt}/${maxRetries})...`);
          
          // ✅ ADD TIMEOUT: Prevent hanging indefinitely on slow network
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout
          
          const response = await fetch(`${API_BASE}/refresh-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken }),
            signal: controller.signal, // ✅ Use abort signal for timeout
          });
          
          clearTimeout(timeoutId); // Clear timeout if fetch completes

          if (response.ok) {
            const data = await response.json();
            if (data.accessToken) {
              await AsyncStorage.setItem('token', data.accessToken);
              await AsyncStorage.setItem('accessToken', data.accessToken);
              console.log('✅ Token refreshed successfully');
              return data.accessToken;
            }
          } else if (response.status === 401) {
            console.error('❌ Refresh token expired - need to re-login');
            return null;
          }
        } catch (err) {
          console.warn(`⚠️ Refresh attempt ${attempt} failed:`, (err as Error).message);
          if (attempt < maxRetries) {
            const delayMs = 1000 * Math.pow(2, attempt - 1); // exponential backoff
            console.log(`⏳ Retrying in ${delayMs}ms...`);
            await new Promise(res => setTimeout(res, delayMs));
          }
        }
      }
    } catch (err) {
      console.error('Token refresh error:', err);
    }
    return null;
  };

  // ✅ REQUEST LOCATION AND UPDATE ON BACKEND
  const requestAndUpdateLocation = async (): Promise<boolean> => {
    try {
      setRequestingLocation(true);
      console.log('📍 Requesting location permission...');

      const { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        console.warn('⚠️ Location permission denied');
        return false;
      }

      console.log('✅ Location permission granted, getting position...');
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      console.log(`📍 Location obtained: lat=${latitude}, lon=${longitude}`);

      // Update location on backend
      const response = await fetch(`${API_BASE}/user/update-location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ latitude, longitude }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        console.error('❌ Failed to update location:', data.message);
        return false;
      }

      console.log('✅ Location updated on backend:', data.user);
      
      // Update local user data
      const userStr = await AsyncStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        user.latitude = data.user.latitude;
        user.longitude = data.user.longitude;
        user.city = data.user.city;
        user.state = data.user.state;
        await AsyncStorage.setItem('user', JSON.stringify(user));
        console.log('✅ User data updated in local storage');
      }

      return true;
    } catch (err) {
      console.error('❌ Error requesting location:', err);
      return false;
    } finally {
      setRequestingLocation(false);
    }
  };

  // ✅ LOAD WORKER DATA & AUTO-REGISTER ----------------
  useEffect(() => {
    (async () => {
      try {
        // Initialize audio session for job alerts
        console.log("[WorkerHome] Initializing audio session for job alerts...");
        await initializeAudioSession();
        console.log("[WorkerHome] ✅ Audio session ready");

        console.log("[WorkerHome] Loading worker data and connecting socket...");
        
        const userStr = await AsyncStorage.getItem("user");
        // ✅ Try multiple keys for token with fallback
        let storedToken = await AsyncStorage.getItem("token");
        if (!storedToken) {
          storedToken = await AsyncStorage.getItem("accessToken");
          if (storedToken) {
            console.log('ℹ️ Using accessToken key (migrating to token key)');
            await AsyncStorage.setItem("token", storedToken);
          }
        }
        const profilePhotoStr = await AsyncStorage.getItem("profilePhoto"); // ✅ Load profile photo

        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setWorkerName(user.name);
          if (user?.workerType) setWorkerType(user.workerType);
          if (user?.profilePhoto) {
            setWorkerProfilePhoto(user.profilePhoto);
            await AsyncStorage.setItem("profilePhoto", user.profilePhoto);
          }
        }

        if (profilePhotoStr) setWorkerProfilePhoto(profilePhotoStr); // ✅ Set profile photo

        // ✅ If token not found, try to refresh it
        if (!storedToken) {
          console.warn('⚠️ Token not found in AsyncStorage, attempting refresh...');
          storedToken = await refreshAccessToken();
        }

        if (storedToken) {
          setToken(storedToken);
          
          // ✅ Log token for debugging
          console.log(`🔐 Token loaded: ${storedToken.substring(0, 30)}... (length: ${storedToken.length})`);
          
          // ✅ Fetch notification count after token is set
          try {
            const notifRes = await fetch(`${API_BASE}/notifications`, {
              headers: { Authorization: `Bearer ${storedToken}` },
            });
            if (notifRes.ok) {
              const notifData = await notifRes.json();
              if (notifData.unreadCount !== undefined) {
                setNotificationCount(notifData.unreadCount);
              } else if (Array.isArray(notifData.notifications)) {
                const unreadCount = notifData.notifications.filter((n: any) => !n.isRead).length;
                setNotificationCount(unreadCount);
              }
            }
          } catch (err) {
            console.error('Error fetching notification count at init:', err);
          }
          
          // ✅ Only disconnect/reconnect if user CHANGED (not on every component mount)
          const userStr2 = await AsyncStorage.getItem("user");
          const userPhone = userStr2 ? JSON.parse(userStr2).phone : null;
          
          if (userPhone && userPhone !== previousUserPhoneRef.current) {
            console.log(`👤 User changed from ${previousUserPhoneRef.current} to ${userPhone}, reconnecting socket`);
            previousUserPhoneRef.current = userPhone;
            setCurrentUserPhone(userPhone);
            
            // Only disconnect if socket was connected to different user
            if (socket.connected) {
              socket.disconnect();
              console.log("🔌 Socket disconnected (user changed, will reconnect)");
            }
            
            // ✅ Connect/reconnect with guaranteed auth token
            if (!ensureSocketConnectedWithToken(storedToken)) {
              setError("Authentication token is missing");
            } else {
              console.log("✅ Socket reconnecting with new user token");
            }
          } else if (userPhone) {
            // Same user: still enforce authenticated connect (fixes anonymous connected socket).
            if (!ensureSocketConnectedWithToken(storedToken)) {
              setError("Authentication token is missing");
            } else {
              console.log("✅ Socket connected (same user, authenticated)");
            }
          }

          // AUTO-REGISTER: Get location and register worker automatically
          // ✅ Location permission is requested in the separate "REQUEST LOCATION" effect below
          // This avoids duplicate permission requests
          try {
            console.log("[WorkerHome] Checking location availability...");
            
            // Just get the current location if permission is already granted
            try {
              const loc = await Location.getCurrentPositionAsync({});
              const lat = loc.coords.latitude;
              const lon = loc.coords.longitude;
              console.log(`[WorkerHome] Got location: ${lat}, ${lon}`);

              // 🔔 Register for push notifications
              console.log("[WorkerHome] Registering for push notifications...");
              // Register worker with backend
              console.log("[WorkerHome] Emitting registerWorker event...");
              socket.emit("registerWorker", {
                lat,
                lon,
                workerType: "General",
              });

              console.log("✅ Worker auto-registered with location:", { lat, lon });
              setCurrentLocation({ lat, lon });
            } catch (locationErr) {
              console.warn("⚠️ Location not available (permission not granted or error):", locationErr);
              // Location permission will be requested in the separate "REQUEST LOCATION" effect
            }
          } catch (locationErr) {
            console.error("❌ Failed to auto-register worker:", locationErr);
            const errMsg = locationErr instanceof Error ? locationErr.message : String(locationErr);
            setError(`Location error: ${errMsg}`);
          }
        } else {
          console.warn("⚠️ No token found in AsyncStorage");
          setError("No authentication token found");
        }
      } catch (err) {
        console.error("❌ Failed to load user:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Failed to load user: ${errMsg}`);
      }
    })();
  }, []);

  // ✅ ONE-TIME PROFILE SETUP CHECK - Show modal only on first load if profile incomplete
  useEffect(() => {
    (async () => {
      try {
        // Check if user already completed profile setup
        const setupCompleted = await AsyncStorage.getItem("profileSetupCompleted");
        if (setupCompleted === "true") {
          console.log("✅ Profile already set up - not showing modal");
          return;
        }

        const userStr = await AsyncStorage.getItem("user");
        if (!userStr) return;

        const user = JSON.parse(userStr);

        // If mainSkill or expectedWage not set, show setup modal
        if (!user.mainSkill || !user.expectedWage) {
          console.log("🎯 Profile incomplete - showing one-time setup modal");
          setShowProfileSetupModal(true);
        } else {
          // If values are present but flag missing, mark as completed so modal doesn't reappear
          try {
            await AsyncStorage.setItem("profileSetupCompleted", "true");
            console.log("✅ Profile appears complete - marking setupCompleted to avoid repeated modal");
          } catch (e) {
            console.warn('Could not persist profileSetupCompleted flag:', e);
          }
        }
      } catch (err) {
        console.error("Failed to check profile completeness:", err);
      }
    })();
  }, []);

  // ✅ POST-LOGIN LOCATION CHECK - Show location modal if user has 0,0 coordinates
  useEffect(() => {
    (async () => {
      try {
        if (!token) return; // Wait for token to load
        
        const userStr = await AsyncStorage.getItem("user");
        if (!userStr) return;

        const user = JSON.parse(userStr);
        const locationProvidedOnLogin = await AsyncStorage.getItem("locationProvidedOnLogin");

        // Check if location is default (0,0) or missing
        const hasDefaultLocation = (user.latitude === 0 && user.longitude === 0) || 
                                   !(user.latitude && user.longitude);
        const shouldPromptForLocation = locationProvidedOnLogin !== "true" && hasDefaultLocation;

        if (shouldPromptForLocation) {
          console.log("📍 User has default location (0,0) - showing location permission modal");
          setShowLocationModal(true);
        } else {
          console.log("✅ User already has location set:", { lat: user.latitude, lon: user.longitude });
        }
      } catch (err) {
        console.error("Error checking location:", err);
      }
    })();
  }, [token]);

  // ✅ LISTEN FOR FOREGROUND PUSH NOTIFICATIONS
  useEffect(() => {
    console.log("📢 Setting up foreground notification listener...");
    
    // ✅ Handle notifications received in FOREGROUND
    const notificationListener = Notifications.addNotificationReceivedListener(async (notification) => {
      console.log("🔔 FOREGROUND NOTIFICATION RECEIVED:", notification);
      
      const data: any = notification.request.content.data;
      console.log("📦 Notification data:", data);
      
      // If it's a job offer, trigger alert
      if (data.type === 'job_offer' || data.actionRequired === 'true') {
        console.log("🎯 Job offer notification - triggering alert");
        await triggerJobAlert();
      }
    });

    // ✅ Handle notification response (when user taps notification)
    const responseListener = Notifications.addNotificationResponseReceivedListener(async (response) => {
      try {
        console.log("👆 User tapped notification:", response);
        const data: any = response.notification.request.content.data || {};

        // If notification contains jobId, fetch job details and open modal ONLY if still active.
        if (data.jobId) {
          console.log("📱 Notification contains jobId:", data.jobId);
          try {
            if (!token) {
              console.warn('No auth token available to fetch job details');
              return;
            }

            const res = await fetch(`${API_BASE}/jobs/by-id/${data.jobId}`, {
              headers: { Authorization: `Bearer ${token}` },
            });

            if (!res.ok) {
              // Job no longer available (cancelled/expired/accepted by someone else) -> do not open modal.
              console.warn('Job not available anymore for notification tap:', data.jobId, res.status);
              return;
            }

            const payload = await res.json();
            const job = payload?.job || payload;
            console.log('📥 Job details fetched from server via notification tap', job);

            // Normalize job object shape like socket handler does
            const normalizedJob = {
              ...job,
              attendanceStatus: job.attendanceStatus ?? null,
              paymentStatus: job.paymentStatus ?? null,
              timestamp: new Date().toISOString(),
            };

            if (normalizedJob) {
              // Set as current job to open modal/UI
              setCurrentJob(normalizedJob);
              // Trigger alert (sound/vibrate) for tapped job as well
              await triggerJobAlert();
            }
          } catch (fetchErr) {
            console.error('Error fetching job on notification tap:', fetchErr);
          }
        }
      } catch (err) {
        console.error('Notification response handler error:', err);
      }
    });

    return () => {
      console.log("🧹 Cleaning up notification listeners");
      notificationListener.remove();
      responseListener.remove();
    };
  }, [token]); // ✅ Include token to avoid stale closure

  // ✅ HANDLE ONE-TIME PROFILE SETUP SAVE
  useEffect(() => {
    if (!currentLocation || !workerName) {
      console.log("[WorkerHome] waiting for location/workerName");
      return;
    }

    console.log("[WorkerHome] listening for jobs");

    // ✅ PRODUCTION LOGIC: Only fetch location if:
    // 1. Job is accepted (acceptedBy !== null)
    // 2. Job NOT paid (paymentStatus !== "Paid")
    // 3. Attendance NOT marked (attendanceStatus !== "Present" && "Absent")

    const startLocationTracking = () => {
      // ✅ REMOVED: Location tracking interval disabled (as per requirement)
      // Location updates were happening every 30s via socket.emit("updateWorkerLocation")
      // Now handled entirely by backend based on user's online status
      console.log("📍 Location tracking function called (no-op)");
    };

    const stopLocationTracking = () => {
      // ✅ REMOVED: Location tracking interval disabled
      console.log("🛑 Location tracking function called (no-op)");
    };

    // Listen for new jobs
    const handleNewJob = async (data: any) => {
      try {
        console.log("📩 SOCKET: New job received", data);
        
        // ✅ FIX: Remove isOnline check - backend already verified worker is available
        // isOnline is just UI state that loads async; we should trust backend's decision
        // If job arrived via socket, backend confirmed availability

        if (!currentLocation) return;

        // ✅ DUPLICATE GUARD #1: Check if same job already displayed
        if (currentJobRef.current?._id === data._id) {
          console.log('⚠️ Same job already displayed - ignoring duplicate');
          return;
        }

        // ✅ DUPLICATE GUARD #2: Check if job was already shown/handled
        if (displayedJobIds.current.has(data._id)) {
          console.log(`⚠️ Job ${data._id} already displayed - ignoring race condition`);
          return;
        }

        const location = await getAddressFromCoords(data.lat, data.lon);

        const normalizedJob: Job = {
          ...data,
          location,
          attendanceStatus: null,
          paymentStatus: null,
          timestamp: new Date().toISOString(),
        };

        // ✅ Mark job as displayed
        displayedJobIds.current.add(data._id);

        setCurrentJob(normalizedJob);
        currentJobRef.current = normalizedJob; // ✅ Update ref to track current job
        stopLocationTracking(); // Stop tracking until job accepted
        startTimer();

        // � Trigger vibration when job arrives
        await triggerJobAlert();
      } catch (err) {
        console.error("❌ Error handling new job:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Error handling new job: ${errMsg}`);
      }
    };

    // Listen for job updates (e.g., payment done, attendance marked)
    const handleJobUpdated = (data: any) => {
      try {
        console.log("📩 SOCKET: Job updated", data);
        
        // If job is paid OR attendance marked → stop location tracking
        if (data.paymentStatus === "Paid" || data.attendanceStatus) {
          stopLocationTracking();
          console.log("✅ Location tracking stopped: Job paid or attendance marked");
        }
        // If job accepted but not paid and no attendance → start tracking
        else if (data.acceptedBy && !data.paymentStatus && !data.attendanceStatus) {
          startLocationTracking();
          console.log("📍 Location tracking started: Job accepted");
        }

        // Recalculate metrics when job updates
        console.log("📊 Job updated via socket, recalculating metrics");
        calculateMetrics();
        fetchNotificationCount();
      } catch (err) {
        console.error("❌ Error handling job update:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Error handling job update: ${errMsg}`);
      }
    };

    const handleJobAccepted = (data: any) => {
      try {
        console.log("📩 SOCKET: job accepted event", data);
        startLocationTracking(); // Start tracking when accepted
      } catch (err) {
        console.error("❌ Error handling job accepted:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Error handling job accepted: ${errMsg}`);
      }
    };

    const handleJobCancelled = (data: any) => {
      try {
        console.log("📩 SOCKET: job cancelled event received", data);
        
        // Get IDs as strings for comparison
        const cancelledJobId = String(data._id || data.id || '').trim();
        const currentJobId = String(currentJob?._id || currentJob?.id || '').trim();
        
        console.log(`📍 Comparing cancelled jobId: "${cancelledJobId}" vs current jobId: "${currentJobId}"`);
        
        // If current job is cancelled, clear it
        if (currentJobId && cancelledJobId && cancelledJobId === currentJobId) {
          console.log("❌ Current job was cancelled, clearing from view");
          // Stop any ongoing alert (sound/vibrate)
          try {
            cleanupJobAlert();
          } catch (e) { /* ignore */ }
          displayedJobIds.current.delete(cancelledJobId); // 🔄 Remove from dedup so it can be offered again
          setCurrentJob(null);
          Alert.alert("Job Cancelled", "The job you were viewing has been cancelled by the contractor.");
        } else if (currentJobId && cancelledJobId) {
          console.log(`❌ Job ${cancelledJobId} was cancelled but it's not the current job ${currentJobId}`);
        } else {
          console.log("⚠️ Cannot determine job IDs for cancellation", { cancelledJobId, currentJobId });
        }
      } catch (err) {
        console.error("❌ Error handling job cancelled:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Error handling job cancelled: ${errMsg}`);
      }
    };

    // ✅ Handle real-time notification count updates
    const handleNotificationCountUpdate = (data: any) => {
      try {
        if (data.recipientPhone === currentUserPhone) {
          console.log(`📳 Notification count updated to: ${data.unreadCount}`);
          setNotificationCount(data.unreadCount);
        }
      } catch (err) {
        console.error("Error handling notification count update:", err);
      }
    };

    // ✅ Handle real-time profile photo updates
    const handleProfilePhotoUpdate = (data: any) => {
      try {
        if (data.phone === currentUserPhone) {
          console.log(`📸 Profile photo updated:`, data.profilePhoto);
          setWorkerProfilePhoto(data.profilePhoto);
          
          // ✅ DEBOUNCE AsyncStorage writes: Use timeout to batch multiple rapid updates
          if (profilePhotoWriteTimeoutRef.current) {
            clearTimeout(profilePhotoWriteTimeoutRef.current);
          }
          
          profilePhotoWriteTimeoutRef.current = setTimeout(() => {
            // Only write if value actually changed (avoid redundant writes)
            if (workerProfilePhoto !== data.profilePhoto) {
              AsyncStorage.setItem('profilePhoto', data.profilePhoto).catch(err =>
                console.warn('Failed to persist profile photo:', err)
              );
            }
            profilePhotoWriteTimeoutRef.current = null;
          }, 300); // Debounce: wait 300ms before writing
        }
      } catch (err) {
        console.error("Error handling profile photo update:", err);
      }
    };

    socket.on("newJob", handleNewJob);
    socket.on("jobUpdated", handleJobUpdated);
    socket.on("jobAccepted", handleJobAccepted);
    socket.on("jobCancelled", handleJobCancelled);
    socket.on("notificationCountUpdated", handleNotificationCountUpdate);
    socket.on("profilePhotoUpdated", handleProfilePhotoUpdate);

    return () => {
      stopLocationTracking();
      socket.off("newJob", handleNewJob);
      socket.off("jobUpdated", handleJobUpdated);
      socket.off("jobAccepted", handleJobAccepted);
      socket.off("jobCancelled", handleJobCancelled);
      socket.off("notificationCountUpdated", handleNotificationCountUpdate);
      socket.off("profilePhotoUpdated", handleProfilePhotoUpdate);
      console.log("[WorkerHome] job listeners removed (unmounted)");
    };
  }, [currentLocation, workerName, currentUserPhone]); // ✅ REMOVED currentJob - use currentJobRef instead to prevent re-subscription

  // ---------------- GET ADDRESS ----------------
  const getAddressFromCoords = async (lat: number, lon: number) => {
    try {
      const [address] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
      return address ? `${address.name || ""}${address.city ? ", " + address.city : ""}` : "N/A";
    } catch {
      return "N/A";
    }
  };

  // ---------------- FETCH UNREAD NOTIFICATION COUNT ----------------
  const fetchNotificationCount = async () => {
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/notifications`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return;

      const data = await res.json();
      if (data.unreadCount !== undefined) {
        setNotificationCount(data.unreadCount);
      } else if (Array.isArray(data.notifications)) {
        const unreadCount = data.notifications.filter((n: any) => !n.isRead).length;
        setNotificationCount(unreadCount);
      }
    } catch (err) {
      console.error('Error fetching notification count:', err);
    }
  };

  // ---------------- CALCULATE DASHBOARD METRICS ----------------
  const calculateMetrics = useCallback(async () => {
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/worker/overview-stats`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return;

      const payload = await res.json();
      const stats = payload?.stats || {};

      setTodayEarnings(Number(stats.todayEarnings) || 0);
      setTimeOnOrder(Number(stats.timeOnOrder) || 0);
      setTodayJobs(Number(stats.todayJobs) || 0);
      setTotalEarnings(Number(stats.totalEarnings) || 0);
      setHistoryCount(Number(stats.historyCount) || 0);
      setJobsCompleted(Number(stats.jobsCompleted) || 0);
      setAvgCompletedRating(Number(stats.avgCompletedRating) || 0);
      setTodayIncentiveEarnings(Number(stats.activeBonuses) || 0);
    } catch (err) {
      console.error("Failed to calculate metrics:", err);
    }
  }, [token]);

  // Set up metrics calculation on component mount
  useEffect(() => {
    if (token) {
      calculateMetrics();
      fetchNotificationCount();
    }
  }, [token, calculateMetrics]);

  // Refresh daily metrics exactly at local midnight so Today's Overview resets without app restart.
  useEffect(() => {
    if (!token) return;

    let midnightTimeout: ReturnType<typeof setTimeout> | null = null;
    let midnightInterval: ReturnType<typeof setInterval> | null = null;

    const runRefresh = () => {
      calculateMetrics();
      fetchNotificationCount();
    };

    const scheduleMidnightRefresh = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0);
      const msUntilMidnight = Math.max(1000, nextMidnight.getTime() - now.getTime());

      midnightTimeout = setTimeout(() => {
        runRefresh();
        midnightInterval = setInterval(runRefresh, 24 * 60 * 60 * 1000);
      }, msUntilMidnight);
    };

    scheduleMidnightRefresh();

    return () => {
      if (midnightTimeout) clearTimeout(midnightTimeout);
      if (midnightInterval) clearInterval(midnightInterval);
    };
  }, [token, calculateMetrics]);

  // ✅ SAVE ONE-TIME PROFILE SETUP (Skill & Wage)
  const handleSaveProfileSetup = async () => {
    if (!setupModalSkill || !setupModalWage) {
      Alert.alert("Error", "Please select both skill and wage range");
      return;
    }

    try {
      setTogglingStatus(true);
      
      const res = await fetch(`${API_BASE}/users/update-profile`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          mainSkill: setupModalSkill,
          expectedWage: setupModalWage,
        }),
      });

      if (!res.ok) {
        throw new Error("Failed to save profile");
      }

      const data = await res.json();
      
      // Update AsyncStorage
      const userStr = await AsyncStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        user.mainSkill = setupModalSkill;
        user.expectedWage = setupModalWage;
        await AsyncStorage.setItem("user", JSON.stringify(user));
      }

      // ✅ Mark profile setup as completed - so it won't show again
      await AsyncStorage.setItem("profileSetupCompleted", "true");

      console.log("✅ Profile setup saved successfully");
      setShowProfileSetupModal(false);
      Alert.alert("Success", "Profile setup complete! You're ready to go online.");
    } catch (err) {
      console.error("Profile setup error:", err);
      Alert.alert("Error", "Failed to save profile setup");
    } finally {
      setTogglingStatus(false);
    }
  };

  // ✅ Toggle Online/Offline Status
  const toggleOnlineStatus = async () => {
    if (togglingStatus) return; // Prevent multiple clicks
    
    // Check if user is trying to go online
    if (!isOnline) {
      // STEP 1: QUICK LOCAL CHECK (instant feedback) - Just verify cache hasn't become stale
      const userStr = await AsyncStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        
        // If profile somehow got cleared locally, show error
        if (!user.mainSkill || !user.expectedWage) {
          console.log(`⚠️ Profile setup missing. This shouldn't happen. Showing setup modal.`);
          setShowProfileSetupModal(true);
          return; // Don't proceed
        }
      }

      // STEP 2: BACKEND VERIFICATION (source of truth)
      console.log("🔍 Starting backend profile verification...");
      setTogglingStatus(true);
      
      try {
        const verifyRes = await fetch(`${API_BASE}/workers/verify-profile`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
        });

        const verifyData = await verifyRes.json();
        console.log("📊 Backend verification response:", verifyData);

        // If backend says profile is incomplete, show setup modal
        if (!verifyData.isProfileComplete) {
          console.log("❌ BACKEND CHECK FAILED: Profile incomplete on backend");
          setTogglingStatus(false);
          setShowProfileSetupModal(true);
          return; // Don't allow going online
        }

        console.log("✅ BACKEND CHECK PASSED: Profile is complete");
        // Continue with going online
      } catch (err) {
        console.error("❌ Backend verification error:", err);
        setTogglingStatus(false);
        Alert.alert(
          "Connection Error",
          "Could not verify your profile. Please check your internet connection and try again."
        );
        return;
      }
    }

    const newStatus = !isOnline;

    try {
      // ✅ Get fresh location when going online
      let locationForToggle = null;
      if (newStatus) {
        try {
          console.log('📍 Getting fresh location for online status...');
          const loc = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          locationForToggle = {
            latitude: loc.coords.latitude,
            longitude: loc.coords.longitude,
          };
          console.log(`✅ Got location for toggle: lat=${locationForToggle.latitude}, lon=${locationForToggle.longitude}`);
        } catch (locErr) {
          console.warn('⚠️ Could not get location for toggle:', locErr);
          // Continue without location - backend will accept it
        }
      }

      // STEP 3: UPDATE AVAILABILITY ON BACKEND
      console.log(`🟢 Updating availability to: ${newStatus}`);
      const body: any = { isAvailable: newStatus };
      if (locationForToggle) {
        body.latitude = locationForToggle.latitude;
        body.longitude = locationForToggle.longitude;
      }

      const res = await fetch(`${API_BASE}/workers/availability`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });

      let data: any = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }

      if (!res.ok) {
        const backendMessage = data?.message || "Failed to update availability";
        throw new Error(backendMessage);
      }
      console.log(`✅ Availability updated to: ${newStatus}`);
      
      // STEP 4: UPDATE LOCAL STATE & STORAGE
      setIsOnline(newStatus);

      // ✅ Update location in local storage if returned from backend
      if (newStatus && data.user && data.user.latitude && data.user.longitude) {
        console.log(`📍 Updating local location from server: lat=${data.user.latitude}, lon=${data.user.longitude}`);
        setCurrentLocation({ lat: data.user.latitude, lon: data.user.longitude });
        
        // Update AsyncStorage with new location
        const userStr = await AsyncStorage.getItem("user");
        if (userStr) {
          const user = JSON.parse(userStr);
          user.isAvailable = newStatus;
          user.latitude = data.user.latitude;
          user.longitude = data.user.longitude;
          user.city = data.user.city;
          await AsyncStorage.setItem("user", JSON.stringify(user));
        }
      } else {
        // Just update availability
        const userStr = await AsyncStorage.getItem("user");
        if (userStr) {
          const user = JSON.parse(userStr);
          user.isAvailable = newStatus;
          await AsyncStorage.setItem("user", JSON.stringify(user));
        }
      }

      // Re-register worker location when going online so backend matching map is always fresh.
      if (newStatus && currentLocation) {
        socket.emit("registerWorker", {
          lat: currentLocation.lat,
          lon: currentLocation.lon,
          workerType: workerType || "General",
        });
        socket.emit("updateWorkerLocation", {
          lat: currentLocation.lat,
          lon: currentLocation.lon,
        });
        console.log("📡 Re-registered worker location after going online");
      }

      Alert.alert(
        newStatus ? "🟢 Online" : "🔴 Offline",
        newStatus ? "You're now online and visible to contractors!" : "You're now offline."
      );
    } catch (err) {
      console.error("❌ Failed to toggle status:", err);
      const errMsg = err instanceof Error ? err.message : "Failed to update availability status";
      Alert.alert("Error", errMsg);
    } finally {
      setTogglingStatus(false);
    }
  };

  // ---------------- TIMER ----------------
  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setTimer(AUTO_DECLINE_SECONDS);

    timerRef.current = setInterval(() => {
      setTimer(prev => {
        if (prev <= 1) {
          if (timerRef.current) clearInterval(timerRef.current);
          if (currentJobRef.current) {
            const jobId = currentJobRef.current._id || currentJobRef.current.id || "";
            if (jobId) handleDecline(jobId, true);
          }
        }
        return Math.max(prev - 1, 0); // ✅ Prevent negative timer values
      });
    }, 1000);
  };

  // ---------------- FETCH NEARBY JOBS ----------------
  const fetchNearbyJobs = async (lat: number, lon: number) => {
    console.log("📍 Fetch Nearby Jobs token:", token);

    try {
      // ✅ CREATE ABORT CONTROLLER for this fetch
      const controller = new AbortController();
      fetchAbortControllers.current.set('fetchNearbyJobs', controller);

      const res = await fetch(`${API_BASE}/jobs/nearby`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ lat, lon, workerName, workerType }),
        signal: controller.signal, // ✅ Add abort signal for cancel on unmount
      });

      if (!res.ok) return;

      const data: Job[] = await res.json();
      
      // ✅ DUPLICATE PREVENTION: Only show jobs not already displayed or handled
      const newJobs = data.filter(j => !handledJobs.has(j._id) && !displayedJobIds.current.has(j._id));
      if (newJobs.length === 0) return;

      const first = newJobs[0];
      const location = await getAddressFromCoords(first.lat, first.lon);

      // ✅ Mark as displayed before showing
      displayedJobIds.current.add(first._id);

      setCurrentJob({
        ...first,
        location,
        attendanceStatus: null,
        paymentStatus: null,
      });

      startTimer();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.log('📍 Fetch nearby jobs aborted (component unmounted)');
        return;
      }
      console.error("Failed to fetch nearby jobs:", err);
    } finally {
      fetchAbortControllers.current.delete('fetchNearbyJobs');
    }
  };

  const fetchJobById = async (jobId: string): Promise<Job | null> => {
    try {
      const res = await fetch(`${API_BASE}/jobs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const jobs: Job[] = await res.json();
      return jobs.find(j => j._id === jobId) || null;
    } catch {
      return null;
    }
  };

  // ---------------- REQUEST LOCATION ----------------
  useEffect(() => {
    let mounted = true;

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        console.warn("⚠️ Location permission not granted");
        return; // ✅ Silently return - don't show repeated alerts
      }
      const loc = await Location.getCurrentPositionAsync({});
      if (!mounted) return;

      const coords = { lat: loc.coords.latitude, lon: loc.coords.longitude };
      setCurrentLocation(coords);

      // Keep backend worker map aligned with actual coordinates after permission grant.
      socket.emit("registerWorker", {
        lat: coords.lat,
        lon: coords.lon,
        workerType: workerType || "General",
      });
      socket.emit("updateWorkerLocation", {
        lat: coords.lat,
        lon: coords.lon,
      });
      console.log("📡 Registered worker from permission-based location flow");

      // ✅ Only fetch nearby jobs if token available
      if (token) {
        await fetchNearbyJobs(coords.lat, coords.lon);
      }
    })();

    return () => {
      mounted = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [workerName, token, workerType]);

  // ---------------- LISTEN TO JOB UPDATES ----------------
  useEffect(() => {
    const listener = async () => {
      const job = currentJobRef.current;
      if (!job) return;

      const updatedJob = await fetchJobById(job._id);
      if (!updatedJob) return;

      if (updatedJob.paymentStatus === "Paid" && job.paymentStatus !== "Paid") {
        Alert.alert("Payment Received", `You have received payment for ${updatedJob.title}`);
      }

      if (updatedJob.attendanceStatus && updatedJob.attendanceStatus !== job.attendanceStatus) {
        Alert.alert("Attendance Updated", `Attendance for ${updatedJob.title} is ${updatedJob.attendanceStatus}`);
      }

      setCurrentJob(updatedJob);
    };

    return () => {};
  }, []);

  // ================== CLEAR JOB HELPER ==================
  const clearCurrentJobAndDedup = (jobId: string | null = null) => {
    const idToRemove = jobId || currentJobRef.current?._id;
    if (idToRemove) {
      displayedJobIds.current.delete(idToRemove);
      console.log(`🗑️ Cleared job ${idToRemove} from deduplication set`);
    }
    setCurrentJob(null);
  };

  // ---------------- HANDLE ACCEPT ----------------
  const handleAccept = async (jobId: string) => {
    await cleanupJobAlert();
    if (timerRef.current) clearInterval(timerRef.current);

    try {
      console.log(`🎯 Attempting to accept job: ${jobId}`);
      
      const res = await fetch(`${API_BASE}/jobs/accept/${jobId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ workerName, workerType }),
      });

      const data = await res.json();
      console.log("Response:", data);

      if (!res.ok) {
        console.log("❌ Accept failed:", data.message);
        throw new Error(data.message || "Failed to accept job");
      }

      console.log("✅ Job accepted successfully");
      
      setHandledJobs(p => new Set(p).add(jobId));
      clearCurrentJobAndDedup(jobId);
      Alert.alert("✅ Job Accepted", "You accepted this job!");

      socket.emit("jobAccepted", { jobId, workerName, workerType });
    } catch (err) {
      console.error("❌ Accept error:", err);
      Alert.alert("Error", err instanceof Error ? err.message : "Could not accept job.");
    }
  };

  // ---------------- HANDLE DECLINE ----------------
  const handleDecline = async (jobId: string, auto = false) => {
    await cleanupJobAlert();
    if (timerRef.current) clearInterval(timerRef.current);

    try {
      console.log(`📋 Attempting to decline job: ${jobId}`);
      
      const res = await fetch(`${API_BASE}/jobs/decline/${jobId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ workerName, workerType }),
      });

      const data = await res.json();
      console.log("Response:", data);

      if (!res.ok) {
        console.log("❌ Decline failed:", data.message);
        throw new Error(data.message || "Failed to decline job");
      }

      console.log("✅ Job declined successfully");
      
      setHandledJobs(prev => new Set(prev).add(jobId));
      clearCurrentJobAndDedup(jobId);

      if (currentLocation) await fetchNearbyJobs(currentLocation.lat, currentLocation.lon);

      if (!auto) Alert.alert("📋 Job Declined", "You declined this job!");
    } catch (err) {
      console.error("❌ Decline error:", err);
      Alert.alert("Error", err instanceof Error ? err.message : "Could not decline job.");
    }
  };

  return (
    <View style={styles.container}>
      {error && (
        <View style={{ backgroundColor: '#ffebee', padding: 20, margin: 10, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: '#e74c3c' }}>
          <Text style={{ color: '#c62828', fontWeight: 'bold', marginBottom: 8 }}>⚠️ Error Loading Worker Home</Text>
          <Text style={{ color: '#c62828', fontSize: 12 }}>{error}</Text>
          <TouchableOpacity style={{ marginTop: 10, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#e74c3c', borderRadius: 6 }} onPress={() => {
            setError(null);
          }}>
            <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
      
      {error ? null : (
        <>
          {/* Header with Profile Icon & Notification Bell & Online Toggle */}
          <View style={styles.headerContainer}>
        {/* ✅ Circular Profile Photo on Left */}
        <TouchableOpacity 
          onPress={() => router.push('/home/worker/profile' as any)}
          style={styles.headerProfileContainer}
        >
          {workerProfilePhoto ? (
            <Image source={{ uri: workerProfilePhoto }} style={styles.headerProfilePhoto} />
          ) : (
            <View style={styles.headerProfilePlaceholder}>
              <MaterialIcons name="person" size={24} color="#fff" />
            </View>
          )}
        </TouchableOpacity>
        <View style={styles.headerRightContainer}>
          {/* Online/Offline Toggle */}
          <TouchableOpacity 
            style={[styles.statusToggle, { backgroundColor: isOnline ? "#2ecc71" : "#95a5a6", opacity: togglingStatus ? 0.6 : 1 }]}
            onPress={toggleOnlineStatus}
            disabled={togglingStatus}
          >
            <MaterialIcons 
              name={isOnline ? "done-all" : "offline-pin"} 
              size={16} 
              color="#fff" 
              style={{ marginRight: 4 }}
            />
            <Text style={styles.statusToggleText}>
              {isOnline ? t('online') : t('offline')}
            </Text>
          </TouchableOpacity>

          {/* Notification Bell */}
          <TouchableOpacity 
            style={styles.bellContainer}
            onPress={() => router.push("/NotificationHistory" as any)}
          >
            <MaterialIcons name="notifications-none" size={28} color="#000" />
            {notificationCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{notificationCount > 9 ? '9+' : notificationCount}</Text>
              </View>
            )}
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.topSection}>
        <WorkerMap style={styles.map} />
      </View>

      {/* ✅ FIXED: Always render Modal component (not conditionally) to ensure it can appear when job arrives */}
      <Modal
        visible={!!currentJob}
        transparent
        animationType="slide"
        onRequestClose={async () => {
          await cleanupJobAlert();
          clearCurrentJobAndDedup();
        }}
      >
        {currentJob && (
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              {/* Top Row: Close Button and Need Help Phone Button */}
              <View style={styles.topButtonsRow}>
                <TouchableOpacity 
                  style={styles.closeButton}
                  onPress={async () => {
                    await cleanupJobAlert();
                    clearCurrentJobAndDedup();
                  }}
                >
                  <MaterialIcons name="close" size={28} color="#000" />
                </TouchableOpacity>

                {/* Need Help Button */}
                {currentJob.contractorPhone && (
                  <TouchableOpacity 
                    style={styles.helpButton}
                    onPress={() => {
                      setShowHelpModal(true);
                    }}
                  >
                    <MaterialIcons name="phone" size={28} color="#2ecc71" />
                  </TouchableOpacity>
                )}
              </View>

              {/* Header Badge */}
              <View style={styles.badgeContainer}>
                <MaterialIcons name="new-releases" size={20} color="#fff" />
                <Text style={styles.badgeTextModal}>  New Job Available!</Text>
              </View>

              {/* Scrollable Content */}
              <ScrollView 
                style={styles.scrollContent}
                showsVerticalScrollIndicator={false}
              >
                {/* Job Title */}
                <Text style={styles.jobTitle}>{currentJob.title}</Text>

                {/* Amount Box */}
                <View style={styles.amountBox}>
                  <Text style={styles.amountLabel}>💰 Payment</Text>
                  <Text style={styles.amountValue}>₹{currentJob.amount}</Text>
                </View>
                {/* Info Items Grid - 2 columns */}
                <View style={styles.infoGrid}>
                  {/* Contractor */}
                  <View style={styles.infoItemGrid}>
                    <MaterialIcons name="person" size={20} color="#3498db" />
                    <View style={styles.infoText}>
                      <Text style={styles.infoLabel}>Contractor</Text>
                      <Text style={styles.infoValue}>{currentJob.contractorName || "Unknown"}</Text>
                    </View>
                  </View>

                  {/* Main Skill */}
                  <View style={styles.infoItemGrid}>
                    <MaterialIcons name="build" size={20} color="#f39c12" />
                    <View style={styles.infoText}>
                      <Text style={styles.infoLabel}>Skill</Text>
                      <Text style={styles.infoValue}>{currentJob.description || "N/A"}</Text>
                    </View>
                  </View>

                  {/* Worker Type (Secondary Skill) */}
                  {currentJob.workerType && (
                    <View style={styles.infoItemGrid}>
                      <MaterialIcons name="work" size={20} color="#9b59b6" />
                      <View style={styles.infoText}>
                        <Text style={styles.infoLabel}>Secondary</Text>
                        <Text style={styles.infoValue}>{currentJob.workerType}</Text>
                      </View>
                    </View>
                  )}

                  {/* Job Date */}
                  {currentJob.date && (
                    <View style={styles.infoItemGrid}>
                      <MaterialIcons name="event" size={20} color="#e67e22" />
                      <View style={styles.infoText}>
                        <Text style={styles.infoLabel}>Date</Text>
                        <Text style={styles.infoValue}>{new Date(currentJob.date).toLocaleDateString()}</Text>
                      </View>
                    </View>
                  )}

                  {/* Start Time & End Time */}
                  {(currentJob.startTime || currentJob.endTime) && (
                    <View style={styles.infoItemGrid}>
                      <MaterialIcons name="schedule" size={20} color="#3498db" />
                      <View style={styles.infoText}>
                        <Text style={styles.infoLabel}>Hours</Text>
                        <Text style={styles.infoValue}>
                          {currentJob.startTime || "N/A"} - {currentJob.endTime || "N/A"}
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* Number of Days */}
                  {currentJob.numberOfDays && (
                    <View style={styles.infoItemGrid}>
                      <MaterialIcons name="timer" size={20} color="#e74c3c" />
                      <View style={styles.infoText}>
                        <Text style={styles.infoLabel}>Duration</Text>
                        <Text style={styles.infoValue}>{currentJob.numberOfDays} {currentJob.numberOfDays === 1 ? 'day' : 'days'}</Text>
                      </View>
                    </View>
                  )}
                </View>

                {/* Location - Full Width */}
                <View style={styles.infoItem}>
                  <MaterialIcons name="location-on" size={20} color="#e74c3c" />
                  <View style={styles.infoText}>
                    <Text style={styles.infoLabel}>Location</Text>
                    <Text style={styles.infoValue}>{currentJob.location || "Loading..."}</Text>
                  </View>
                </View>

                {/* Timer */}
                <View style={styles.timerBox}>
                  <MaterialIcons name="schedule" size={20} color="#fff" />
                  <Text style={styles.timerText}>Auto-decline in {timer}s</Text>
                </View>
              </ScrollView>

              {/* Action Buttons */}
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  style={styles.declineButton}
                  onPress={() => {
                    handleDecline(currentJob._id);
                    clearCurrentJobAndDedup(currentJob._id);
                  }}
                >
                  <MaterialIcons name="close" size={20} color="#fff" />
                  <Text style={styles.buttonText}>Decline</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => {
                    handleAccept(currentJob._id);
                    clearCurrentJobAndDedup(currentJob._id);
                  }}
                >
                  <MaterialIcons name="check" size={20} color="#fff" />
                  <Text style={styles.buttonText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </Modal>

      {/* ONE-TIME PROFILE SETUP MODAL - Shows only once on first load */}
      <Modal visible={showProfileSetupModal} transparent animationType="fade">
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
                <MaterialIcons name="info" size={48} color="#3498db" />
              </View>

              {/* Title */}
              <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a2f4d', textAlign: 'center', marginBottom: 8 }}>
                Complete Your Profile
              </Text>

              {/* Subtitle */}
              <Text style={{ fontSize: 13, color: '#7f8c8d', textAlign: 'center', marginBottom: 20 }}>
                Let contractors know your skills and expected wage
              </Text>

              {/* Main Skill Dropdown */}
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a2f4d', marginBottom: 8 }}>Main Skill *</Text>
                <TouchableOpacity 
                  style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderRadius: 10, 
                    paddingHorizontal: 12, 
                    paddingVertical: 12,
                    backgroundColor: '#f9f9f9',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onPress={() => setShowSetupSkillMenu(!showSetupSkillMenu)}
                >
                  <Text style={{ color: setupModalSkill ? '#1a2f4d' : '#999', fontSize: 14 }}>
                    {setupModalSkill || 'Select Skill'}
                  </Text>
                  <MaterialIcons name={showSetupSkillMenu ? 'expand-less' : 'expand-more'} size={20} color="#1a2f4d" />
                </TouchableOpacity>

                {showSetupSkillMenu && (
                  <View style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderTopWidth: 0,
                    borderBottomLeftRadius: 10,
                    borderBottomRightRadius: 10,
                    backgroundColor: '#f0f0f0',
                    marginTop: -1,
                    maxHeight: 200,
                  }}>
                    {['Labour', 'Mason', 'Engineer', 'ITI/Technician'].map((skill) => (
                      <TouchableOpacity 
                        key={skill}
                        style={{ paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' }}
                        onPress={() => { 
                          setSetupModalSkill(skill); 
                          setShowSetupSkillMenu(false); 
                        }}
                      >
                        <Text style={{ color: '#1a2f4d', fontSize: 14 }}>{skill}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Expected Wage Dropdown */}
              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: '#1a2f4d', marginBottom: 8 }}>Expected Wage *</Text>
                <TouchableOpacity 
                  style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderRadius: 10, 
                    paddingHorizontal: 12, 
                    paddingVertical: 12,
                    backgroundColor: '#f9f9f9',
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                  onPress={() => setShowSetupWageMenu(!showSetupWageMenu)}
                >
                  <Text style={{ color: setupModalWage ? '#1a2f4d' : '#999', fontSize: 14 }}>
                    {setupModalWage === '400-550' ? '₹400 to ₹550' :
                     setupModalWage === '550-700' ? '₹550 to ₹700' :
                     setupModalWage === '700-max' ? '₹700 to Max' :
                     'Select Range'}
                  </Text>
                  <MaterialIcons name={showSetupWageMenu ? 'expand-less' : 'expand-more'} size={20} color="#1a2f4d" />
                </TouchableOpacity>

                {showSetupWageMenu && (
                  <View style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderTopWidth: 0,
                    borderBottomLeftRadius: 10,
                    borderBottomRightRadius: 10,
                    backgroundColor: '#f0f0f0',
                    marginTop: -1,
                    maxHeight: 200,
                  }}>
                    {[
                      { label: '₹400 to ₹550', value: '400-550' },
                      { label: '₹550 to ₹700', value: '550-700' },
                      { label: '₹700 to Max', value: '700-max' }
                    ].map((range) => (
                      <TouchableOpacity 
                        key={range.value}
                        style={{ paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' }}
                        onPress={() => { 
                          setSetupModalWage(range.value); 
                          setShowSetupWageMenu(false); 
                        }}
                      >
                        <Text style={{ color: '#1a2f4d', fontSize: 14 }}>{range.label}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Save Button */}
              <TouchableOpacity 
                style={{ 
                  backgroundColor: '#3498db', 
                  borderRadius: 10, 
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 10,
                }}
                onPress={handleSaveProfileSetup}
                disabled={togglingStatus}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  {togglingStatus ? 'Saving...' : 'Continue'}
                </Text>
              </TouchableOpacity>

              {/* Info Text */}
              <Text style={{ fontSize: 12, color: '#95a5a6', textAlign: 'center' }}>
                You can update these anytime in your Profile settings
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Profile Incomplete Modal */}
      <Modal visible={profileIncompleteModalVisible} transparent animationType="fade">
        <TouchableOpacity 
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
          onPress={() => setProfileIncompleteModalVisible(false)}
          activeOpacity={1}
        >
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <TouchableOpacity 
              style={{ 
                backgroundColor: '#fff', 
                borderRadius: 16, 
                padding: 24, 
                width: '100%',
                maxWidth: 320,
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
                <MaterialIcons name="warning" size={48} color="#e74c3c" />
              </View>

              {/* Title */}
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a2f4d', textAlign: 'center', marginBottom: 12 }}>
                Profile Incomplete
              </Text>

              {/* Red Error Message */}
              <Text style={{ fontSize: 14, color: '#e74c3c', fontWeight: '600', textAlign: 'center', marginBottom: 20, lineHeight: 20 }}>
                You need to set your Main Skill and Expected Wage in the Profile section before going online!
              </Text>

              {/* Buttons */}
              <View style={{ flexDirection: 'row', gap: 12 }}>
                <TouchableOpacity 
                  style={{ 
                    flex: 1,
                    borderWidth: 1.5,
                    borderColor: '#e74c3c',
                    borderRadius: 10, 
                    paddingVertical: 12,
                    alignItems: 'center',
                  }}
                  onPress={() => setProfileIncompleteModalVisible(false)}
                >
                  <Text style={{ color: '#e74c3c', fontSize: 14, fontWeight: '700' }}>Later</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={{ 
                    flex: 1,
                    backgroundColor: '#e74c3c', 
                    borderRadius: 10, 
                    paddingVertical: 12,
                    alignItems: 'center',
                  }}
                  onPress={() => {
                    setProfileIncompleteModalVisible(false);
                    router.push("/Settings" as any);
                  }}
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>Go to Profile</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ✅ Help Modal - "Team will call you in 5 minutes" */}
      <Modal visible={showHelpModal} animationType="fade" transparent={true}>
        <View style={styles.helpModalContainer}>
          <View style={styles.helpModalContent}>
            <MaterialIcons name="phone" size={48} color="#2ecc71" style={{ marginBottom: 16 }} />
            <Text style={styles.helpModalTitle}>Help Request Sent!</Text>
            <Text style={styles.helpModalMessage}>
              The team will call you in 5 minutes
            </Text>
            <TouchableOpacity 
              style={styles.helpModalButton}
              onPress={() => setShowHelpModal(false)}
            >
              <Text style={styles.helpModalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ✅ POST-LOGIN LOCATION PERMISSION MODAL */}
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
                We need your location to match you with nearby jobs. This helps contractors find workers in their area.
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
                  Skip
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

      <FullContainer 
        todayEarnings={todayEarnings}
        timeOnOrder={timeOnOrder}
        todayJobs={todayJobs}
        historyCount={historyCount}
        totalEarnings={totalEarnings}
        offersClaimed={jobsCompleted}
        averageRating={avgCompletedRating}
        activeBonuses={todayIncentiveEarnings}
      />
        </>
      )}
    </View>
  );
}

// ============= EXPORT WITH ERROR BOUNDARY =============
export default function WorkerHomeWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <WorkerHome />
    </ErrorBoundary>
  );
}

// ---------------- STYLES ----------------
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f5f5f5" },
  headerContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 15,
    paddingTop: 25, // ✅ Added top padding to move content down
    backgroundColor: "#fff",
    borderBottomWidth: 0,
  },
  // ✅ Profile Photo Styles
  headerProfileContainer: {
    width: 50,
    height: 50,
    borderRadius: 25,
    overflow: "hidden",
  },
  headerProfilePhoto: {
    width: 50,
    height: 50,
    borderRadius: 25,
  },
  headerProfilePlaceholder: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: "rgba(0, 0, 0, 0.2)",
    justifyContent: "center",
    alignItems: "center",
  },
  dashboardText: {
    fontSize: 12,
    color: "#999",
    fontWeight: "400",
  },
  greetingText: {
    fontSize: 18,
    fontWeight: "700",
    color: "#000",
    marginTop: 4,
  },
  headerRightContainer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  statusToggle: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    justifyContent: "center",
  },
  statusToggleText: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 11,
  },
  bellContainer: {
    position: "relative",
    padding: 8,
  },
  badge: {
    position: "absolute",
    top: 0,
    right: 0,
    backgroundColor: "#FF6B6B",
    borderRadius: 12,
    width: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  topSection: { zIndex: 0, marginBottom: -1, overflow: "hidden", backgroundColor: "#f5f5f5" },
  map: { width: "100%", height: 350 },
  horizontalScrollContainer: { marginTop: -2, paddingLeft: 12, paddingBottom: 8 },
  jobCard: {
    backgroundColor: "#fff",
    padding: 15,
    borderRadius: 10,
    marginBottom: 10,
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 6,
    elevation: 3,
  },
  title: { fontSize: 16, fontWeight: "700", marginBottom: 5 },
  buttonRow: { flexDirection: "row", marginTop: 10 },
  button: { flex: 1, padding: 10, borderRadius: 8, alignItems: "center", marginHorizontal: 5 },
  buttonText: { color: "#fff", fontWeight: "700" },
  // ============ MODAL STYLES ============
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    justifyContent: "flex-end",
    paddingBottom: Platform.OS === "ios" ? 40 : 20,
  },
  modalContent: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 20,
    maxHeight: "85%",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: -5 },
    shadowRadius: 15,
    elevation: 15,
  },
  topButtonsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  closeButton: {
    padding: 5,
  },
  helpButton: {
    padding: 5,
    backgroundColor: "rgba(46, 204, 113, 0.1)",
    borderRadius: 24,
    width: 44,
    height: 44,
    justifyContent: "center",
    alignItems: "center",
  },
  badgeContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FF6B6B",
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderRadius: 20,
    marginBottom: 15,
    alignSelf: "flex-start",
  },
  badgeTextModal: {
    color: "#fff",
    fontWeight: "700",
    fontSize: 14,
  },
  scrollContent: {
    maxHeight: 350,
    marginBottom: 15,
  },
  jobTitle: {
    fontSize: 24,
    fontWeight: "800",
    color: "#000",
    marginBottom: 15,
    lineHeight: 32,
  },
  amountBox: {
    backgroundColor: "#E8F5E9",
    paddingHorizontal: 15,
    paddingVertical: 15,
    borderRadius: 12,
    marginBottom: 15,
    borderLeftWidth: 4,
    borderLeftColor: "#27AE60",
  },
  amountLabel: {
    fontSize: 12,
    color: "#666",
    fontWeight: "600",
    marginBottom: 5,
  },
  amountValue: {
    fontSize: 32,
    fontWeight: "800",
    color: "#27AE60",
  },
  infoItem: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    gap: 12,
  },
  infoText: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 11,
    color: "#999",
    fontWeight: "600",
    textTransform: "uppercase",
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 15,
    color: "#333",
    fontWeight: "600",
    lineHeight: 20,
  },
  // ✅ 2-Column Grid Styles
  infoGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginBottom: 15,
    gap: 10,
  },
  infoItemGrid: {
    width: "48%", // 2 items per row with gap
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: "#f8f8f8",
    borderRadius: 10,
    gap: 8,
  },
  timerBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FFF3E0",
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 12,
    marginTop: 12,
    gap: 10,
    borderLeftWidth: 4,
    borderLeftColor: "#FF9800",
  },
  timerText: {
    fontSize: 14,
    color: "#E65100",
    fontWeight: "700",
  },
  declineButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#E74C3C",
    paddingVertical: 14,
    borderRadius: 12,
    marginRight: 10,
    gap: 8,
    shadowColor: "#E74C3C",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
  },
  acceptButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#27AE60",
    paddingVertical: 14,
    borderRadius: 12,
    gap: 8,
    shadowColor: "#27AE60",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
  },
  // ✅ Help Modal Styles
  helpModalContainer: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
  },
  helpModalContent: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingHorizontal: 24,
    paddingVertical: 32,
    alignItems: "center",
    width: "85%",
    maxWidth: 300,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
  },
  helpModalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#2ecc71",
    marginBottom: 12,
  },
  helpModalMessage: {
    fontSize: 16,
    color: "#666",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 22,
  },
  helpModalButton: {
    backgroundColor: "#2ecc71",
    paddingHorizontal: 40,
    paddingVertical: 12,
    borderRadius: 10,
    minWidth: 120,
    alignItems: "center",
  },
  helpModalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});


//***************************************************************************** */
