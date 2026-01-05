import React, { useEffect, useState, memo, useRef, ErrorInfo } from "react";
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
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import WorkerMap from "../../../components/WorkerMap";
import FullContainer from "../../../components/FullContainer";
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { socket } from "../../../utils/socket"; // ✅ Use global socket instead
import { API_BASE } from "../../../utils/config";
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


interface Job {
  _id: string; // ✅ MongoDB ObjectId
  id?: string; // ✅ Fallback for legacy id field
  title: string;
  description: string;
  amount: string;
  contractorName: string;
  location?: string;
  lat: number;
  lon: number;
  timestamp: string;
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
}

// ---------------- JOB CARD COMPONENT ----------------
const JobItem = memo(({ item, onAccept, onDecline, timer }: JobItemProps) => (
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
          <Text style={styles.buttonText}>Accept</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.button, { backgroundColor: "#e74c3c" }]}
          onPress={() => onDecline(item._id)}
        >
          <Text style={styles.buttonText}>Decline</Text>
        </TouchableOpacity>
      </View>
    )}
  </View>
));

// ---------------- WORKER HOME COMPONENT ----------------
function WorkerHome() {
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
  const [notificationCount, setNotificationCount] = useState<number>(0);

  // Online/Offline toggle state
  const [isOnline, setIsOnline] = useState<boolean>(false);
  const [togglingStatus, setTogglingStatus] = useState<boolean>(false);

  const router = useRouter();

  const [timer, setTimer] = useState<number>(AUTO_DECLINE_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentJobRef = useRef<Job | null>(null);

  useEffect(() => {
    currentJobRef.current = currentJob;
  }, [currentJob]);

  // ✅ Error catching wrapper
  useEffect(() => {
    console.log("✅ WorkerHome component mounted");
    
    return () => {
      console.log("🔄 WorkerHome component unmounting");
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // ✅ Check for user changes when screen comes into focus (no dependency on currentUserPhone to avoid stale closures)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const userStr = await AsyncStorage.getItem("user");
        const userPhone = userStr ? JSON.parse(userStr).phone : null;
        
        // If user changed (compare with ref, not state), reset everything immediately
        if (userPhone && userPhone !== previousUserPhoneRef.current) {
          console.log(`👤 Worker Home: User changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting metrics`);
          previousUserPhoneRef.current = userPhone;
          setCurrentUserPhone(userPhone);
          setTodayEarnings(0);
          setTodayJobs(0);
          setCurrentJob(null);
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
          setCurrentJob(null);
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

  // ---------------- LOAD WORKER DATA & AUTO-REGISTER ----------------
  useEffect(() => {
    (async () => {
      try {
        // Initialize audio session for job alerts
        console.log("[WorkerHome] Initializing audio session for job alerts...");
        await initializeAudioSession();
        console.log("[WorkerHome] ✅ Audio session ready");

        console.log("[WorkerHome] Loading worker data and connecting socket...");
        
        const userStr = await AsyncStorage.getItem("user");
        const storedToken = await AsyncStorage.getItem("token");

        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setWorkerName(user.name);
          if (user?.workerType) setWorkerType(user.workerType);
        }

        if (storedToken) {
          setToken(storedToken);
          
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
            
            socket.auth = { token: storedToken };
            socket.connect();
            console.log("✅ Socket reconnecting with new user token");
          } else if (userPhone) {
            // Same user, just ensure socket is connected
            if (!socket.connected) {
              socket.auth = { token: storedToken };
              socket.connect();
              console.log("✅ Socket connecting (same user)");
            } else {
              console.log("✅ Socket already connected (same user)");
            }
          }

          // AUTO-REGISTER: Get location and register worker automatically
          try {
            console.log("[WorkerHome] Requesting location permission...");
            const { status } = await Location.requestForegroundPermissionsAsync();
            console.log(`[WorkerHome] Location permission status: ${status}`);
            
            if (status === "granted") {
              console.log("[WorkerHome] Getting current position...");
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
            } else {
              console.warn("⚠️ Location permission denied");
            }
          } catch (locationErr) {
            console.error("❌ Failed to get location:", locationErr);
            const errMsg = locationErr instanceof Error ? locationErr.message : String(locationErr);
            setError(`Location error: ${errMsg}`);
          }
        } else {
          console.warn("⚠️ No token found in AsyncStorage");
          setError("No authentication token found");
        }

        console.log("🔑 LOADED TOKEN:", storedToken);
      } catch (err) {
        console.error("❌ Failed to load user:", err);
        const errMsg = err instanceof Error ? err.message : String(err);
        setError(`Failed to load user: ${errMsg}`);
      }
    })();
  }, []);




  // ✅ PRODUCTION: Location updates ONLY for accepted unpaid jobs without attendance
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
    let locationInterval: ReturnType<typeof setInterval> | null = null;

    const startLocationTracking = () => {
      if (locationInterval) clearInterval(locationInterval);
      
      locationInterval = setInterval(() => {
        socket.emit("updateWorkerLocation", {
          lat: currentLocation.lat,
          lon: currentLocation.lon,
        });
        console.log("📍 Location updated (accepted job tracking):", currentLocation);
      }, 30000); // 30 seconds - frequent updates for real-time ETA
    };

    const stopLocationTracking = () => {
      if (locationInterval) {
        clearInterval(locationInterval);
        locationInterval = null;
        console.log("🛑 Location tracking stopped");
      }
    };

    // Listen for new jobs
    const handleNewJob = async (data: any) => {
      try {
        console.log("📩 SOCKET: New job received", data);
        if (!currentLocation) return;

        const location = await getAddressFromCoords(data.lat, data.lon);

        const normalizedJob: Job = {
          ...data,
          location,
          attendanceStatus: null,
          paymentStatus: null,
          timestamp: new Date().toISOString(),
        };

        setCurrentJob(normalizedJob);
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

    socket.on("newJob", handleNewJob);
    socket.on("jobUpdated", handleJobUpdated);
    socket.on("jobAccepted", handleJobAccepted);
    socket.on("jobCancelled", handleJobCancelled);

    return () => {
      stopLocationTracking();
      socket.off("newJob", handleNewJob);
      socket.off("jobUpdated", handleJobUpdated);
      socket.off("jobAccepted", handleJobAccepted);
      socket.off("jobCancelled", handleJobCancelled);
      console.log("[WorkerHome] job listeners removed (unmounted)");
    };
  }, [currentLocation, workerName, currentJob]);

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
  const calculateMetrics = async () => {
    if (!token) return;

    try {
      const res = await fetch(`${API_BASE}/jobs/my-accepted`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) return;

      const jobs: any[] = await res.json();

      // Get today's date at midnight
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Filter today's jobs that are accepted and either paid or being worked on
      const todayAcceptedJobs = jobs.filter(job => {
        if (!job.acceptedBy) return false;
        const jobDate = new Date(job.date || job.createdAt);
        jobDate.setHours(0, 0, 0, 0);
        return jobDate.getTime() === today.getTime();
      });

      // Today's earnings: sum of amount for jobs that are paid today
      const todayEarningsSum = todayAcceptedJobs
        .filter(j => j.paymentStatus === "Paid")
        .reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

      // Time on order: sum of timeSpentMinutes for today's paid jobs
      const totalTimeSpent = todayAcceptedJobs
        .filter(j => j.paymentStatus === "Paid")
        .reduce((sum, j) => sum + (Number(j.timeSpentMinutes) || 0), 0);

      // Today's jobs: count of accepted jobs today
      const todayJobsCount = todayAcceptedJobs.length;

      // Total earnings: sum of all paid jobs (all time)
      const totalEarningsSum = jobs
        .filter(j => j.paymentStatus === "Paid")
        .reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

      // History count: total count of accepted jobs (all time)
      const totalHistory = jobs.filter(j => j.acceptedBy).length;

      // Update state
      setTodayEarnings(todayEarningsSum);
      setTimeOnOrder(totalTimeSpent);
      setTodayJobs(todayJobsCount);
      setTotalEarnings(totalEarningsSum);
      setHistoryCount(totalHistory);
    } catch (err) {
      console.error("Failed to calculate metrics:", err);
    }
  };

  // Set up metrics calculation on component mount
  useEffect(() => {
    if (token) {
      calculateMetrics();
      fetchNotificationCount();
    }
  }, [token]);

  // ✅ Toggle Online/Offline Status
  const toggleOnlineStatus = async () => {
    if (togglingStatus) return; // Prevent multiple clicks
    
    setTogglingStatus(true);
    const newStatus = !isOnline;

    try {
      const res = await fetch(`${API_BASE}/workers/availability`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ isAvailable: newStatus }),
      });

      if (!res.ok) {
        throw new Error("Failed to update availability");
      }

      const data = await res.json();
      console.log(`✅ Availability updated to: ${newStatus}`);
      
      // Update local state
      setIsOnline(newStatus);
      
      // Update AsyncStorage
      const userStr = await AsyncStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        user.isAvailable = newStatus;
        await AsyncStorage.setItem("user", JSON.stringify(user));
      }

      Alert.alert(
        newStatus ? "🟢 Online" : "🔴 Offline",
        newStatus ? "You're now online and visible to contractors!" : "You're now offline."
      );
    } catch (err) {
      console.error("❌ Failed to toggle status:", err);
      Alert.alert("Error", "Failed to update availability status");
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
        return prev - 1;
      });
    }, 1000);
  };

  // ---------------- FETCH NEARBY JOBS ----------------
  const fetchNearbyJobs = async (lat: number, lon: number) => {
    console.log("📍 Fetch Nearby Jobs token:", token);

    try {
      const res = await fetch(`${API_BASE}/jobs/nearby`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ lat, lon, workerName, workerType }),
      });

      if (!res.ok) return;

      const data: Job[] = await res.json();
      const newJobs = data.filter(j => !handledJobs.has(j._id));
      if (newJobs.length === 0) return;

      const first = newJobs[0];
      const location = await getAddressFromCoords(first.lat, first.lon);

      setCurrentJob({
        ...first,
        location,
        attendanceStatus: null,
        paymentStatus: null,
      });

      startTimer();
    } catch (err) {
      console.error("Failed to fetch nearby jobs:", err);
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
        Alert.alert("Permission denied", "Location access is required.");
        return;
      }
      const loc = await Location.getCurrentPositionAsync({});
      if (!mounted) return;

      const coords = { lat: loc.coords.latitude, lon: loc.coords.longitude };
      setCurrentLocation(coords);

      await fetchNearbyJobs(coords.lat, coords.lon);
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
      setCurrentJob(null);
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
      setCurrentJob(null);

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
          {/* Header with Notification Bell & Online Toggle */}
          <View style={styles.headerContainer}>
        <View>
          <Text style={styles.dashboardText}>Dashboard</Text>
          <Text style={styles.greetingText}>Good Morning, {workerName}</Text>
        </View>
        <View style={styles.headerRightContainer}>
          {/* Online/Offline Toggle */}
          <TouchableOpacity 
            style={[styles.statusToggle, { backgroundColor: isOnline ? "#2ecc71" : "#95a5a6" }]}
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
              {isOnline ? "Online" : "Offline"}
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

      {currentJob && (
        <Modal
          visible={!!currentJob}
          transparent
          animationType="fade"
          onRequestClose={async () => {
            await cleanupJobAlert();
            setCurrentJob(null);
          }}
        >
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              {/* Close Button */}
              <TouchableOpacity 
                style={styles.closeButton}
                onPress={async () => {
                  await cleanupJobAlert();
                  setCurrentJob(null);
                }}
              >
                <MaterialIcons name="close" size={28} color="#000" />
              </TouchableOpacity>

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

                {/* Info Items */}
                <View style={styles.infoItem}>
                  <MaterialIcons name="person" size={20} color="#3498db" />
                  <View style={styles.infoText}>
                    <Text style={styles.infoLabel}>Contractor</Text>
                    <Text style={styles.infoValue}>{currentJob.contractorName || "Unknown"}</Text>
                  </View>
                </View>

                <View style={styles.infoItem}>
                  <MaterialIcons name="location-on" size={20} color="#e74c3c" />
                  <View style={styles.infoText}>
                    <Text style={styles.infoLabel}>Location</Text>
                    <Text style={styles.infoValue}>{currentJob.location || "Loading..."}</Text>
                  </View>
                </View>

                <View style={styles.infoItem}>
                  <MaterialIcons name="description" size={20} color="#f39c12" />
                  <View style={styles.infoText}>
                    <Text style={styles.infoLabel}>Description</Text>
                    <Text style={styles.infoValue}>{currentJob.description}</Text>
                  </View>
                </View>

                <View style={styles.infoItem}>
                  <MaterialIcons name="work" size={20} color="#9b59b6" />
                  <View style={styles.infoText}>
                    <Text style={styles.infoLabel}>Type</Text>
                    <Text style={styles.infoValue}>{currentJob.workerType || "General"}</Text>
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
                    setCurrentJob(null);
                  }}
                >
                  <MaterialIcons name="close" size={20} color="#fff" />
                  <Text style={styles.buttonText}>Decline</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.acceptButton}
                  onPress={() => {
                    handleAccept(currentJob._id);
                    setCurrentJob(null);
                  }}
                >
                  <MaterialIcons name="check" size={20} color="#fff" />
                  <Text style={styles.buttonText}>Accept</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      )}

      <FullContainer 
        todayEarnings={todayEarnings}
        timeOnOrder={timeOnOrder}
        todayJobs={todayJobs}
        historyCount={historyCount}
        totalEarnings={totalEarnings}
        offersClaimed={0}
        pendingOffers={0}
        activeBonuses={0}
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
    borderBottomWidth: 1,
    borderBottomColor: "#e0e0e0",
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
  topSection: { zIndex: 1 },
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
  closeButton: {
    alignSelf: "flex-end",
    padding: 5,
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
});


//***************************************************************************** */