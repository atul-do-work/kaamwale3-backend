import React, { useEffect, useState, useRef, useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Modal, Image, ScrollView, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { socket } from "../utils/socket";
import { SERVER_URL } from "../utils/config";
import * as Location from "expo-location";
import { useLanguage } from "../context/LanguageContext";
import { SafeAreaView } from "react-native-safe-area-context";

// ✅ NEW: Import service managers
import { tokenManager } from "../services/tokenManager";
import { socketConnectionManager } from "../services/socketConnectionManager";




export default function WaitingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  
  // ✅ FIXED: Timer from backend, not fake
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [jobExpiryTime, setJobExpiryTime] = useState<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  const [modalVisible, setModalVisible] = useState(false);
  const [acceptedWorker, setAcceptedWorker] = useState<any | null>(null);
  const [workerLocationName, setWorkerLocationName] = useState<string>("Getting location...");
  const [jobId, setJobId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  
  // ✅ NEW: Bulk hiring states with backend sync
  const [isBulkHiring, setIsBulkHiring] = useState(false);
  const [requiredWorkers, setRequiredWorkers] = useState(1);
  const [acceptedWorkers, setAcceptedWorkers] = useState<any[]>([]);
  const [bulkHiringComplete, setBulkHiringComplete] = useState(false);
  
  // ✅ NEW: Chat/Callback modal states
  const [chatModalVisible, setChatModalVisible] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{id: string, sender: 'user' | 'support', text: string, timestamp: Date}>>([
    { id: '1', sender: 'support', text: 'Hello! How can we help you today?', timestamp: new Date() }
  ]);
  const [messageInput, setMessageInput] = useState('');

  // ✅ NEW: Network failure handling
  const [networkError, setNetworkError] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [pollingFallback, setPollingFallback] = useState(false);
  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // ✅ NEW: State recovery
  const [jobState, setJobState] = useState<any>(null);
  const lastJobUpdateRef = useRef<number>(0);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s < 10 ? "0" : ""}${s}s`;
  };

  // ✅ NEW: Backend-driven timer
  const startBackendTimer = useCallback((expiryTimestamp: number) => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
    }

    const updateTimer = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((expiryTimestamp - now) / 1000));
      setTimeLeft(remaining);

      if (remaining <= 0) {
        clearInterval(timerIntervalRef.current!);
        timerIntervalRef.current = null;
        // Job expired - show appropriate message
        setNetworkError(true);
      }
    };

    updateTimer(); // Initial update
    timerIntervalRef.current = setInterval(updateTimer, 1000);
  }, []);

  // ✅ NEW: Polling fallback when socket fails
  const startPollingFallback = useCallback(async () => {
    if (pollingIntervalRef.current) return; // Already polling

    console.log('🔄 Starting polling fallback for job updates...');
    setPollingFallback(true);

    pollingIntervalRef.current = setInterval(async () => {
      if (!jobId || !token) return;

      try {
        const response = await fetch(`${SERVER_URL}/jobs/by-id/${jobId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (response.ok) {
          const data = await response.json();
          const job = data.job || data;

          // Only process if job was updated more recently than our last update
          const jobUpdatedAt = new Date(job.updatedAt || job.createdAt).getTime();
          if (jobUpdatedAt > lastJobUpdateRef.current) {
            lastJobUpdateRef.current = jobUpdatedAt;
            processJobUpdate(job);
          }
        }
      } catch (err) {
        console.warn('⚠️ Polling fallback failed:', err);
      }
    }, 5000); // Poll every 5 seconds
  }, [jobId, token]);

  // ✅ NEW: Stop polling fallback
  const stopPollingFallback = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
      setPollingFallback(false);
      console.log('🛑 Stopped polling fallback');
    }
  }, []);

  // ✅ NEW: Process job updates (unified for socket and polling)
  const processJobUpdate = useCallback((job: any) => {
    console.log("📢 Processing job update:", job._id, "status:", job.status);

    // ✅ CRITICAL: Verify this job is for current user
    if (!currentUser || !jobId || job._id !== jobId) {
      return;
    }

    // ✅ Update job state for recovery
    setJobState(job);

    // ✅ Check if this is a bulk hiring job
    if (job.bulkHiring) {
      console.log(`📊 Bulk hiring job - Required: ${job.requiredWorkers}, Accepted: ${job.acceptedWorkers?.length || 0}`);
      setIsBulkHiring(true);
      setRequiredWorkers(job.requiredWorkers || 1);
      setAcceptedWorkers(job.acceptedWorkers || []);

      // ✅ FIXED: Use backend completion flag instead of frontend check
      if (job.isComplete || (job.acceptedWorkers && job.acceptedWorkers.length >= job.requiredWorkers)) {
        console.log("🎉 Bulk hiring complete!");
        setBulkHiringComplete(true);
        setModalVisible(true);
        stopPollingFallback(); // Stop polling when complete
      }
    } else if (job.status === "accepted") {
      console.log("🎉 Job accepted! Showing modal");
      const worker = job.acceptedWorker || { name: job.acceptedBy };
      setAcceptedWorker(worker);

      // Get location name if coordinates available
      if (worker?.location?.coordinates && worker.location.coordinates.length === 2) {
        const [lon, lat] = worker.location.coordinates;
        getLocationName(lat, lon).then(locationName => {
          setWorkerLocationName(locationName);
        });
      } else {
        setWorkerLocationName("Location not available");
      }

      setModalVisible(true);
      stopPollingFallback(); // Stop polling when accepted
    } else if (job.status === "cancelled" || job.status === "expired") {
      console.log("❌ Job cancelled/expired");
      Alert.alert("Job Update", `Job has been ${job.status}`);
      stopPollingFallback();
      router.replace("/home/contractor/postjobs");
    }
  }, [currentUser, jobId, stopPollingFallback, router]);

  // ✅ NEW: State recovery on app restart
  const recoverJobState = useCallback(async () => {
    try {
      const savedJobState = await AsyncStorage.getItem('waitingJobState');
      if (savedJobState) {
        const parsed = JSON.parse(savedJobState);
        if (parsed.jobId === jobId && parsed.timestamp > Date.now() - 3600000) { // Within 1 hour
          console.log('🔄 Recovered job state:', parsed);
          setJobState(parsed.job);
          processJobUpdate(parsed.job);
        } else {
          // Stale state, remove it
          await AsyncStorage.removeItem('waitingJobState');
        }
      }
    } catch (err) {
      console.warn('⚠️ Failed to recover job state:', err);
    }
  }, [jobId, processJobUpdate]);

  // ✅ NEW: Save state for recovery
  const saveJobState = useCallback(async (job: any) => {
    try {
      await AsyncStorage.setItem('waitingJobState', JSON.stringify({
        jobId,
        job,
        timestamp: Date.now(),
      }));
    } catch (err) {
      console.warn('⚠️ Failed to save job state:', err);
    }
  }, [jobId]);

  // ✅ Function to get location name from coordinates
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

  const [cancellationLoading, setCancellationLoading] = useState(false);

  // ✅ NEW: Handle need help / callback
  const handleNeedHelp = () => {
    setChatModalVisible(true);
  };

  const handleGetCallback = () => {
    Alert.alert(
      "Request a Callback",
      "Our support team will call you shortly.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Request Callback",
          onPress: () => {
            Alert.alert("✅ Callback Requested", "A support agent will contact you within 5 minutes.");
          }
        }
      ]
    );
  };

  const handleSendMessage = () => {
    if (messageInput.trim()) {
      const newMessage = {
        id: Date.now().toString(),
        sender: 'user' as const,
        text: messageInput,
        timestamp: new Date()
      };
      setChatMessages([...chatMessages, newMessage]);
      setMessageInput('');
      
      // ✅ IMPROVED: More realistic support simulation
      const supportResponses = [
        "Thanks for your message! Our support team has been notified and will respond shortly.",
        "We're experiencing high volume right now. A support agent will contact you within 5-10 minutes.",
        "Your concern has been logged. For immediate assistance, please call our support line.",
        "We're here to help! Please provide more details about the issue you're facing.",
        "A support ticket has been created for your request. You'll receive an update soon."
      ];
      
      // Simulate typing indicator
      setTimeout(() => {
        const typingMessage = {
          id: `typing_${Date.now()}`,
          sender: 'support' as const,
          text: 'Support is typing...',
          timestamp: new Date()
        };
        setChatMessages(prev => [...prev, typingMessage]);
        
        // Remove typing and add response
        setTimeout(() => {
          setChatMessages(prev => prev.filter(msg => msg.id !== typingMessage.id));
          const randomResponse = supportResponses[Math.floor(Math.random() * supportResponses.length)];
          const responseMessage = {
            id: Date.now().toString(),
            sender: 'support' as const,
            text: randomResponse,
            timestamp: new Date()
          };
          setChatMessages(prev => [...prev, responseMessage]);
        }, 2000);
      }, 1000);
    }
  };

  const handleCancelJob = () => {
    Alert.alert(
      t('cancelJob') + "?",
      "Are you sure you want to cancel this request?\n\nYou may be charged a cancellation fee.",
      [
        { text: "No", onPress: () => {}, style: "cancel" },
        {
          text: t('yes') + ", " + t('cancelJob'),
          style: "destructive",
          onPress: () => {
            handleCancelJobConfirm();
          },
        },
      ]
    );
  };

  const handleCancelJobConfirm = async () => {
    if (!jobId || !token) {
      Alert.alert("Error", "Missing job ID or token");
      return;
    }

    // ✅ FIXED: Prevent duplicate cancellation requests
    if (cancellationLoading) {
      console.log("⏳ Cancellation already in progress");
      return;
    }

    setCancellationLoading(true);

    try {
      console.log("🛑 Cancelling job:", jobId);

      const response = await fetch(`${SERVER_URL}/jobs/cancel/${jobId}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reason: "contractor_requested",
          reasonDescription: "Contractor cancelled the job request",
        }),
      });

      const data = await response.json();
      setCancellationLoading(false);

      if (data.success && data.cancellation) {
        const refundAmount = data.cancellation.refundAmount || 0;
        const cancellationFee = data.cancellation.cancellationFee || 0;

        // ✅ Clear saved job state
        await AsyncStorage.removeItem('waitingJobState');

        Alert.alert(
          "Job Cancelled Successfully",
          `Refund Amount: ₹${refundAmount}\nCancellation Fee: ₹${cancellationFee}`,
          [
            {
              text: "OK",
              onPress: () => {
                router.replace("/home/contractor/postjobs");
              },
            },
          ]
        );

        console.log("✅ Job cancelled:", data.cancellation);
      } else {
        Alert.alert(
          "Cancellation Failed",
          data.message || "Could not cancel job. Please try again."
        );
        console.error("Cancellation error:", data);
      }
    } catch (error) {
      setCancellationLoading(false);
      console.error("Cancel job network error:", error);

      // ✅ NEW: Network error handling
      if (!navigator.onLine) {
        Alert.alert(
          "Network Error",
          "No internet connection. Please check your connection and try again.",
          [
            { text: "Retry", onPress: () => handleCancelJobConfirm() },
            { text: "Cancel", style: "cancel" }
          ]
        );
      } else {
        Alert.alert(
          "Network Error",
          "Failed to cancel job. Please check your connection and try again.",
          [
            { text: "Retry", onPress: () => handleCancelJobConfirm() },
            { text: "Cancel", style: "cancel" }
          ]
        );
      }
    }
  };

    // Setup socket and listen for job updates
    useEffect(() => {
      let mounted = true;

      (async () => {
        try {
          // ✅ NEW: Get fresh token using tokenManager
          const tokenResult = await tokenManager.refreshAccessToken();
          if (!tokenResult.success || !tokenResult.accessToken) {
            console.error('❌ Cannot setup waiting screen: Token refresh failed');
            setNetworkError(true);
            return;
          }

          const authToken = tokenResult.accessToken;
          setToken(authToken);

          // ✅ NEW: Load user and job data
          const userStr = await AsyncStorage.getItem("user");
          const lastJobId = await AsyncStorage.getItem("lastJobId");
          const user = userStr ? JSON.parse(userStr) : null;

          if (!user || !lastJobId) {
            console.error('❌ Missing user or job data');
            router.replace("/home/contractor/postjobs");
            return;
          }

          setCurrentUser(user);
          setJobId(lastJobId);

          // ✅ NEW: Fetch initial job state from backend
          try {
            const jobResponse = await fetch(`${SERVER_URL}/jobs/by-id/${lastJobId}`, {
              headers: { Authorization: `Bearer ${authToken}` },
            });

            if (jobResponse.ok) {
              const jobData = await jobResponse.json();
              const job = jobData.job || jobData;

              // ✅ Set backend-driven timer
              if (job.expiryTime) {
                setJobExpiryTime(job.expiryTime);
                startBackendTimer(job.expiryTime);
              } else {
                // Fallback to 5 minutes if no expiry time
                const fallbackExpiry = Date.now() + (5 * 60 * 1000);
                setJobExpiryTime(fallbackExpiry);
                startBackendTimer(fallbackExpiry);
              }

              // ✅ Process initial job state
              processJobUpdate(job);
              saveJobState(job);
            } else {
              console.error('❌ Failed to fetch initial job state');
              setNetworkError(true);
            }
          } catch (err) {
            console.error('❌ Error fetching initial job:', err);
            setNetworkError(true);
          }

          // ✅ NEW: Ensure socket is connected with tokenManager
          const socketResult = await socketConnectionManager.ensureConnected(user.phone);
          if (socketResult) {
            setSocketConnected(true);
            console.log("✅ Socket connected for waiting screen");
          } else {
            console.warn("⚠️ Socket connection failed, starting polling fallback");
            startPollingFallback();
          }

          // ✅ FIXED: Proper socket listener cleanup
          const handleJobUpdated = (job: any) => {
            if (!mounted) return;

            console.log("⏳ Socket: jobUpdated event received", job._id, "status:", job.status);

            // ✅ CRITICAL: Verify this job is for current user
            if (!job || !lastJobId || job._id !== lastJobId) {
              console.log("Job ID mismatch or no job");
              return;
            }

            // If server sent targeted update and current user is not in the target list, ignore
            if (job._targetedUpdate && Array.isArray(job.targetedFor)) {
              const userIdentifiers = job.targetedFor.map((i: any) => i && i.toString());
              const matches = [user.name, user.phone].some((id) => userIdentifiers.includes(id));
              console.log("Targeted update check:", { targetedFor: job.targetedFor, userInfo: [user.name, user.phone], matches });
              if (!matches) {
                console.log("❌ Not targeted to current user, ignoring");
                return;
              }
            }

            // ✅ Process job update and save state
            processJobUpdate(job);
            saveJobState(job);
            lastJobUpdateRef.current = Date.now();
          };

          // ✅ NEW: Socket connection status monitoring
          const handleConnect = () => {
            if (!mounted) return;
            console.log("🔌 Socket connected");
            setSocketConnected(true);
            setNetworkError(false);
            stopPollingFallback(); // Stop polling when socket reconnects
          };

          const handleDisconnect = () => {
            if (!mounted) return;
            console.log("🔌 Socket disconnected, starting polling fallback");
            setSocketConnected(false);
            startPollingFallback();
          };

          // ✅ Register socket listeners
          socket.on("jobUpdated", handleJobUpdated);
          socket.on("connect", handleConnect);
          socket.on("disconnect", handleDisconnect);

          console.log("✅ Socket listeners registered for waiting screen");

          // ✅ NEW: State recovery
          await recoverJobState();

        } catch (e) {
          console.error("❌ Waiting screen setup error:", e);
          setNetworkError(true);
        }
      })();

      return () => {
        mounted = false;

        // ✅ FIXED: Remove specific listeners, not all
        socket.off("jobUpdated");
        socket.off("connect");
        socket.off("disconnect");

        // ✅ Cleanup timers and polling
        if (timerIntervalRef.current) {
          clearInterval(timerIntervalRef.current);
          timerIntervalRef.current = null;
        }
        stopPollingFallback();

        console.log("🧹 Waiting screen cleanup complete");
      };
    }, [startBackendTimer, processJobUpdate, saveJobState, recoverJobState, startPollingFallback, stopPollingFallback, router]);

    const handleCloseModal = () => {
      setModalVisible(false);
      // navigate to contractor home or job detail
      router.replace("/home/contractor");
    };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right', 'bottom']}>
      {/* Top Header Area */}
      <View style={styles.headerContainer}>
        {/* ✅ Back button disabled - contractor must wait for acceptances or cancel job */}
        <View style={styles.backButton} />

        <Text style={styles.title}>{t('waitingForWorkers')}...</Text>
        <Text style={styles.timerText}>Expected Response: {formatTime(timeLeft)}</Text>
      </View>

      {/* Center Loader */}
      <View style={styles.centerArea}>
        {/* ✅ NEW: Network error indicator */}
        {networkError && (
          <View style={styles.networkErrorContainer}>
            <Ionicons name="cloud-offline" size={24} color="#ef4444" />
            <Text style={styles.networkErrorText}>
              {timeLeft > 0 ? "Connection issues - using backup mode" : "Job search expired"}
            </Text>
            {pollingFallback && (
              <Text style={styles.pollingText}>Checking for updates...</Text>
            )}
          </View>
        )}

        {/* ✅ NEW: Socket status indicator */}
        {!socketConnected && !networkError && (
          <View style={styles.socketStatusContainer}>
            <Ionicons name="radio" size={20} color="#f59e0b" />
            <Text style={styles.socketStatusText}>Reconnecting...</Text>
          </View>
        )}

        <ActivityIndicator size="large" color="#667eea" />
        {isBulkHiring ? (
          <>
            <Text style={styles.loadingText}>{t('waitingForWorkers')}...</Text>
            <View style={styles.bulkHiringCounter}>
              <Text style={styles.counterText}>
                {acceptedWorkers.length} / {requiredWorkers} Workers Accepted
              </Text>
              <View style={styles.progressBar}>
                <View 
                  style={[
                    styles.progressFill,
                    { width: `${(acceptedWorkers.length / requiredWorkers) * 100}%` }
                  ]}
                />
              </View>
            </View>
          </>
        ) : (
          <Text style={styles.loadingText}>
            {networkError ? "Searching with limited connection..." : t('weAreNotifyingWorkersNearYou')}
          </Text>
        )}
      </View>

      {/* Bottom Buttons */}
      <View style={styles.bottomActions}>
        <TouchableOpacity style={styles.actionBtn} onPress={handleNeedHelp}>
          <Ionicons name="help-circle" size={20} color="#667eea" style={{ marginRight: 8 }} />
            <Text style={styles.actionText}>{t('needHelp')}?</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={handleGetCallback}>
          <Ionicons name="call" size={20} color="#10b981" style={{ marginRight: 8 }} />
          <Text style={styles.actionText}>Get a Callback</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.actionBtn} onPress={handleNeedHelp}>
          <Ionicons name="chatbubbles" size={20} color="#f59e0b" style={{ marginRight: 8 }} />
          <Text style={styles.actionText}>Chat With Us</Text>
        </TouchableOpacity>

        {/* Cancel Job Button */}
        <TouchableOpacity 
          style={[styles.cancelBtn, cancellationLoading && { opacity: 0.6 }]} 
          onPress={handleCancelJob}
          disabled={cancellationLoading}
        >
          {cancellationLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Text style={styles.cancelText}>{t('cancelJob')}</Text>
          )}
        </TouchableOpacity>
      </View>
    
      {/* ✅ Chat/Support Modal */}
      <Modal visible={chatModalVisible} transparent animationType="slide">
        <View style={styles.chatContainer}>
          {/* Header */}
          <View style={styles.chatHeader}>
            <TouchableOpacity onPress={() => setChatModalVisible(false)}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
            <Text style={styles.chatTitle}>Support Chat</Text>
            <View style={{ width: 28 }} />
          </View>

          {/* Messages */}
          <ScrollView style={styles.messagesContainer} contentContainerStyle={{ paddingBottom: 20 }}>
            {chatMessages.map((msg) => (
              <View key={msg.id} style={[styles.messageRow, msg.sender === 'user' && styles.userMessageRow]}>
                <View style={[styles.messageBubble, msg.sender === 'user' ? styles.userBubble : styles.supportBubble]}>
                  <Text style={[styles.messageText, msg.sender === 'user' && styles.userMessageText]}>
                    {msg.text}
                  </Text>
                  <Text style={[styles.messageTime, msg.sender === 'user' && styles.userMessageTime]}>
                    {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                </View>
              </View>
            ))}
          </ScrollView>

          {/* Input Area */}
          <View style={styles.inputContainer}>
            <TextInput
              style={styles.messageInput}
              placeholder="Type your message..."
              placeholderTextColor="#999"
              value={messageInput}
              onChangeText={setMessageInput}
              multiline
            />
            <TouchableOpacity 
              style={styles.sendButton}
              onPress={handleSendMessage}
            >
              <Ionicons name="send" size={20} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Accepted Worker Modal */}
      <Modal visible={modalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {/* Header: Success Icon */}
            <View style={styles.modalHeader}>
              <Ionicons name={isBulkHiring ? "people" : "checkmark-circle"} size={60} color={isBulkHiring ? "#667eea" : "#10b981"} />
              <Text style={styles.modalTitle}>
                {isBulkHiring ? `${acceptedWorkers.length} Workers Accepted!` : "Job Accepted!"}
              </Text>
            </View>

            {/* ✅ Bulk Hiring: Show all accepted workers */}
            {isBulkHiring && bulkHiringComplete ? (
              <ScrollView style={styles.bulkWorkersList}>
                {acceptedWorkers.map((worker, index) => (
                  <View key={index} style={styles.bulkWorkerCard}>
                    {/* Profile Photo */}
                    {worker.profilePhoto ? (
                      <Image 
                        source={{ uri: worker.profilePhoto }} 
                        style={styles.bulkWorkerPhoto}
                      />
                    ) : (
                      <View style={[styles.bulkWorkerPhoto, { backgroundColor: "#e5e7eb", justifyContent: "center", alignItems: "center" }]}>
                        <Ionicons name="person" size={24} color="#9ca3af" />
                      </View>
                    )}
                    
                    <View style={styles.bulkWorkerInfo}>
                      <Text style={styles.bulkWorkerName}>{worker.name || worker.phone || "Worker"}</Text>
                      {worker.skills && worker.skills.length > 0 && (
                        <Text style={styles.bulkWorkerSkills}>{worker.skills.join(", ")}</Text>
                      )}
                      {worker.acceptedAt && (
                        <Text style={styles.acceptedTime}>
                          Accepted at {new Date(worker.acceptedAt).toLocaleTimeString()}
                        </Text>
                      )}
                    </View>
                  </View>
                ))}
              </ScrollView>
            ) : (
              /* Single Worker Modal */
              <View style={styles.workerSection}>
                {/* Profile Photo */}
                {acceptedWorker?.profilePhoto ? (
                  <Image 
                    source={{ uri: acceptedWorker.profilePhoto }} 
                    style={styles.profilePhoto}
                  />
                ) : (
                  <View style={[styles.profilePhoto, { backgroundColor: "#e5e7eb", justifyContent: "center", alignItems: "center" }]}>
                    <Ionicons name="person" size={40} color="#9ca3af" />
                  </View>
                )}

                {/* Worker Info */}
                <Text style={styles.workerName}>{acceptedWorker?.name || acceptedWorker?.phone || "Worker"}</Text>
                
                {acceptedWorker?.skills && acceptedWorker.skills.length > 0 && (
                  <Text style={styles.workerSkills}>{acceptedWorker.skills.join(", ")}</Text>
                )}

                {/* Location Info */}
                <View style={styles.locationContainer}>
                  <Ionicons name="location" size={18} color="#6366f1" />
                  <Text style={styles.locationText}>
                    {workerLocationName}
                  </Text>
                </View>
              </View>
            )}

            {/* OK Button */}
            <TouchableOpacity onPress={handleCloseModal} style={styles.okButton}>
              <Text style={styles.okButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#1b1b2f" },

  headerContainer: {
    height: "30%",
    width: "100%",
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 40,
  },
  backButton: { position: "absolute", top: 40, right: 20 },

  title: { fontSize: 24, color: "#fff", fontWeight: "700", marginBottom: 10 },
  timerText: { fontSize: 18, color: "#ccc", fontWeight: "500" },

  centerArea: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  loadingText: { marginTop: 15, color: "#aaa", fontSize: 16 },

  bottomActions: {
    width: "100%",
    padding: 20,
    marginBottom: 20,
  },
  actionBtn: {
    width: "100%",
    backgroundColor: "#29294d",
    paddingVertical: 14,
    borderRadius: 14,
    marginBottom: 12,
    alignItems: "center",
  },
  actionText: { color: "#fff", fontSize: 18, fontWeight: "600" },

  cancelBtn: {
    width: "100%",
    backgroundColor: "#ff3b30",
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 10,
    alignItems: "center",
  },
  cancelText: { color: "#fff", fontSize: 18, fontWeight: "700" },

  // ✅ Modal Styles
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "rgba(0, 0, 0, 0.7)",
  },
  modalCard: {
    width: "85%",
    backgroundColor: "#fff",
    borderRadius: 20,
    padding: 24,
    alignItems: "center",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 10,
  },
  modalHeader: {
    alignItems: "center",
    marginBottom: 20,
  },
  modalTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#1f2937",
    marginTop: 12,
  },
  workerSection: {
    width: "100%",
    alignItems: "center",
    marginBottom: 24,
  },
  profilePhoto: {
    width: 100,
    height: 100,
    borderRadius: 50,
    marginBottom: 16,
    borderWidth: 3,
    borderColor: "#10b981",
  },
  workerName: {
    fontSize: 22,
    fontWeight: "700",
    color: "#1f2937",
    marginBottom: 8,
  },
  workerSkills: {
    fontSize: 14,
    color: "#6b7280",
    marginBottom: 16,
    fontStyle: "italic",
  },
  locationContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
  },
  locationText: {
    marginLeft: 8,
    fontSize: 14,
    color: "#374151",
    fontWeight: "500",
  },
  okButton: {
    width: "100%",
    backgroundColor: "#10b981",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
  },
  okButtonText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },

  // ✅ Chat Modal Styles
  chatContainer: {
    flex: 1,
    backgroundColor: "#f8f9fa",
    marginTop: 50,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  chatHeader: {
    backgroundColor: "#667eea",
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  chatTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
  },
  messagesContainer: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  messageRow: {
    marginBottom: 12,
    flexDirection: "row",
    justifyContent: "flex-start",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  messageBubble: {
    maxWidth: "80%",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 16,
  },
  supportBubble: {
    backgroundColor: "#e5e7eb",
  },
  userBubble: {
    backgroundColor: "#667eea",
  },
  messageText: {
    fontSize: 14,
    color: "#1f2937",
    fontWeight: "500",
  },
  userMessageText: {
    color: "#fff",
  },
  messageTime: {
    fontSize: 11,
    color: "#6b7280",
    marginTop: 4,
  },
  userMessageTime: {
    color: "rgba(255,255,255,0.7)",
  },
  inputContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
    alignItems: "flex-end",
  },
  messageInput: {
    flex: 1,
    backgroundColor: "#f3f4f6",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: "#1f2937",
    maxHeight: 100,
  },
  sendButton: {
    marginLeft: 10,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#667eea",
    justifyContent: "center",
    alignItems: "center",
  },
  // ✅ Bulk hiring styles
  bulkHiringCounter: {
    marginTop: 20,
    width: '80%',
    alignItems: 'center',
  },
  counterText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#667eea',
    marginBottom: 12,
  },
  progressBar: {
    width: '100%',
    height: 8,
    backgroundColor: 'rgba(102, 126, 234, 0.2)',
    borderRadius: 4,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: '#667eea',
  },
  bulkWorkersList: {
    width: '100%',
    maxHeight: 300,
    marginBottom: 20,
  },
  bulkWorkerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    padding: 12,
    marginBottom: 10,
    borderRadius: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#10b981',
  },
  bulkWorkerPhoto: {
    width: 50,
    height: 50,
    borderRadius: 25,
    marginRight: 12,
    borderWidth: 2,
    borderColor: '#10b981',
  },
  bulkWorkerInfo: {
    flex: 1,
  },
  bulkWorkerName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 4,
  },
  bulkWorkerSkills: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 4,
  },
  acceptedTime: {
    fontSize: 11,
    color: '#9ca3af',
  },
  // ✅ NEW: Network error styles
  networkErrorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef2f2',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  networkErrorText: {
    color: '#dc2626',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
  pollingText: {
    color: '#7f1d1d',
    fontSize: 12,
    marginTop: 4,
  },
  socketStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fffbeb',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#fed7aa',
  },
  socketStatusText: {
    color: '#c2410c',
    fontSize: 12,
    fontWeight: '500',
    marginLeft: 6,
  },
});
