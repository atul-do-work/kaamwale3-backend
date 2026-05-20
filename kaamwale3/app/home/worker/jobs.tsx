import React, { useEffect, useState, useRef } from "react";
import { View, Text, FlatList, Alert, Image, TouchableOpacity, Modal, RefreshControl, TextInput, ActivityIndicator, Linking } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { getAuthAccessToken } from "../../../utils/secureStore";
import { socket } from "../../../utils/socket";
import { API_BASE } from "../../../utils/config";
import styles from "../../../styles/WorkerJobsStyles";
import JobLocationMap from "../../../components/JobLocationMap";
import { useLanguage } from "../../../context/LanguageContext";
import { useJobStatus } from "../../../hooks/useJobStatus"; // ✅ Real-time job updates
import { useAuth } from "../../../context/AuthContext"; // ✅ For auth context
import { getWeekWindow } from "../../../utils/weeklyCycle";

// Local construction image
// import constructionImg from "@/assets/csite.png";

// Use shared socket instance from utils/socket

interface Job {
  _id: string; // MongoDB ObjectId (primary identifier)
  title: string;
  description: string;
  amount: string;
  contractorName: string;
  contractorPhone?: string;
  location?: string;
  imageUrl?: string; // ✅ Job image URL
  startTime?: string; // ✅ Start time like "09:00"
  endTime?: string; // ✅ End time like "18:00"
  numberOfDays?: number; // ✅ Job duration in days
  lat: number;
  lon: number;
  date: string; // ✅ Job date from backend
  status?: "pending" | "accepted" | "in_progress" | "completed" | "declined" | "cancelled" | "expired";
  acceptedBy?: string;
  acceptedWorkers?: Array<{
    phone?: string;
    workerPhone?: string;
    acceptedBy?: string;
    paymentStatus?: string;
  }>;
  paymentStatus?: "paid" | null;
  rating?: {
    stars: number;
    feedback?: string;
    ratedAt?: string;
    ratedBy?: string;
  };
  contractorRating?: {
    stars: number;
    feedback?: string;
    ratedAt?: string;
    ratedBy?: string;
  };
  createdAt?: string;
  paymentTime?: string;
}

const EMERGENCY_CALL_NUMBER = "112";
const SUPPORT_CALL_NUMBER = "18001234567";

const normalizePhoneDigits = (value: any) => String(value || "").replace(/\D/g, "").slice(-10);
const getWorkerEntryForPhone = (job: Job, currentUserPhone?: string | null) => {
  if (!currentUserPhone || !Array.isArray((job as any)?.acceptedWorkers)) return null;
  const targetDigits = normalizePhoneDigits(currentUserPhone);
  if (!targetDigits) return null;
  return ((job as any).acceptedWorkers as any[]).find((w: any) =>
    normalizePhoneDigits(w?.phone || w?.workerPhone || w?.acceptedBy || "") === targetDigits
  ) || null;
};
const isPaid = (job: Job, currentUserPhone?: string | null): boolean => {
  const workerEntry = getWorkerEntryForPhone(job, currentUserPhone);
  if (workerEntry && String(workerEntry?.paymentStatus || "").toLowerCase() === "paid") return true;
  return String(job?.paymentStatus || "").toLowerCase() === "paid";
};

const isCurrentUserAssignedToJob = (job: Job, currentUserPhone?: string | null): boolean => {
  if (!currentUserPhone) return false;
  const normalizedCurrent = normalizePhoneDigits(currentUserPhone);
  if (!normalizedCurrent) return false;

  const phoneMatches = (value?: string | null) => normalizePhoneDigits(value) === normalizedCurrent;

  if (phoneMatches(job.acceptedBy)) return true;
  const acceptedWorker = (job as any).acceptedWorker;
  if (acceptedWorker) {
    if (phoneMatches(acceptedWorker.phone) || phoneMatches(acceptedWorker.workerPhone) || phoneMatches(acceptedWorker.acceptedBy)) {
      return true;
    }
  }

  if (Array.isArray((job as any).acceptedWorkers)) {
    return (job as any).acceptedWorkers.some((w: any) =>
      phoneMatches(w?.phone) || phoneMatches(w?.workerPhone) || phoneMatches(w?.acceptedBy)
    );
  }

  return false;
};

const isPaidStatus = (status?: string | null | undefined): boolean => String(status || "").toLowerCase() === "paid";

const isJobDayExpired = (job: Job): boolean => {
  const sourceDate = job?.date || job?.createdAt || job?.paymentTime;
  if (!sourceDate) return false;
  const parsed = new Date(sourceDate);
  if (Number.isNaN(parsed.getTime())) return false;

  // Local-time day boundary: card moves after local midnight of job day.
  const nextMidnight = new Date(parsed);
  nextMidnight.setHours(24, 0, 0, 0);
  return new Date() >= nextMidnight;
};

const isJobOlderThan30Days = (job: Job): boolean => {
  const sourceDate = job?.paymentTime || job?.date || job?.createdAt;
  if (!sourceDate) return false;
  const parsed = new Date(sourceDate);
  if (Number.isNaN(parsed.getTime())) return false;

  // Check if job is older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  return parsed < thirtyDaysAgo;
};

