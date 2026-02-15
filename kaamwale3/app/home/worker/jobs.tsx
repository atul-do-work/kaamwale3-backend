import React, { useEffect, useState, useRef } from "react";
import { View, Text, ScrollView, Alert, Image, TouchableOpacity, Modal } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "@react-navigation/native";
import { MaterialIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";
import { socket } from "../../../utils/socket";
import { connectSocket } from "../../../utils/socket"; // ✅ Import connect function
import { API_BASE } from "../../../utils/config";
import styles from "../../../styles/WorkerJobsStyles";
import JobLocationMap from "../../../components/JobLocationMap";

// Local construction image
// import constructionImg from "@/assets/csite.png";

// Use shared socket instance from utils/socket

interface Job {
  _id: string; // MongoDB ObjectId (primary identifier)
  title: string;
  description: string;
  amount: string;
  contractorName: string;
  location?: string;
  imageUrl?: string; // ✅ Job image URL
  startTime?: string; // ✅ Start time like "09:00"
  endTime?: string; // ✅ End time like "18:00"
  numberOfDays?: number; // ✅ Job duration in days
  lat: number;
  lon: number;
  date: string; // ✅ Job date from backend
  status?: "pending" | "accepted" | "declined";
  acceptedBy?: string;
  paymentStatus?: "Paid" | null;
  rating?: {
    stars: number;
    feedback?: string;
    ratedAt?: string;
    ratedBy?: string;
  };
}

export default function Jobs(): React.ReactElement {
  const [workerName, setWorkerName] = useState<string>("Test Worker");
  const [acceptedJobs, setAcceptedJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [token, setToken] = useState<string>("");
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const [mapModalVisible, setMapModalVisible] = useState<boolean>(false);
  const [selectedJobForMap, setSelectedJobForMap] = useState<Job | null>(null);
  const [paymentModalVisible, setPaymentModalVisible] = useState<boolean>(false);
  const [paymentJobData, setPaymentJobData] = useState<{ title: string; amount: string; contractor: string } | null>(null);
  const previousPaymentState = useRef<Record<string, string | null>>({});
  const previousUserPhoneRef = useRef<string | null>(null); // ✅ Track previous user to detect changes
  const paymentNotifiedJobs = useRef<Set<string>>(new Set()); // ✅ Track jobs already notified

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
        } else if (!userPhone && previousUserPhoneRef.current !== null) {
          // User logged out
          console.log(`👤 Jobs: User logged out, resetting jobs`);
          previousUserPhoneRef.current = null;
          setCurrentUserPhone(null);
          setAcceptedJobs([]);
          previousPaymentState.current = {};
        }
      })();
    }, [])
  );

  // Load worker name + token from AsyncStorage
  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const storedToken = await AsyncStorage.getItem("token");

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

  // Helper: get full address from lat/lon
  const getAddressFromCoords = async (lat: number, lon: number) => {
    try {
      const [address] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
      if (!address) return "Unknown location";
      const area = address.name || address.street || "";
      const city = address.city || address.region || "";
      return area && city ? `${area}, ${city}` : area || city || "Unknown location";
    } catch (err) {
      console.error("Reverse geocoding error:", err);
      return "Unknown location";
    }
  };

  // Fetch accepted jobs from server
  const fetchAcceptedJobs = async (name?: string, authToken?: string) => {
    const worker = name || workerName;
    const tkn = authToken || token;

    if (!worker || !tkn) return;

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/jobs/my-accepted`, {
        method: "GET",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tkn}` },
      });

      if (!res.ok) throw new Error("Failed to fetch jobs");

      const jobs: Job[] = await res.json();
      
      // Log rating data for debugging
      jobs.forEach((job) => {
        if (job.rating) {
          console.log(`⭐ Job ${job._id} has rating:`, job.rating);
        }
      });
      
      // No need to filter by worker name anymore - the endpoint returns only this worker's jobs
      const jobsWithLocation = await Promise.all(
        jobs.map(async (job) => ({
          ...job,
          location: job.location || (await getAddressFromCoords(job.lat, job.lon)),
          paymentStatus: job.paymentStatus || null,
        }))
      );

      // Alert for new payments - only show if not already notified
      jobsWithLocation.forEach((job) => {
        if (previousPaymentState.current[job._id] !== "Paid" && job.paymentStatus === "Paid") {
          // Only show notification if we haven't already notified for this job
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
        previousPaymentState.current[job._id] = job.paymentStatus || null;
      });

      setAcceptedJobs(jobsWithLocation);
    } catch (err) {
      console.error("Error fetching jobs:", err);
      Alert.alert("Error", "Could not fetch jobs.");
    } finally {
      setLoading(false);
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

    setupSocket();
    fetchAcceptedJobs(workerName, token);

    const handleJobUpdated = async (job: Job) => {
      console.log("📢 Job updated event received:", job._id, "Status:", job.paymentStatus, "Rating:", job.rating);
      // If server sent targeted update and current user is not in the target list, ignore
      if ((job as any)._targetedUpdate && Array.isArray((job as any).targetedFor)) {
        const targets = ((job as any).targetedFor || []).map((t: any) => t && t.toString());
        if (!targets.includes(workerName) && !(currentUserPhone && targets.includes(currentUserPhone))) {
          console.log('Ignored targeted jobUpdated not meant for this worker');
          return;
        }
      }
      if (job.acceptedBy !== workerName) return;

      const location = job.location || (await getAddressFromCoords(job.lat, job.lon));
      
      setAcceptedJobs((prev) => {
        const exists = prev.find((j) => j._id === job._id);
        if (exists) {
          // Merge with existing job, preserving all fields including rating
          const merged = { 
            ...prev.find((j) => j._id === job._id), 
            ...job,
            location 
          };
          console.log("✅ Merged job with rating:", merged.rating);
          console.log("📋 Full merged job object:", merged);
          return prev.map((j) => (j._id === job._id ? merged : j));
        } else if (job.status === "accepted") {
          return [...prev, { ...job, location }];
        }
        return prev;
      });
      
      // Log the entire acceptedJobs state after update
      setTimeout(() => {
        console.log("🔍 Current acceptedJobs in state:", acceptedJobs);
      }, 100);

      if (previousPaymentState.current[job._id] !== "Paid" && job.paymentStatus === "Paid") {
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
      previousPaymentState.current[job._id] = job.paymentStatus || null;
    };

    const handleNewJob = async (job: Job) => {
      // Refresh accepted jobs list whenever any job is updated
      console.log(`📨 Job update received, refreshing accepted jobs list`);
      fetchAcceptedJobs(workerName, token);
    };

    // Subscribe to socket events
    socket.on("jobUpdated", handleJobUpdated);
    socket.on("jobUpdated", handleNewJob); // ✅ Listen for any job updates

    // Cleanup on unmount
    return () => {
      socket.off("jobUpdated", handleJobUpdated);
      socket.off("jobUpdated", handleNewJob);
    };
  }, [workerName, token]);

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
      <ScrollView style={styles.container} contentContainerStyle={{ paddingVertical: 12 }}>
        {loading ? (
          <Text style={styles.loadingText}>Loading jobs...</Text>
        ) : acceptedJobs.length === 0 ? (
          <Text style={styles.noJobsText}>No accepted jobs yet.</Text>
        ) : (
          acceptedJobs.map((job) => {
            return (
              <View key={job._id} style={{ marginBottom: 16 }}>
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
                  {/* Top Image */}
                  <View style={{ height: 180, overflow: "hidden", backgroundColor: "#EEE" }}>
                    <Image
                      source={job.imageUrl ? { uri: job.imageUrl } : require("../../../assets/oip2.jpg")}
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
                          {job.date ? new Date(job.date).toLocaleDateString() : "N/A"}
                        </Text>
                      </View>

                      {/* Time */}
                      {(job.startTime || job.endTime) && (
                        <View style={{ flexDirection: "row", alignItems: "center", flex: 1, marginLeft: 10 }}>
                          <MaterialIcons name="schedule" size={14} color="#999" />
                          <Text style={{ color: "#666", fontSize: 12, marginLeft: 6 }}>
                            {job.startTime || "N/A"} - {job.endTime || "N/A"}
                          </Text>
                        </View>
                      )}
                    </View>

                    {/* Duration (Days) - ✅ Show job duration */}
                    {job.numberOfDays && (
                      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 10 }}>
                        <MaterialIcons name="timer" size={14} color="#999" />
                        <Text style={{ color: "#666", fontSize: 12, marginLeft: 6 }}>
                          Duration: {job.numberOfDays} {job.numberOfDays === 1 ? 'day' : 'days'}
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
                      {job.paymentStatus === "Paid" ? (
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
                            Paid
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
                            Pending
                          </Text>
                        </View>
                      )}

                      {/* Rating */}
                      {job.rating?.stars ? (
                        <View style={{ flexDirection: "row", alignItems: "center" }}>
                          <MaterialIcons name="star" size={16} color="#FFD700" />
                          <Text style={{ color: "#333", fontSize: 13, fontWeight: "700", marginLeft: 6 }}>
                            {job.rating.stars}/5
                          </Text>
                        </View>
                      ) : (
                        <Text style={{ color: "#999", fontSize: 12 }}>No rating yet</Text>
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
                  </View>
                </View>
              </View>
            );
          })
        )}
      </ScrollView>

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
              Payment Received! 🎉
            </Text>

            {/* Subtitle */}
            <Text style={{
              fontSize: 14,
              color: "rgba(255, 255, 255, 0.9)",
              marginBottom: 20,
              textAlign: "center",
              fontWeight: "600",
            }}>
              Your payment has been processed successfully
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
                  JOB TITLE
                </Text>
                <Text style={{ fontSize: 15, fontWeight: "800", color: "#FFF", marginTop: 2 }}>
                  {paymentJobData?.title}
                </Text>
              </View>

              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <View>
                  <Text style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.8)", fontWeight: "600" }}>
                    AMOUNT
                  </Text>
                  <Text style={{ fontSize: 18, fontWeight: "900", color: "#FFF", marginTop: 2 }}>
                    ₹{paymentJobData?.amount}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={{ fontSize: 11, color: "rgba(255, 255, 255, 0.8)", fontWeight: "600" }}>
                    FROM
                  </Text>
                  <Text style={{ fontSize: 15, fontWeight: "700", color: "#FFF", marginTop: 2 }}>
                    {paymentJobData?.contractor}
                  </Text>
                </View>
              </View>
            </View>

            {/* Close Button */}
            <TouchableOpacity
              onPress={() => setPaymentModalVisible(false)}
              style={{
                width: "100%",
                backgroundColor: "rgba(255, 255, 255, 0.25)",
                paddingVertical: 12,
                borderRadius: 10,
                borderWidth: 1.5,
                borderColor: "#FFF",
              }}
            >
              <Text style={{ color: "#FFF", fontSize: 15, fontWeight: "700", textAlign: "center" }}>
                Got It!
              </Text>
            </TouchableOpacity>
          </LinearGradient>
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
    </SafeAreaView>
  );
}
