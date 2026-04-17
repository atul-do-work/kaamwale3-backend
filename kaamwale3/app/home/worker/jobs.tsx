import React, { useEffect, useState, useRef } from "react";
import { View, Text, FlatList, Alert, Image, TouchableOpacity, Modal, RefreshControl, TextInput, ActivityIndicator, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { MaterialIcons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { socket } from "../../../utils/socket";
import { API_BASE } from "../../../utils/config";
import styles from "../../../styles/WorkerJobsStyles";
import JobLocationMap from "../../../components/JobLocationMap";
import { useLanguage } from "../../../context/LanguageContext";
import { useJobStatus } from "../../../hooks/useJobStatus"; // ✅ Real-time job updates
import { useAuth } from "../../../context/AuthContext"; // ✅ For auth context

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

const getWeekWindow = () => {
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  const day = weekStart.getDay(); // 0=Sun
  const diffToMonday = (day + 6) % 7;
  weekStart.setDate(weekStart.getDate() - diffToMonday);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  return { weekStart, weekEnd };
};

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

export default function Jobs(): React.ReactElement {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken } = useAuth();
  const [workerName, setWorkerName] = useState<string>("Test Worker");
  
  // ✅ Real-time job status with smart caching
  const { jobs: hookJobs, loading, error: jobError, refresh: refreshJobs } = useJobStatus();
  const [acceptedJobs, setAcceptedJobs] = useState<Job[]>([]);

  useEffect(() => {
    setAcceptedJobs(Array.isArray(hookJobs) ? hookJobs : []);
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

  // Load worker name + token from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const storedToken = (await AsyncStorage.getItem("accessToken")) || (await AsyncStorage.getItem("token"));

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
      
      // 🔐 CRITICAL: Compare with currentUserPhone (phone number) not workerName (name string)
      // job.acceptedBy is a phone number, so we must compare with currentUserPhone
      if (!currentUserPhone || job.acceptedBy !== currentUserPhone) {
        console.log(`⚠️ Job ${job._id} acceptedBy (${job.acceptedBy}) doesn't match current user (${currentUserPhone}), ignoring`);
        return;
      }

      const location = job.location || (await getAddressFromCoords(job.lat, job.lon));
      
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
    { key: "worker_unavailable", label: "Worker unavailable" },
    { key: "location_changed", label: "Location changed" },
    { key: "safety_concern", label: "Safety concern" },
    { key: "contractor_request", label: "Contractor requested cancellation" },
    { key: "technical_issue", label: "Technical issue" },
    { key: "other", label: "Other reason" },
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
      return Alert.alert("Error", "Please select a cancellation reason.");
    }
    if (!token) {
      return Alert.alert("Error", "You are not authenticated.");
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
        return Alert.alert("Error", payload?.message || "Cancellation failed. Please try again.");
      }

      setAcceptedJobs((prev) => prev.filter((job) => job._id !== selectedCancelJob._id));
      Alert.alert("Success", payload?.message || "Job cancelled. A new candidate will be notified.");
      closeCancelModal();
    } catch (err) {
      console.error("Cancel job error:", err);
      Alert.alert("Error", "Cancellation failed. Please try again.");
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
    return (
      <View style={{ marginHorizontal: 16, marginBottom: 16 }}>
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
          {!isPaid(job, currentUserPhone) && (
            <View
              style={{
                position: "absolute",
                right: 10,
                top: 10,
                zIndex: 5,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
              }}
            >
              <TouchableOpacity
                onPress={() => dialNumber(job.contractorPhone || "")}
                disabled={!job.contractorPhone}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: "#22c55e",
                  justifyContent: "center",
                  alignItems: "center",
                  opacity: job.contractorPhone ? 1 : 0.4,
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.25,
                  shadowRadius: 4,
                  elevation: 4,
                }}
              >
                <MaterialIcons name="phone" size={18} color="#fff" />
              </TouchableOpacity>

              <TouchableOpacity
                onPress={() => showHelpOptions(job)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 18,
                  backgroundColor: "#ef4444",
                  justifyContent: "center",
                  alignItems: "center",
                  shadowColor: "#000",
                  shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.25,
                  shadowRadius: 4,
                  elevation: 4,
                }}
              >
                <MaterialIcons name="notification-important" size={20} color="#fff" />
              </TouchableOpacity>
            </View>
          )}

          {/* Top Image */}
          <View style={{ height: 180, overflow: "hidden", backgroundColor: "#EEE" }}>
            <Image
              source={jobImageUri ? { uri: jobImageUri } : require("../../../assets/oip2.jpg")}
              style={{ width: "100%", height: "100%", resizeMode: "cover" }}
            />
          </View>

          {/* Content Section */}
          <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
            {/* Contractor Name - Prominent */}
            <Text style={{ color: "#333", fontSize: 16, fontWeight: "700", marginBottom: 4 }}>
              👤 {job.contractorName}
            </Text>

            {/* Main Skill / Description */}
            {job.description && (
              <Text style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
                {job.description}
              </Text>
            )}

            {/* Expected Wages */}
            <Text style={{ color: "#2ecc71", fontSize: 18, fontWeight: "900", marginBottom: 12 }}>
              ₹{job.amount}
            </Text>

            {/* Date & Time Row */}
            <View style={{ flexDirection: "row", marginBottom: 10 }}>
              {/* Date */}
              <View style={{ flexDirection: "row", alignItems: "center", flex: 1 }}>
                <MaterialIcons name="event" size={14} color="#999" />
                <Text style={{ color: "#666", fontSize: 12, marginLeft: 6 }}>
                  {job.date && !isNaN(Date.parse(job.date))
                    ? new Date(job.date).toLocaleDateString()
                    : t('notAvailable')}
                </Text>
              </View>

              {/* Time */}
              {(job.startTime || job.endTime) && (
                <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginLeft: 10 }}>
                  <MaterialIcons name="schedule" size={14} color="#999" />
                  <Text style={{ color: "#666", fontSize: 12, marginLeft: 6 }}>
                    {job.startTime || t('notAvailable')} - {job.endTime || t('notAvailable')}
                  </Text>
                </View>
              )}
            </View>

            {/* Duration (Days) - ✅ Show job duration */}
            {job.numberOfDays && (
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                <MaterialIcons name="timer" size={14} color="#999" />
                <Text style={{ color: "#666", fontSize: 12, marginLeft: 6 }}>
                  {t('durationLabel')}: {job.numberOfDays} {job.numberOfDays === 1 ? t('day') : t('days')}
                </Text>
              </View>
            )}

            {/* Location */}
            <TouchableOpacity
              style={{ flexDirection: "row", alignItems: "flex-start", marginBottom: 12 }}
              onPress={() => {
                setSelectedJobForMap(job);
                setMapModalVisible(true);
              }}
            >
              <MaterialIcons name="location-on" size={14} color="#FF6B6B" style={{ marginTop: 1 }} />
              <Text style={{ color: "#666", fontSize: 12, marginLeft: 6, flex: 1 }}>
                {job.location}
              </Text>
            </TouchableOpacity>

            {/* Bottom Row: [Paid] Badge & Rating */}
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              {/* Paid Badge */}
              {isPaid(job, currentUserPhone) ? (
                <View style={{ 
                  flexDirection: "row", 
                  alignItems: "center",
                  backgroundColor: "#E8F5E9",
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 20,
                }}>
                  <MaterialIcons name="check-circle" size={14} color="#2ecc71" />
                  <Text style={{ color: "#2ecc71", fontSize: 12, fontWeight: "600", marginLeft: 6 }}>
                    {t('paid')}
                  </Text>
                </View>
              ) : (
                <View style={{ 
                  flexDirection: "row", 
                  alignItems: "center",
                  backgroundColor: "#FFF3E0",
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: 20,
                }}>
                  <MaterialIcons name="schedule" size={14} color="#FF9800" />
                  <Text style={{ color: "#FF9800", fontSize: 12, fontWeight: "600", marginLeft: 6 }}>
                    {t('pending')}
                  </Text>
                </View>
              )}

              {/* Rating */}
              {typeof job.rating?.stars === "number" ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <MaterialIcons
                      key={star}
                      name="star"
                      size={14}
                      color={star <= (job.rating?.stars ?? 0) ? "#FFD700" : "#DDD"}
                      style={{ marginRight: 2 }}
                    />
                  ))}
                  <Text style={{ color: "#333", fontSize: 12, fontWeight: "700", marginLeft: 8 }}>
                    {job.rating?.stars}/5
                  </Text>
                </View>
              ) : (
                <Text style={{ color: "#999", fontSize: 12 }}>{t('noRatingYet')}</Text>
              )}
            </View>

            {/* Feedback (if available) */}
            {job.rating?.feedback && (
              <View style={{ 
                backgroundColor: "#F5F5F5", 
                borderLeftWidth: 3, 
                borderLeftColor: "#FFD700", 
                paddingHorizontal: 10, 
                paddingVertical: 8, 
                borderRadius: 4,
                marginTop: 10
              }}>
                <Text style={{ color: "#666", fontSize: 12, fontStyle: "italic", lineHeight: 14 }}>
                  💬 "{job.rating.feedback}"
                </Text>
              </View>
            )}

            {isPaid(job, currentUserPhone) && (
              <View style={{ marginTop: 12 }}>
                {job.contractorRating?.stars ? (
                  <View style={{ backgroundColor: "#EEF6FF", borderRadius: 8, padding: 10 }}>
                    <Text style={{ color: "#1e3a8a", fontWeight: "700", fontSize: 12, marginBottom: 4 }}>
                      {t('yourRatingForContractor')}
                    </Text>
                    <Text style={{ color: "#1e3a8a", fontSize: 13, fontWeight: "700" }}>
                      {"⭐".repeat(job.contractorRating.stars)} ({job.contractorRating.stars}/5)
                    </Text>
                    {!!job.contractorRating.feedback && (
                      <Text style={{ color: "#334155", fontSize: 12, marginTop: 4 }}>
                        "{job.contractorRating.feedback}"
                      </Text>
                    )}
                  </View>
                ) : (
                  <TouchableOpacity
                    style={{
                      backgroundColor: "#1d4ed8",
                      height: 38,
                      borderRadius: 8,
                      justifyContent: "center",
                      alignItems: "center",
                    }}
                    onPress={() => openRateContractorModal(job)}
                  >
                    <Text style={{ color: "#fff", fontSize: 13, fontWeight: "700" }}>
                      {t('rateContractor')}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            )}

            {!isPaid(job, currentUserPhone) && (job.status === "accepted" || job.status === "in_progress") && job.acceptedBy === currentUserPhone && (
              <View style={{ marginTop: 14 }}>
                <Text style={{ color: "#b91c1c", fontSize: 12, marginBottom: 8 }}>
                  "Cancelling a job may affect your rating and can incur penalties if done after the allowed window."
                </Text>
                <TouchableOpacity
                  style={{
                    backgroundColor: "#dc2626",
                    height: 42,
                    borderRadius: 10,
                    justifyContent: "center",
                    alignItems: "center",
                  }}
                  onPress={() => openCancelModal(job)}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "700" }}>
                    "Cancel job"
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
  const { weekStart, weekEnd } = getWeekWindow();
  const weeklyJobs = acceptedJobs.filter((job) => {
    const sourceDate = job.paymentTime || job.date || job.createdAt;
    if (!sourceDate) return false;
    const d = new Date(sourceDate);
    if (Number.isNaN(d.getTime())) return false;
    return d >= weekStart && d < weekEnd;
  });

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12 }}>
        <Text style={{ fontSize: 20, fontWeight: '800', color: '#111827' }}>{t('acceptedJobs') || 'Accepted Jobs'}</Text>
        <TouchableOpacity
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          onPress={() => router.push('/GigHistory' as any)}
        >
          <MaterialIcons name="history" size={22} color="#1d4ed8" />
          <Text style={{ color: '#1d4ed8', fontWeight: '700' }}>{t('pastJobs') || 'Past Jobs'}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={previewJobs}
        keyExtractor={(item) => item._id}
        style={styles.container}
        contentContainerStyle={{ paddingVertical: 12 }}
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
        visible={cancelModalVisible}
        transparent
        animationType="slide"
        onRequestClose={closeCancelModal}
      >
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 18 }}>
          <View style={{ backgroundColor: "#fff", borderRadius: 18, padding: 18, maxHeight: "90%" }}>
            <Text style={{ fontSize: 18, fontWeight: "800", color: "#111827", marginBottom: 10 }}>
              Cancel Job
            </Text>
            <Text style={{ color: "#374151", fontSize: 13, marginBottom: 18, lineHeight: 20 }}>
              Select a reason and confirm to cancel the accepted job. This may reopen the job for other workers.
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
                placeholder="Describe why you need to cancel"
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
                Important
              </Text>
              <Text style={{ color: "#92400e", fontSize: 12, lineHeight: 18 }}>
                Worker cancellation is only allowed for accepted or in-progress jobs. Cancelling late may affect your rating and trigger penalties.
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
                  {cancelProcessing ? "Processing..." : "Confirm Cancel"}
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