export default function Jobs(): React.ReactElement {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken } = useAuth();
  const insets = useSafeAreaInsets();
  const [workerName, setWorkerName] = useState<string>("Test Worker");
  
  // ✅ Real-time job status with smart caching
  const { jobs: hookJobs, loading, error: jobError, refresh: refreshJobs } = useJobStatus();
  const [acceptedJobs, setAcceptedJobs] = useState<Job[]>([]);

  // ✅ Geocode jobs without location names
  useEffect(() => {
    const geocodeJobs = async () => {
      const jobsToGeocode = Array.isArray(hookJobs) ? hookJobs.filter(job => !job.location && job.lat && job.lon) : [];
      
      if (jobsToGeocode.length === 0) {
        setAcceptedJobs(Array.isArray(hookJobs) ? hookJobs : []);
        return;
      }

      const geocodedJobs = await Promise.all(
        jobsToGeocode.map(async (job) => {
          const location = await getAddressFromCoords(job.lat, job.lon);
          console.log("🌍 Geocoded job", job._id, "Location:", location);
          return { ...job, location };
        })
      );

      setAcceptedJobs(
        Array.isArray(hookJobs)
          ? hookJobs.map(job => {
              const geocoded = geocodedJobs.find(g => g._id === job._id);
              return geocoded || job;
            })
          : []
      );
    };

    geocodeJobs();
  }, [hookJobs]);
  
  const [refreshing, setRefreshing] = useState<boolean>(false); // ✅ Pull-to-refresh state
  const [token, setToken] = useState<string>("");
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const [mapModalVisible, setMapModalVisible] = useState<boolean>(false);
  const [selectedJobForMap, setSelectedJobForMap] = useState<Job | null>(null);
  const [paymentModalVisible, setPaymentModalVisible] = useState<boolean>(false);
  const [paymentJobData, setPaymentJobData] = useState<{ title: string; amount: string; contractor: string } | null>(null);
  const [paymentSupportModalVisible, setPaymentSupportModalVisible] = useState<boolean>(false);
  const [contractorRatingModalVisible, setContractorRatingModalVisible] = useState<boolean>(false);
  const [selectedJobForContractorRating, setSelectedJobForContractorRating] = useState<Job | null>(null);
  const [contractorRatingStars, setContractorRatingStars] = useState<number>(5);
  const [contractorRatingFeedback, setContractorRatingFeedback] = useState<string>("");
  const [submittingContractorRating, setSubmittingContractorRating] = useState<boolean>(false);
  const [cancelModalVisible, setCancelModalVisible] = useState<boolean>(false);
  const [selectedCancelJob, setSelectedCancelJob] = useState<Job | null>(null);
  const [pastJobsModalVisible, setPastJobsModalVisible] = useState<boolean>(false);
  const [pastJobsLimit, setPastJobsLimit] = useState<number>(2);
  const [cancelReason, setCancelReason] = useState<string>("");
  const [cancelReasonDescription, setCancelReasonDescription] = useState<string>("");
  const [cancelProcessing, setCancelProcessing] = useState<boolean>(false);
  const previousPaymentState = useRef<Record<string, string | null | undefined>>({});
  const previousUserPhoneRef = useRef<string | null>(null); 
  const paymentNotifiedJobs = useRef<Set<string>>(new Set()); 

  const dialNumber = async (number: string) => {
    const normalized = String(number || "").trim();
    if (!normalized) {
      Alert.alert(t('error'), t('supportNumberUnavailable'), [
        { text: t('cancel'), style: "cancel" },
        { text: t('supportTickets'), onPress: () => router.push("/SupportTickets" as any) },
      ]);
      return;
    }
    const telUrl = `tel:${normalized}`;
    const smsUrl = `sms:${normalized}`;
    try {
      const supported = await Linking.canOpenURL(telUrl);
      if (!supported) {
        const smsSupported = await Linking.canOpenURL(smsUrl);
        if (smsSupported) {
          Alert.alert(
            t('callNotAvailable'),
            t('callingNotSupportedMessage').replace('{number}', normalized),
            [
              { text: t('cancel'), style: "cancel" },
              { text: t('supportTickets'), onPress: () => router.push("/SupportTickets" as any) },
              { text: t('sendSms'), onPress: () => Linking.openURL(smsUrl) },
            ]
          );
          return;
        }
        Alert.alert(t('callNotAvailable'), t('pleaseContactSupportAt').replace('{number}', normalized), [
          { text: t('ok') },
          { text: t('supportTickets'), onPress: () => router.push("/SupportTickets" as any) },
        ]);
        return;
      }
      await Linking.openURL(telUrl);
    } catch {
      Alert.alert(t('error'), t('couldNotStartContactAction').replace('{number}', normalized), [
        { text: t('cancel'), style: "cancel" },
        { text: t('supportTickets'), onPress: () => router.push("/SupportTickets" as any) },
      ]);
    }
  };

  const showHelpOptions = (job?: Job) => {
    const supportNumber = job?.contractorPhone || SUPPORT_CALL_NUMBER;
    Alert.alert(t('needHelpTitle'), t('chooseOption'), [
      { text: t('cancel'), style: "cancel" },
      { text: t('emergencyCall'), style: "destructive", onPress: () => dialNumber(EMERGENCY_CALL_NUMBER) },
      { text: t('supportCall'), onPress: () => dialNumber(supportNumber) },
    ]);
  };

  const normalizeMediaUrl = (url?: string | null): string | null => {
    if (!url || typeof url !== "string") return null;
    const trimmed = url.trim();
    if (!trimmed) return null;

    // Upgrade http media links to https in production to avoid blocked/insecure image loads.
    if (trimmed.startsWith("http://")) return trimmed.replace("http://", "https://");
    if (trimmed.startsWith("https://")) return trimmed;
    if (trimmed.startsWith("/")) return `${API_BASE}${trimmed}`;
    return `${API_BASE}/${trimmed}`;
  };

  // ✅ Check for user changes when screen comes into focus (no dependency on currentUserPhone to avoid stale closures)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const userStr = await AsyncStorage.getItem("user");
        const userPhone = userStr ? JSON.parse(userStr).phone : null;
        
        // If user changed, reset accepted jobs
        if (userPhone && userPhone !== previousUserPhoneRef.current) {
          console.log(`👤 Jobs: User changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting jobs`);
          previousUserPhoneRef.current = userPhone;
          setCurrentUserPhone(userPhone);
          setAcceptedJobs([]);
          previousPaymentState.current = {};
          paymentNotifiedJobs.current.clear(); // ✅ Clear notification tracking
        } else if (!userPhone && previousUserPhoneRef.current !== null) {
          // User logged out
          console.log(`👤 Jobs: User logged out, resetting jobs`);
          previousUserPhoneRef.current = null;
          setCurrentUserPhone(null);
          setAcceptedJobs([]);
          previousPaymentState.current = {};
          paymentNotifiedJobs.current.clear(); // ✅ Clear notification tracking
        }
      })();
    }, [])
  );

  // Load worker name + token from SecureStore
  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const storedToken = await getAuthAccessToken();

        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setWorkerName(user.name);
        }

        if (storedToken) {
          setToken(storedToken);
          
          // ✅ AUTHENTICATE SOCKET WITH TOKEN (global socket, don't disconnect)
          // Socket should already be authenticated from login, just ensure it's connected
          if (!socket.connected) {
            socket.auth = { token: storedToken };
            socket.connect();
            console.log("✅ Socket connecting/reconnecting with token for jobs");
          } else {
            console.log("✅ Socket already connected, using for jobs");
          }
          
          // Wait for socket to be ready
          await new Promise((resolve) => {
            const checkReady = () => {
              if (socket.connected) {
                console.log("✅ Socket ready for jobs");
                resolve(true);
              } else {
                setTimeout(checkReady, 100);
              }
            };
            checkReady();
          });
        }
      } catch (err) {
        console.error("Failed to load user or token", err);
      }
    })();
  }, []);

  // ✅ Handle pull-to-refresh (don't show full loading spinner, only refresh indicator)
  const handleRefresh = async () => {
    setRefreshing(true);
    await refreshJobs(); // ✅ Hook handles the refresh
    setRefreshing(false);
  };

  // Helper: get full address from lat/lon
  const getAddressFromCoords = async (lat: number, lon: number) => {
    try {
      console.log(`     📍 Reverse geocoding: lat=${lat}, lon=${lon}`);
      
      if (!lat || !lon) {
        console.warn(`     ⚠️ Invalid coordinates: lat=${lat}, lon=${lon}`);
        return t('unknownLocation');
      }
      
      // Ensure Location is available
      if (!Location || !Location.reverseGeocodeAsync) {
        console.error(`     ❌ Location API not available`);
        return t('unknownLocation');
      }
      
      const result = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
      console.log(`     ✅ Geocode result:`, result);
      
      if (!result || result.length === 0) {
        console.warn(`     ⚠️ No geocode results`);
        return t('unknownLocation');
      }
      
      const address = result[0];
      const area = address.name || address.street || "";
      const city = address.city || address.region || "";
      const locationStr = area && city ? `${area}, ${city}` : area || city || t('unknownLocation');
      console.log(`     📌 Formatted location:`, locationStr);
      
      return locationStr;
    } catch (err) {
      console.error(`     ❌ Reverse geocoding error:`, err);
      return t('unknownLocation');
    }
  };

  // ---------------- SOCKET.IO LISTENERS ----------------
  useEffect(() => {
    if (!workerName || !token) return;

    // ✅ Ensure socket is connected
    const setupSocket = async () => {
      // If disconnected, reconnect with auth
      if (!socket.connected) {
        socket.auth = { token };
        socket.connect();
        console.log("🔗 Socket reconnecting with token");
        
        // Wait for connection
        await new Promise((resolve) => {
          const checkConn = () => {
            if (socket.connected) {
              console.log("✅ Socket connected");
              resolve(true);
            } else {
              setTimeout(checkConn, 100);
            }
          };
          checkConn();
        });
      }
    };

    // ✅ IIFE to handle async setup
    (async () => {
      await setupSocket();
      // Removed fetchAcceptedJobs call - using hook instead
    })();

    const handleJobUpdated = async (job: Job) => {
      console.log("📢 Job updated event received:", job._id, "Status:", job.paymentStatus, "Rating:", job.rating);
      // If server sent targeted update and current user is not in the target list, ignore
      if ((job as any)._targetedUpdate && Array.isArray((job as any).targetedFor)) {
        const targets = ((job as any).targetedFor || []).map((t: any) => t && t.toString());
        if (!targets.includes(currentUserPhone) && !targets.includes(workerName)) {
          console.log('Ignored targeted jobUpdated not meant for this worker');
          return;
        }
      }
      
      // 🔐 CRITICAL: Verify current user is assigned to this job using normalized phone matching
      if (!isCurrentUserAssignedToJob(job, currentUserPhone)) {
        console.log(`⚠️ Job ${job._id} is not assigned to current user (${currentUserPhone}), ignoring`);
        return;
      }

      const location = job.location || (await getAddressFromCoords(job.lat, job.lon));
      console.log("📍 Location resolved for job:", job._id, "Location:", location, "From backend:", job.location);
      
      // ✅ Optimized: Use findIndex to avoid double .find() calls
      setAcceptedJobs((prev) => {
        const index = prev.findIndex((j) => j._id === job._id);

        // Remove cancelled/expired jobs from worker list immediately.
        if (job.status === "cancelled" || job.status === "expired") {
          return prev.filter((j) => j._id !== job._id);
        }
        
        if (index !== -1) {
          // Job exists - merge with existing job, preserving all fields including rating
          const updated = [...prev];
          updated[index] = {
            ...updated[index],
            ...job,
            location,
          };
          console.log("✅ Merged job with rating:", updated[index].rating);
          console.log("📋 Full merged job object:", updated[index]);
          console.log("📍 Location in merged job:", updated[index].location);
          return updated;
        } else if (job.status === "accepted") {
          // New job - add to list
          return [...prev, { ...job, location }];
        }
        return prev;
      });

      if (!isPaidStatus(previousPaymentState.current[job._id]) && isPaid(job, currentUserPhone)) {
        if (!paymentNotifiedJobs.current.has(job._id)) {
          paymentNotifiedJobs.current.add(job._id);
          setPaymentJobData({
            title: job.title,
            amount: job.amount,
            contractor: job.contractorName,
          });
          setPaymentModalVisible(true);
        }
      }
      previousPaymentState.current[job._id] = isPaid(job, currentUserPhone) ? 'paid' : null;
    };

    // Subscribe to socket events
    socket.on("jobUpdated", handleJobUpdated);
    // ❌ REMOVED: socket.on("jobUpdated", handleNewJob) - Causes duplicate renders and flickering
    // handleJobUpdated already updates the local state, no need to refetch everything

    // Cleanup on unmount
    return () => {
      socket.off("jobUpdated", handleJobUpdated);
      // ❌ REMOVED: socket.off("jobUpdated", handleNewJob)
    };
  }, [workerName, token, currentUserPhone]); // ✅ Added currentUserPhone to deps

  // ✅ Render individual job card (optimized for FlatList virtualization)
  const workerCancelOptions = [
    { key: "worker_unavailable", label: t('cancelReasonWorkerUnavailable') },
    { key: "location_changed", label: t('cancelReasonLocationChanged') },
    { key: "safety_concern", label: t('cancelReasonSafetyConcern') },
    { key: "contractor_request", label: t('cancelReasonContractorRequested') },
    { key: "technical_issue", label: t('cancelReasonTechnicalIssue') },
    { key: "other", label: t('cancelReasonOther') },
  ];

  const openCancelModal = (job: Job) => {
    setSelectedCancelJob(job);
    setCancelReason("");
    setCancelReasonDescription("");
    setCancelModalVisible(true);
  };

  const closeCancelModal = () => {
    setCancelModalVisible(false);
    setSelectedCancelJob(null);
    setCancelReason("");
    setCancelReasonDescription("");
  };

  const submitJobCancellation = async () => {
    if (!selectedCancelJob) return;
    if (!cancelReason) {
      return Alert.alert(t('error'), t('selectCancellationReason'));
    }
    if (!token) {
      return Alert.alert(t('error'), t('notAuthenticated'));
    }

    setCancelProcessing(true);
    try {
      const response = await fetch(`${API_BASE}/jobs/cancel/${selectedCancelJob._id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          reason: cancelReason,
          reasonDescription: cancelReasonDescription,
        }),
      });

      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        return Alert.alert(t('error'), payload?.message || t('cancellationFailedTryAgain'));
      }

      setAcceptedJobs((prev) => prev.filter((job) => job._id !== selectedCancelJob._id));
      Alert.alert(t('success'), payload?.message || t('jobCancelledNewCandidate'));
      closeCancelModal();
    } catch (err) {
      console.error("Cancel job error:", err);
      Alert.alert(t('error'), t('cancellationFailedTryAgain'));
    } finally {
      setCancelProcessing(false);
    }
  };

  const openRateContractorModal = (job: Job) => {
    setSelectedJobForContractorRating(job);
    setContractorRatingStars(5);
    setContractorRatingFeedback("");
    setContractorRatingModalVisible(true);
  };

  // Reset jobs screen data at local midnight, then refetch.
  useEffect(() => {
    if (!token || !workerName) return;

    let midnightTimeout: ReturnType<typeof setTimeout> | null = null;
    let midnightInterval: ReturnType<typeof setInterval> | null = null;

    const resetAndReload = async () => {
      previousPaymentState.current = {};
      paymentNotifiedJobs.current.clear();
      await refreshJobs(); // ✅ Hook handles fetching
    };

    const scheduleMidnightReset = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0);
      const msUntilMidnight = Math.max(1000, nextMidnight.getTime() - now.getTime());

      midnightTimeout = setTimeout(() => {
        resetAndReload();
        midnightInterval = setInterval(resetAndReload, 24 * 60 * 60 * 1000);
      }, msUntilMidnight);
    };

    scheduleMidnightReset();

    return () => {
      if (midnightTimeout) clearTimeout(midnightTimeout);
      if (midnightInterval) clearInterval(midnightInterval);
    };
  }, [token, workerName]);

  // Refresh weekly jobs at week boundary (Monday 12:00 AM local).
  useEffect(() => {
    if (!token || !workerName) return;

    let weekTimeout: ReturnType<typeof setTimeout> | null = null;
    let weekInterval: ReturnType<typeof setInterval> | null = null;

    const reloadWeekly = async () => {
      await refreshJobs(); // ✅ Hook handles fetching
    };

    const scheduleWeeklyRefresh = () => {
      const now = new Date();
      const { weekEnd } = getWeekWindow();
      const msUntilWeekBoundary = Math.max(1000, weekEnd.getTime() - now.getTime());

      weekTimeout = setTimeout(() => {
        reloadWeekly();
        weekInterval = setInterval(reloadWeekly, 7 * 24 * 60 * 60 * 1000);
      }, msUntilWeekBoundary);
    };

    scheduleWeeklyRefresh();

    return () => {
      if (weekTimeout) clearTimeout(weekTimeout);
      if (weekInterval) clearInterval(weekInterval);
    };
  }, [token, workerName]);

  const submitContractorRating = async () => {
    if (!selectedJobForContractorRating || !token || submittingContractorRating) return;

    try {
      setSubmittingContractorRating(true);
      const res = await fetch(`${API_BASE}/jobs/rate-contractor/${selectedJobForContractorRating._id}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          stars: contractorRatingStars,
          feedback: contractorRatingFeedback,
        }),
      });

      const payload = await res.json();
      if (!res.ok || !payload?.success) {
        return Alert.alert(t('error'), payload?.message || t('failedSubmitContractorRating'));
      }

      setAcceptedJobs((prev) =>
        prev.map((j) =>
          j._id === selectedJobForContractorRating._id
            ? {
                ...j,
                contractorRating: payload?.job?.contractorRating || {
                  stars: contractorRatingStars,
                  feedback: contractorRatingFeedback,
                },
              }
            : j
        )
      );

      setContractorRatingModalVisible(false);
      setSelectedJobForContractorRating(null);
      Alert.alert(t('success'), t('contractorRatedSuccessfully'));
    } catch (err) {
      console.error("Failed to submit contractor rating:", err);
      Alert.alert(t('error'), t('couldNotSubmitContractorRating'));
    } finally {
      setSubmittingContractorRating(false);
    }
  };

  const renderJobCard = ({ item: job }: { item: Job }) => {
    const jobImageUri = normalizeMediaUrl(job.imageUrl);
    const formatDateRange = () => {
      if (!job.date) return "";
      const jobDate = new Date(job.date);
      const endDate = new Date(jobDate);
      if (job.numberOfDays) {
        endDate.setDate(endDate.getDate() + job.numberOfDays - 1);
      }
      const startStr = jobDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      const endStr = endDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
      return jobDate.getTime() === endDate.getTime() ? startStr : `${startStr} to ${endStr}`;
    };

    return (
      <View style={{ marginHorizontal: 12, marginBottom: 14 }}>
        <View
          style={{
            borderRadius: 12,
            overflow: "hidden",
            backgroundColor: "#FFF",
            shadowColor: "#000",
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 8,
            elevation: 4,
          }}
        >
          {/* Top Image with Category Badge */}
          <View style={{ height: 150, overflow: "hidden", backgroundColor: "#EEE", position: "relative" }}>
            <Image
              source={jobImageUri ? { uri: jobImageUri } : require("../../../assets/demp.jpg")}
              style={{ width: "100%", height: "100%", resizeMode: "cover" }}
            />
            {/* Category Badge - Top Left */}
            <View
              style={{
                position: "absolute",
                top: 10,
                left: 10,
                backgroundColor: "#fff",
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 12,
                shadowColor: "#000",
                shadowOpacity: 0.15,
                shadowRadius: 4,
                elevation: 3,
              }}
            >
              <Text style={{ color: "#374151", fontSize: 11, fontWeight: "600" }}>
                {job.title || job.description || "Job"}
              </Text>
            </View>

            {/* Help Icons - Top Right (only if not paid) */}
            {!isPaid(job, currentUserPhone) && (
              <View
                style={{
                  position: "absolute",
                  right: 10,
                  bottom: 10,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                <TouchableOpacity
                  onPress={() => dialNumber(job.contractorPhone || "")}
                  disabled={!job.contractorPhone}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: "#22c55e",
                    justifyContent: "center",
                    alignItems: "center",
                    opacity: job.contractorPhone ? 1 : 0.4,
                    shadowColor: "#000",
                    shadowOpacity: 0.25,
                    shadowRadius: 3,
                    elevation: 3,
                  }}
                >
                  <MaterialIcons name="phone" size={16} color="#fff" />
                </TouchableOpacity>

                <TouchableOpacity
                  onPress={() => showHelpOptions(job)}
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: "#ef4444",
                    justifyContent: "center",
                    alignItems: "center",
                    shadowColor: "#000",
                    shadowOpacity: 0.25,
                    shadowRadius: 3,
                    elevation: 3,
                  }}
                >
                  <MaterialIcons name="notification-important" size={16} color="#fff" />
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Content Section */}
          <View style={{ paddingHorizontal: 14, paddingVertical: 12 }}>
            {/* Header Row: Contractor Name + Description | Amount + Paid (stacked) */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, gap: 12 }}>
              {/* Left: Contractor Name + Description */}
              <View style={{ flex: 1 }}>
                <Text style={{ color: "#111827", fontSize: 15, fontWeight: "700", marginBottom: 2 }}>
                  {job.contractorName}
                </Text>
                <Text style={{ color: "#666", fontSize: 12, fontWeight: "500" }}>
                  {job.description || "Labour"}
                </Text>
              </View>

              {/* Right: Amount and Paid (vertically stacked) */}
              <View style={{ alignItems: "flex-end", gap: 6 }}>
                {/* Amount */}
                <Text style={{ color: "#16A34A", fontSize: 18, fontWeight: "800" }}>
                  ₹{job.amount || "0"}
                </Text>

                {/* Paid Status Badge */}
                <View
                  style={{
                    paddingHorizontal: 8,
                    paddingVertical: 4,
                    borderRadius: 16,
                    backgroundColor: isPaid(job, currentUserPhone) ? "#DCFCE7" : "#FEF3C7",
                  }}
                >
                  <Text
                    style={{
                      fontSize: 11,
                      fontWeight: "600",
                      color: isPaid(job, currentUserPhone) ? "#16A34A" : "#CA8A04",
                    }}
                  >
                    {isPaid(job, currentUserPhone) ? "Paid" : "Pending"}
                  </Text>
                </View>
              </View>
            </View>

            {/* Grey Container - Date, Time, Duration, Location */}
            <View style={{
              backgroundColor: "#F3F4F6",
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 12,
              marginBottom: 12,
              gap: 10,
              overflow: "visible"
            }}>
              {/* Date, Time, Duration Row */}
              <View style={{ flexDirection: "row", gap: 8, justifyContent: "space-between" }}>
                {/* Date */}
                <View style={{ flex: 1, flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <MaterialIcons name="event" size={16} color="#666" />
                  <Text style={{ color: "#666", fontSize: 10, fontWeight: "500", textAlign: "center" }}>
                    {formatDateRange()}
                  </Text>
                </View>

                {/* Time */}
                {job.startTime && job.endTime && (
                  <View style={{ flex: 1, flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <MaterialIcons name="access-time" size={16} color="#666" />
                    <Text style={{ color: "#666", fontSize: 10, fontWeight: "500", textAlign: "center" }}>
                      {job.startTime} - {job.endTime}
                    </Text>
                  </View>
                )}

                {/* Duration */}
                {job.numberOfDays && (
                  <View style={{ flex: 1, flexDirection: "column", alignItems: "center", gap: 3 }}>
                    <MaterialIcons name="schedule" size={16} color="#666" />
                    <Text style={{ color: "#666", fontSize: 10, fontWeight: "500", textAlign: "center" }}>
                      {job.numberOfDays} {job.numberOfDays === 1 ? t('day') : t('days')}
                    </Text>
                  </View>
                )}
              </View>

              {/* Location - Below date/time/duration - Always Show */}
              <TouchableOpacity
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 10,
                  paddingTop: 12,
                  paddingBottom: 4,
                  borderTopWidth: 1,
                  borderTopColor: "#E5E7EB",
                  minHeight: 44
                }}
                onPress={() => {
                  setSelectedJobForMap(job);
                  setMapModalVisible(true);
                }}
              >
                <MaterialIcons name="location-on" size={20} color="#16A34A" style={{ marginTop: 2, flexShrink: 0 }} />
                <Text 
                  style={{ color: "#1F2937", fontSize: 13, flex: 1, fontWeight: "600", lineHeight: 18 }}
                  numberOfLines={2}
                >
                  {job.location || "Loading location..."}
                </Text>
                <MaterialIcons name="chevron-right" size={20} color="#999" style={{ marginTop: 2, flexShrink: 0 }} />
              </TouchableOpacity>
            </View>

            {/* Ratings Row - Side by Side */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8, marginBottom: isPaid(job, currentUserPhone) ? 10 : 0 }}>
              {/* Your Rating */}
              <View style={{ flex: 1, alignItems: "center", paddingVertical: 8, backgroundColor: "#F9FAFB", borderRadius: 8 }}>
                <Text style={{ color: "#6B7280", fontSize: 10, fontWeight: "500", marginBottom: 3 }}>
                  Your Rating
                </Text>
                {typeof job.rating?.stars === "number" ? (
                  <View style={{ flexDirection: "row" }}>
                    {[1, 2, 3, 4, 5].map((star) => (
                      <MaterialIcons
                        key={star}
                        name="star"
                        size={12}
                        color={star <= (job.rating?.stars ?? 0) ? "#FFD700" : "#DDD"}
                        style={{ marginHorizontal: 1 }}
                      />
                    ))}
                  </View>
                ) : (
                  <Text style={{ color: "#999", fontSize: 10 }}>—</Text>
                )}
              </View>

              {/* Contractor Rating (only if paid) */}
              {isPaid(job, currentUserPhone) && (
                <View style={{ flex: 1, alignItems: "center", paddingVertical: 8, backgroundColor: "#F9FAFB", borderRadius: 8 }}>
                  <Text style={{ color: "#6B7280", fontSize: 10, fontWeight: "500", marginBottom: 3 }}>
                    Contractor Rating
                  </Text>
                  {job.contractorRating?.stars ? (
                    <View style={{ alignItems: "center" }}>
                      <View style={{ flexDirection: "row" }}>
                        {[1, 2, 3, 4, 5].map((star) => (
                          <MaterialIcons
                            key={star}
                            name="star"
                            size={12}
                            color={star <= (job.contractorRating?.stars ?? 0) ? "#FFD700" : "#DDD"}
                            style={{ marginHorizontal: 1 }}
                          />
                        ))}
                      </View>
                    </View>
                  ) : (
                    <Text style={{ color: "#999", fontSize: 10 }}>—</Text>
                  )}
                </View>
              )}
            </View>

            {/* Feedback (if available) */}
            {job.rating?.feedback && (
              <View
                style={{
                  backgroundColor: "#FFFACD",
                  borderLeftWidth: 3,
                  borderLeftColor: "#FFD700",
                  paddingHorizontal: 8,
                  paddingVertical: 6,
                  borderRadius: 4,
                  marginBottom: 8,
                }}
              >
                <Text style={{ color: "#666", fontSize: 10, fontStyle: "italic", lineHeight: 12 }}>
                  "{job.rating.feedback}"
                </Text>
              </View>
            )}

            {/* Action Buttons */}
            {isPaid(job, currentUserPhone) && !job.contractorRating?.stars && (
              <TouchableOpacity
                style={{
                  backgroundColor: "#1d4ed8",
                  height: 36,
                  borderRadius: 8,
                  justifyContent: "center",
                  alignItems: "center",
                  marginTop: 8,
                }}
                onPress={() => openRateContractorModal(job)}
              >
                <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
                  {t('rateContractor')}
                </Text>
              </TouchableOpacity>
            )}

            {!isPaid(job, currentUserPhone) && (job.status === "accepted" || job.status === "in_progress") && job.acceptedBy === currentUserPhone && (
              <View style={{ marginTop: 8 }}>
                <Text style={{ color: "#b91c1c", fontSize: 11, marginBottom: 6, fontWeight: "500" }}>
                  {t('cancelJobCardWarning')}
                </Text>
                <TouchableOpacity
                  style={{
                    backgroundColor: "#dc2626",
                    height: 36,
                    borderRadius: 8,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                  onPress={() => openCancelModal(job)}
                >
                  <Text style={{ color: "#fff", fontSize: 12, fontWeight: "700" }}>
                    {t('cancelJob')}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </View>
    );
  };

  // Keep card in main list until BOTH conditions are true:
  // 1) payment completed, 2) day expired (past local midnight).
  const pendingJobs = acceptedJobs.filter((job) => !(isPaid(job, currentUserPhone) && isJobDayExpired(job)));
  const previewJobs = pendingJobs.slice(0, 3);

  const pastJobs = acceptedJobs
    .filter((job) => isPaid(job, currentUserPhone) && isJobDayExpired(job) && !isJobOlderThan30Days(job))
    .sort((a, b) => {
      const aTime = new Date(a.paymentTime || a.date || a.createdAt || 0).getTime();
      const bTime = new Date(b.paymentTime || b.date || b.createdAt || 0).getTime();
      return bTime - aTime;
    });

  const { weekStart, weekEnd } = getWeekWindow();
  const weeklyJobs = acceptedJobs.filter((job) => {
    const sourceDate = job.paymentTime || job.date || job.createdAt;
    if (!sourceDate) return false;
    const d = new Date(sourceDate);
    if (Number.isNaN(d.getTime())) return false;
    return d >= weekStart && d < weekEnd;
  });

  const openPastJobsModal = () => {
    setPastJobsLimit(2);
    setPastJobsModalVisible(true);
  };

  const loadMorePastJobs = () => {
    setPastJobsLimit((prev) => Math.min(prev + 2, pastJobs.length));
  };

  const displayedPastJobs = pastJobs.slice(0, pastJobsLimit);

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: '#111827' }}>{t('acceptedJobs') || 'Accepted Jobs'}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <TouchableOpacity onPress={openPastJobsModal}>
            <MaterialIcons name="history" size={22} color="#1d4ed8" />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/BrowseJobs' as any)}>
            <MaterialIcons name="search" size={22} color="#1d4ed8" />
          </TouchableOpacity>
        </View>
      </View>
      <FlatList
        data={previewJobs}
        keyExtractor={(item) => item._id}
        style={styles.container}
        contentContainerStyle={{ paddingVertical: 12, paddingBottom: insets.bottom + 90 }}
        ListFooterComponent={<View style={{ height: insets.bottom + 24 }} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#667eea" />
        }
        ListEmptyComponent={
          <View style={{ flex: 1, justifyContent: "center", alignItems: "center", paddingVertical: 40 }}>
            {loading ? (
              <Text style={styles.loadingText}>{t('loadingJobs')}</Text>
            ) : (
              <Text style={styles.noJobsText}>{t('noPendingJobs')}</Text>
            )}
          </View>
        }
        renderItem={renderJobCard}
      />

      <Modal
        visible={pastJobsModalVisible}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setPastJobsModalVisible(false)}
      >
        <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: '#f9fafb' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14, backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb' }}>
            <Text style={{ fontSize: 20, fontWeight: '800', color: '#111827' }}>{t('pastJobs') || 'Past Jobs'}</Text>
            <TouchableOpacity onPress={() => setPastJobsModalVisible(false)} style={{ padding: 8 }}>
              <MaterialIcons name="close" size={28} color="#1d4ed8" />
            </TouchableOpacity>
          </View>

          <View style={{ flex: 1 }}>
            <FlatList
              data={displayedPastJobs}
              keyExtractor={(item) => item._id}
              contentContainerStyle={{ paddingBottom: 24, paddingTop: 16 }}
              ListEmptyComponent={
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 40 }}>
                  <Text style={{ color: '#6b7280', fontSize: 14 }}>{t('noPastJobsYet')}</Text>
                </View>
              }
              ListFooterComponent={
                pastJobs.length > displayedPastJobs.length ? (
                  <View style={{ alignItems: 'center', marginTop: 6, marginBottom: 24 }}>
                    <TouchableOpacity
                      onPress={loadMorePastJobs}
                      style={{ paddingVertical: 10, paddingHorizontal: 20, backgroundColor: '#1d4ed8', borderRadius: 999, minWidth: 140, alignItems: 'center' }}
                    >
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
                        {t('loadMore') || 'Load More'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ) : null
              }
              renderItem={renderJobCard}
            />
          </View>
        </SafeAreaView>
      </Modal>

      <Modal
        visible={cancelModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCancelModal}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 18 }}>
          <View style={{ backgroundColor: "#fff", borderRadius: 18, padding: 18, maxHeight: "90%" }}>
            <Text style={{ fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 10 }}>
              {t('cancelJob')}
            </Text>
            <Text style={{ color: "#374151", fontSize: 13, marginBottom: 18, lineHeight: 20 }}>
              {t('cancelJobDescription')}
            </Text>

            <View style={{ marginBottom: 14 }}>
              {workerCancelOptions.map((option) => (
                <TouchableOpacity
                  key={option.key}
                  onPress={() => setCancelReason(option.key)}
                  style={{
                    paddingVertical: 12,
                    paddingHorizontal: 14,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: cancelReason === option.key ? "#2563eb" : "#d1d5db",
                    backgroundColor: cancelReason === option.key ? "#eff6ff" : "#fff",
                    marginBottom: 10,
                  }}
                >
                  <Text style={{ color: cancelReason === option.key ? "#1d4ed8" : "#374151", fontWeight: cancelReason === option.key ? "700" : "500" }}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <View style={{ marginBottom: 16 }}>
              <Text style={{ color: "#4b5563", fontSize: 13, marginBottom: 6 }}>{t('additionalDetails') || "Additional details (optional)"}</Text>
              <TextInput
                value={cancelReasonDescription}
                onChangeText={setCancelReasonDescription}
                placeholder={t('describeCancelReason')}
                placeholderTextColor="#9ca3af"
                multiline
                numberOfLines={4}
                style={{
                  minHeight: 92,
                  borderWidth: 1,
                  borderColor: "#d1d5db",
                  borderRadius: 12,
                  padding: 12,
                  textAlignVertical: "top",
                  color: "#111827",
                }}
              />
            </View>

            <View style={{ backgroundColor: "#fef3c7", borderRadius: 12, padding: 12, marginBottom: 16 }}>
              <Text style={{ color: "#92400e", fontSize: 12, fontWeight: "600", marginBottom: 6 }}>
                {t('important')}
              </Text>
              <Text style={{ color: "#92400e", fontSize: 12, lineHeight: 18 }}>
                {t('cancelJobWarning')}
              </Text>
            </View>

            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <TouchableOpacity
                onPress={closeCancelModal}
                disabled={cancelProcessing}
                style={{
                  flex: 1,
                  marginRight: 8,
                  backgroundColor: "#e5e7eb",
                  paddingVertical: 14,
                  borderRadius: 12,
                  justifyContent: "center",
                  alignItems: "center",
                }}
              >
                <Text style={{ color: "#374151", fontWeight: "700" }}>{t('close') || "Close"}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={submitJobCancellation}
                disabled={cancelProcessing}
                style={{
                  flex: 1,
                  backgroundColor: cancelReason ? "#dc2626" : "#fca5a5",
                  paddingVertical: 14,
                  borderRadius: 12,
                  justifyContent: "center",
                  alignItems: "center",
                  opacity: cancelProcessing ? 0.8 : 1,
                }}
              >
                <Text style={{ color: "#fff", fontWeight: "700" }}>
                  {cancelProcessing ? t('processing') : t('confirmCancel')}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Payment Received Modal */}
      <Modal
        visible={paymentModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPaymentModalVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.6)", justifyContent: "center", alignItems: "center" }}>
          <LinearGradient
            colors={["#2ecc71", "#27ae60"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
              width: "85%",
              borderRadius: 16,
              padding: 24,
              alignItems: "center",
              shadowColor: "#2ecc71",
              shadowOffset: { width: 0, height: 10 },
              shadowOpacity: 0.4,
              shadowRadius: 16,
              elevation: 12,
            }}
          >
            {/* Celebration Icon */}
            <View style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: "rgba(255, 255, 255, 0.3)",
              justifyContent: "center",
              alignItems: "center",
              marginBottom: 16,
            }}>
              <MaterialIcons name="check-circle" size={50} color="#FFF" />
            </View>

            {/* Title */}
            <Text style={{
              fontSize: 24,
              fontWeight: "900",
              color: "#FFF",
              marginBottom: 8,
              textAlign: "center",
            }}>
              {t('paymentReceivedTitle')}
            </Text>

            {/* Subtitle */}
            <Text style={{
              fontSize: 14,
              color: "rgba(255, 255, 255, 0.9)",
              marginBottom: 20,
              textAlign: "center",
              fontWeight: "600",
            }}>
              {t('paymentProcessedSuccessfully')}
            </Text>

            {/* Job Details Card */}
            <View style={{
              width: "100%",
              backgroundColor: "rgba(255, 255, 255, 0.15)",
              borderRadius: 12,
              padding: 14,
              marginBottom: 20,
              borderLeftWidth: 4,
              borderLeftColor: "#FFF",
            }}>
              <View style={{ marginBottom: 10 }}>
                <Text style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.8)", fontWeight: "600" }}>
                  {t('jobTitle')}
                </Text>
                <Text style={{ fontSize: 15, fontWeight: "800", color: "#FFF", marginTop: 2 }}>
                  {paymentJobData?.title}
                </Text>
              </View>

              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View>
                  <Text style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.8)", fontWeight: "600" }}>
                    {t('amount')}
                  </Text>
                  <Text style={{ fontSize: 18, fontWeight: "900", color: "#FFF", marginTop: 2 }}>
                    ₹{paymentJobData?.amount}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.8)", fontWeight: "600" }}>
                    {t('fromLabel')}
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFF", marginTop: 2 }}>
                    {paymentJobData?.contractor}
                  </Text>
                </View>
              </View>
            </View>

            {/* Action Buttons */}
            <View style={{ width: "100%", flexDirection: "row", gap: 10 }}>
              <TouchableOpacity
                onPress={() => setPaymentModalVisible(false)}
                style={{
                  flex: 1,
                  backgroundColor: "rgba(255, 255, 255, 0.25)",
                  paddingVertical: 12,
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: "#FFF",
                }}
              >
                <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "700", textAlign: "center" }}>
                  {t('okay')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  setPaymentModalVisible(false);
                  // Navigate to wallet tab
                  router.push('/home/worker?tab=wallet' as any);
                }}
                style={{
                  flex: 1,
                  backgroundColor: "rgba(26, 47, 77, 0.9)",
                  paddingVertical: 12,
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: "#FFF",
                }}
              >
                <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "700", textAlign: "center" }}>
                  Deposit to Wallet
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => {
                  setPaymentModalVisible(false);
                  setPaymentSupportModalVisible(true);
                }}
                style={{
                  flex: 1,
                  backgroundColor: "rgba(231, 76, 60, 0.9)",
                  paddingVertical: 12,
                  borderRadius: 10,
                  borderWidth: 1.5,
                  borderColor: "#FFF",
                }}
              >
                <Text style={{ color: "#FFF", fontSize: 14, fontWeight: "700", textAlign: "center" }}>
                  {t('didntReceiveMoney')}
                </Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </View>
      </Modal>

      {/* Payment Support Modal */}
      <Modal
        visible={paymentSupportModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setPaymentSupportModalVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0, 0, 0, 0.5)", justifyContent: "center", alignItems: "center" }}>
          <View style={{ backgroundColor: "#fff", width: "82%", borderRadius: 14, padding: 20, alignItems: "center" }}>
            <MaterialIcons name="support-agent" size={40} color="#2ecc71" />
            <Text style={{ fontSize: 18, fontWeight: "800", color: "#1f2937", marginTop: 10, marginBottom: 8 }}>
              {t('supportRequestSent')}
            </Text>
            <Text style={{ fontSize: 14, color: "#4b5563", textAlign: "center", marginBottom: 16 }}>
              {t('supportWillReachSoon')}
            </Text>
            <TouchableOpacity
              onPress={() => setPaymentSupportModalVisible(false)}
              style={{ backgroundColor: "#2ecc71", paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8 }}
            >
              <Text style={{ color: "#fff", fontWeight: "700" }}>{t('ok')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Job Location Map Modal */}
      {selectedJobForMap && (
        <JobLocationMap
          visible={mapModalVisible}
          onClose={() => {
            setMapModalVisible(false);
            setSelectedJobForMap(null);
          }}
          jobTitle={selectedJobForMap.title}
          jobLat={selectedJobForMap.lat}
          jobLon={selectedJobForMap.lon}
          contractorName={selectedJobForMap.contractorName}
        />
      )}

      {/* Contractor Rating Modal */}
      <Modal
        visible={contractorRatingModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setContractorRatingModalVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "center", alignItems: "center" }}>
          <View style={{ width: "88%", backgroundColor: "#fff", borderRadius: 14, padding: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 6 }}>
              {t('rateContractor')}
            </Text>
            <Text style={{ fontSize: 13, color: "#6b7280", marginBottom: 12 }}>
              {selectedJobForContractorRating?.contractorName || t('contractor')} • {selectedJobForContractorRating?.title || ""}
            </Text>

            <View style={{ flexDirection: "row", justifyContent: "center", marginBottom: 14 }}>
              {[1, 2, 3, 4, 5].map((star) => (
                <TouchableOpacity key={star} onPress={() => setContractorRatingStars(star)}>
                  <Text style={{ fontSize: 30, marginHorizontal: 3 }}>
                    {star <= contractorRatingStars ? "⭐" : "☆"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TextInput
              style={{
                borderWidth: 1,
                borderColor: "#d1d5db",
                borderRadius: 10,
                paddingHorizontal: 12,
                paddingVertical: 10,
                minHeight: 72,
                textAlignVertical: "top",
                marginBottom: 14,
              }}
              placeholder={t('feedbackOptional')}
              value={contractorRatingFeedback}
              onChangeText={setContractorRatingFeedback}
              multiline
            />

            <View style={{ flexDirection: "row", gap: 10 }}>
              <TouchableOpacity
                style={{
                  flex: 1,
                  height: 42,
                  borderRadius: 10,
                  backgroundColor: "#e5e7eb",
                  justifyContent: "center",
                  alignItems: "center",
                }}
                onPress={() => setContractorRatingModalVisible(false)}
                disabled={submittingContractorRating}
              >
                <Text style={{ color: "#111827", fontWeight: "700" }}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{
                  flex: 1,
                  height: 42,
                  borderRadius: 10,
                  backgroundColor: "#1d4ed8",
                  justifyContent: "center",
                  alignItems: "center",
                  opacity: submittingContractorRating ? 0.8 : 1,
                }}
                onPress={submitContractorRating}
                disabled={submittingContractorRating}
              >
                {submittingContractorRating ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={{ color: "#fff", fontWeight: "700" }}>{t('submit')}</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
