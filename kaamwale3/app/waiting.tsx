import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Modal, Image, ScrollView, TextInput } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { socket } from "../utils/socket";
import { SERVER_URL } from "../utils/config";
import * as Location from "expo-location";
import { useLanguage } from "../context/LanguageContext";

export default function WaitingScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const [timeLeft, setTimeLeft] = useState(300); // 5 min default
  const [modalVisible, setModalVisible] = useState(false);
  const [acceptedWorker, setAcceptedWorker] = useState<any | null>(null);
  const [workerLocationName, setWorkerLocationName] = useState<string>("Getting location...");
  const [jobId, setJobId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<any | null>(null);
  
  // ✅ NEW: Bulk hiring states
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

  useEffect(() => {
    const interval = setInterval(() => {
      setTimeLeft((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s < 10 ? "0" : ""}${s}s`;
  };

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
      
      // Simulate support response
      setTimeout(() => {
        const supportResponses = [
          "Thanks for your message! A support agent is looking into this.",
          "We're here to help! What specific issue are you facing?",
          "Your concern has been noted. Our team will assist you shortly.",
          "Is there anything else we can help you with?"
        ];
        const randomResponse = supportResponses[Math.floor(Math.random() * supportResponses.length)];
        const responseMessage = {
          id: Date.now().toString(),
          sender: 'support' as const,
          text: randomResponse,
          timestamp: new Date()
        };
        setChatMessages(prev => [...prev, responseMessage]);
      }, 1500);
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

    setCancellationLoading(true);

    try {
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
      Alert.alert(
        "Network Error",
        "Failed to cancel job. Please check your connection and try again."
      );
    }
  };

    // Setup socket and listen for job updates
    useEffect(() => {
      (async () => {
        try {
          const last = await AsyncStorage.getItem("lastJobId");
          const storedToken = (await AsyncStorage.getItem("accessToken")) || (await AsyncStorage.getItem("token"));
          const userStr = await AsyncStorage.getItem("user");
          const user = userStr ? JSON.parse(userStr) : null;
          setJobId(last);
          setToken(storedToken);
          setCurrentUser(user);

          // ✅ CRITICAL: Ensure socket is connected with auth token before listening
          if (storedToken && !socket.connected) {
            socket.auth = { token: storedToken };
            socket.connect();
            console.log("🔌 Waiting screen: Socket connecting with auth token");
          }

          // Add socket listener with proper context
          const handleJobUpdated = (job: any) => {
            console.log("⏳ waiting: jobUpdated event received", job._id, "status:", job.status);
            console.log("👤 Current user:", user?.name, "| Target list:", job.targetedFor);
            
            if (!job || !last) {
              console.log("No job or lastJobId");
              return;
            }
            
            // If server sent targeted update and current user is not in the target list, ignore
            if (job._targetedUpdate && Array.isArray(job.targetedFor) && user) {
              const userIdentifiers = job.targetedFor.map((i: any) => i && i.toString());
              const matches = [user.name, user.phone].some((id) => userIdentifiers.includes(id));
              console.log("Targeted update check:", { targetedFor: job.targetedFor, userInfo: [user.name, user.phone], matches });
              if (!matches) {
                console.log("❌ Not targeted to current user, ignoring");
                return;
              }
            }
            
            if (job._id !== last) {
              console.log(`Job ID mismatch: ${job._id} !== ${last}`);
              return;
            }
            
            console.log("✅ Job status:", job.status);
            
            // ✅ Check if this is a bulk hiring job
            if (job.bulkHiring) {
              console.log(`📊 Bulk hiring job - Required: ${job.requiredWorkers}, Accepted: ${job.acceptedWorkers?.length || 0}`);
              setIsBulkHiring(true);
              setRequiredWorkers(job.requiredWorkers || 1);
              setAcceptedWorkers(job.acceptedWorkers || []);
              
              // Check if all required workers have accepted
              if (job.acceptedWorkers && job.acceptedWorkers.length >= job.requiredWorkers) {
                console.log("🎉 All workers accepted!");
                setBulkHiringComplete(true);
                setModalVisible(true);
              }
            } else if (job.status === "accepted") {
              console.log("🎉 Job accepted! Showing modal");
              // Use acceptedWorker snapshot if available, fallback to acceptedBy
              const worker = job.acceptedWorker || { name: job.acceptedBy };
              console.log("Worker data:", worker);
              setAcceptedWorker(worker);
              
              // Get location name if coordinates available
              if (worker?.location?.coordinates && worker.location.coordinates.length === 2) {
                const [lon, lat] = worker.location.coordinates;
                getLocationName(lat, lon).then(locationName => {
                  console.log("Location name:", locationName);
                  setWorkerLocationName(locationName);
                });
              } else {
                setWorkerLocationName("Location not available");
              }
              
              setModalVisible(true);
            }
          };

          socket.on("jobUpdated", handleJobUpdated);
          console.log("✅ Socket listener registered for jobUpdated");

        } catch (e) {
          console.error("Waiting screen socket error", e);
        }
      })();

      return () => {
        // Clean up listener only, don't disconnect global socket
        socket.off("jobUpdated");
      };
    }, []);

    const handleCloseModal = () => {
      setModalVisible(false);
      // navigate to contractor home or job detail
      router.replace("/home/contractor");
    };

  return (
    <View style={styles.container}>
      {/* Top Header Area */}
      <View style={styles.headerContainer}>
        {/* ✅ Back button disabled - contractor must wait for acceptances or cancel job */}
        <View style={styles.backButton} />

        <Text style={styles.title}>{t('waitingForWorkers')}...</Text>
        <Text style={styles.timerText}>Expected Response: {formatTime(timeLeft)}</Text>
      </View>

      {/* Center Loader */}
      <View style={styles.centerArea}>
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
          <Text style={styles.loadingText}>{t('weAreNotifyingWorkersNearYou')}</Text>
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
    </View>
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
});
