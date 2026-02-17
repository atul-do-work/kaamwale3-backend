import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, Modal, Image, Platform , DimensionValue} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useFocusEffect } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { API_BASE } from "../../../utils/config";
import { clearAllUserData } from "../../../utils/socket";
import { useAuth } from "../../../context/AuthContext";
import { useLanguage } from '../../../context/LanguageContext';
import api from '../../../utils/api';
import { StyleSheet } from "react-native";
import ViewWorkersModal from "../../../components/ViewWorkersModal";

// ✅ Decorative Bubble Component
const Bubble = ({
  size,
  left,
  top,
  opacity,
}: {
  size: number;
  left: DimensionValue;
  top: DimensionValue;
  opacity: number;
}) => (
  <View
    style={{
      position: "absolute",
      width: size,
      height: size,
      borderRadius: size / 2,
      backgroundColor: `rgba(255, 255, 255, ${opacity})`,
      left,
      top,
    }}
  />
);

// Inline styles for contractor profile
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  headerGradient: {
    paddingTop: 40,
    paddingBottom: 30,
    paddingHorizontal: 20,
    alignItems: "center",
  },
  profilePhotoContainer: {
    position: "relative",
    marginBottom: 20,
  },
  profilePhoto: {
    width: 100,
    height: 100,
    borderRadius: 50,
    borderWidth: 4,
    borderColor: "#fff",
  },
  profilePhotoPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: "rgba(255,255,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 4,
    borderColor: "#fff",
  },
  cameraIcon: {
    position: "absolute",
    bottom: 0,
    right: 0,
    backgroundColor: "#FF6B6B",
    borderRadius: 16,
    padding: 6,
    borderWidth: 3,
    borderColor: "#fff",
  },
  nameText: {
    fontSize: 24,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 4,
  },
  idText: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
    marginBottom: 20,
  },
  walletCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.15)",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    width: "100%",
    marginTop: 10,
  },
  walletInfo: {
    flex: 1,
    marginLeft: 12,
  },
  walletLabel: {
    fontSize: 12,
    color: "rgba(255,255,255,0.7)",
  },
  walletAmount: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginTop: 2,
  },
  statsContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 20,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  statIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 8,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
  },
  statLabel: {
    fontSize: 12,
    color: "#999",
    marginTop: 4,
  },
  infoCard: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  cardIconBg: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  cardHeaderText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F5F5F5",
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    color: "#333",
    marginLeft: 12,
    fontWeight: "500",
  },
  logoutButton: {
    marginHorizontal: 16,
    marginBottom: 24,
    marginTop: 8,
    backgroundColor: "#FF6B6B",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
  },
  logoutText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 8,
  },
  spacer: {
    height: 20,
  },
  
  // ✅ Modal Styles
  modalOverlay: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  
  modalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 340,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  
  modalHeader: {
    paddingVertical: 24,
    alignItems: "center",
  },
  
  modalIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },
  
  modalContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: "center",
  },
  
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 8,
    textAlign: "center",
  },
  
  modalMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },
  
  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
    flex: 1,
  },
  
  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  
  modalButtonsRow: {
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 20,
  },
});

export default function ContractorProfile(): React.ReactElement {
  const { t } = useLanguage();
  const { accessToken, user: authUser, logout } = useAuth();
  const [userName, setUserName] = useState<string>("Contractor");
  const [contractorId, setContractorId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [postedCount, setPostedCount] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [inProgressCount, setInProgressCount] = useState(0);
  const [viewWorkersModalVisible, setViewWorkersModalVisible] = useState(false);
  
  // ✅ Custom modal state with explicit type definition
  type ModalType = "confirm" | "info" | "success" | "error";
  const [logoutModalVisible, setLogoutModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<ModalType>("info");
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  
  const router = useRouter();

  // Use configured API base

  // ✅ OPTIMIZED: Fetch stats from dedicated endpoint instead of all jobs
  const fetchJobStats = async (authToken: string) => {
    try {
      const res = await api.get(`/contractor/stats?range=all`);
      const data = res.data;
      
      if (data && data.success && data.aggregated) {
        // ✅ Backend returns pre-calculated stats - no frontend guessing
        setPostedCount(data.aggregated.totalJobsPosted || 0);
        setCompletedCount(data.aggregated.totalJobsCompleted || 0);
        // ✅ Use backend in-progress count (accounts for cancelled, rejected, etc.)
        setInProgressCount(data.aggregated.totalJobsInProgress || 0);
      }
    } catch (err) {
      console.error("Failed to fetch job stats", err);
    }
  };

  useEffect(() => {
    (async () => {
      try {
        if (authUser) {
          setUserName(authUser.name || "Contractor");
          setContractorId(authUser.phone || "0000");
          // ✅ Use backend profile photo URL directly
          if (authUser.profilePhoto) {
            setProfilePhoto(authUser.profilePhoto);
          }
        }

        // ✅ Removed: Wallet fetch is not needed since wallet UI is hidden
        // If wallet is not shown → don't fetch it
        if (accessToken) {
          // Fetch job stats
          await fetchJobStats(accessToken);
        }
      } catch (err) {
        console.error("Failed to load contractor info", err);
      }
    })();
  }, [authUser, accessToken]);

  // Refresh stats on focus
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        if (accessToken) {
          await fetchJobStats(accessToken);
        }
      })();
    }, [accessToken])
  );

  // ✅ Show custom logout confirmation modal
  const handleLogout = () => {
    setModalType("confirm");
    setModalTitle("Logout");
    setModalMessage("Are you sure you want to logout?");
    setPendingAction(() => async () => {
      try {
        await clearAllUserData();
        await logout();
        router.replace("/");
      } catch (err) {
        console.error("Error logging out", err);
        router.replace("/");
      }
    });
    setLogoutModalVisible(true);
  };
  
  // ✅ Handle modal confirmation
  const handleModalConfirm = () => {
    setLogoutModalVisible(false);
    if (pendingAction) {
      pendingAction();
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      setModalType("info");
      setModalTitle("Permission Denied");
      setModalMessage("Camera roll permission is required.");
      setLogoutModalVisible(true);
      return;
    }

    const result: any = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });

    if (!result.canceled && result.assets?.length > 0) {
      const uri = result.assets[0].uri;
      
      // Show temporary local preview
      setProfilePhoto(uri);

      // Upload to backend
      if (accessToken) {
        try {
          const formData = new FormData();
          formData.append("photo", {
            uri,
            type: "image/jpeg",
            name: `profile-${Date.now()}.jpg`,
          } as any);

          const response = await fetch(`${API_BASE}/users/photo`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            body: formData,
          });

          const data = await response.json();
          if (data.success) {
            // ✅ Use backend URL only - no AsyncStorage
            setProfilePhoto(data.profilePhoto);
            
            // Update user object in AsyncStorage if needed for other uses
            const userStr = await AsyncStorage.getItem("user");
            if (userStr) {
              const user = JSON.parse(userStr);
              user.profilePhoto = data.profilePhoto;
              await AsyncStorage.setItem("user", JSON.stringify(user));
            }
            
            setModalType("info");
            setModalTitle("Success");
            setModalMessage("Profile photo updated successfully");
            setLogoutModalVisible(true);
          } else {
            setModalType("info");
            setModalTitle("Error");
            setModalMessage(data.message || "Failed to upload profile photo");
            setLogoutModalVisible(true);
          }
        } catch (err) {
          console.error("Profile photo upload error:", err);
          setModalType("info");
          setModalTitle("Error");
          setModalMessage("Failed to upload profile photo. Please try again.");
          setLogoutModalVisible(true);
        }
      }
    }
  };

  const navigateTo = (path: string | null) => {
    if (path === "VIEW_WORKERS") {
      // ✅ Open View Workers Modal instead of navigating
      setViewWorkersModalVisible(true);
    } else if (path) {
      router.push(path as any);
    }
  };

  const infoCards = [
    {
      header: "Job Manager",
      icon: "work-outline",
      color: "#667eea",
      options: [
        { name: "View Workers", icon: "people", screen: "VIEW_WORKERS" }, // ✅ Changed to modal trigger
      ],
    },
    {
      header: "Finance",
      icon: "payments",
      color: "#2ECC71",
      options: [
        { name: "Transaction History", icon: "history", screen: "/PaymentHistory" },
      ],
    },
    {
      header: "Account",
      icon: "account-circle",
      color: "#F39C12",
      options: [
        { name: "Settings", icon: "settings", screen: "/Settings" },
        { name: "Help Centre", icon: "help", screen: "/HelpCentre" },
      ],
    },
  ];

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <ScrollView contentContainerStyle={{ paddingBottom: 80 }}>
      {/* Premium Header with Decorative Bubbles */}
      <LinearGradient colors={["#1a2f4d", "#2d5a8c"]} style={styles.headerGradient}>
        {/* ✅ Decorative Bubbles */}
        <Bubble size={80} left="10%" top="10%" opacity={0.15} />
        <Bubble size={50} left="80%" top="20%" opacity={0.1} />
        <Bubble size={100} left="70%" top="60%" opacity={0.12} />
        <Bubble size={35} left="15%" top="70%" opacity={0.08} />

        <TouchableOpacity onPress={pickImage} style={styles.profilePhotoContainer}>
          {profilePhoto ? (
            <Image source={{ uri: profilePhoto }} style={styles.profilePhoto} />
          ) : (
            <View style={styles.profilePhotoPlaceholder}>
              <MaterialIcons name="person" size={50} color="#fff" />
            </View>
          )}
          <View style={styles.cameraIcon}>
            <MaterialIcons name="camera-alt" size={16} color="#fff" />
          </View>
        </TouchableOpacity>

        <Text style={styles.nameText}>{userName}</Text>
        <Text style={styles.idText}>ID: {contractorId}</Text>

        {/* Quick Wallet Card - Removed as per requirement */}
        {/* Users won't receive money, so no need to show balance */}
      </LinearGradient>

      {/* Quick Stats */}
      <View style={styles.statsContainer}>
        {[
          { label: "Posted", value: postedCount.toString(), icon: "work", color: "#667eea" },
          { label: "Completed", value: completedCount.toString(), icon: "check-circle", color: "#2ECC71" },
          { label: "In Progress", value: inProgressCount.toString(), icon: "hourglass-empty", color: "#F39C12" },
        ].map((stat, idx) => (
          <View key={idx} style={styles.statCard}>
            <View style={[styles.statIcon, { backgroundColor: stat.color + "20" }]}>
              <MaterialIcons name={stat.icon as any} size={24} color={stat.color} />
            </View>
            <Text style={styles.statValue}>{stat.value}</Text>
            <Text style={styles.statLabel}>{stat.label}</Text>
          </View>
        ))}
      </View>

      {/* Info Cards */}
      {infoCards.map((card, index) => (
        <View key={index} style={styles.infoCard}>
          <View style={styles.cardHeader}>
            <View style={[styles.cardIconBg, { backgroundColor: card.color + "20" }]}>
              <MaterialIcons name={card.icon as any} size={22} color={card.color} />
            </View>
            <Text style={styles.cardHeaderText}>{card.header}</Text>
          </View>

          {card.options.map((option, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.optionRow}
              onPress={() => navigateTo(option.screen)}
            >
              <MaterialIcons name={option.icon as any} size={20} color="#666" />
              <Text style={styles.optionText}>{option.name}</Text>
              <MaterialIcons name="keyboard-arrow-right" size={20} color="#CCC" />
            </TouchableOpacity>
          ))}
        </View>
      ))}

      {/* Logout Button */}
      <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <MaterialIcons name="logout" size={20} color="#fff" />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>
    </ScrollView>

    {/* ✅ View Workers Modal - Only mounted when visible to save memory */}
    {viewWorkersModalVisible && (
      <ViewWorkersModal
        visible={viewWorkersModalVisible}
        onClose={() => setViewWorkersModalVisible(false)}
        onRequestWorker={(worker) => {
          console.log('Worker requested:', worker);
          setViewWorkersModalVisible(false);
          // TODO: Handle worker request (show premium modal if needed, send request to backend)
        }}
      />
    )}

    {/* ✅ Custom Modal for Messages & Confirmations */}
    <Modal
      transparent={true}
      animationType="fade"
      visible={logoutModalVisible}
      onRequestClose={() => setLogoutModalVisible(false)}
    >
      <View style={[styles.modalOverlay, { backgroundColor: "rgba(0, 0, 0, 0.5)" }]}>
        <View style={styles.modalContainer}>
          {/* Modal Header with Icon - Dynamic color based on type */}
          <View style={[
            styles.modalHeader,
            {
              backgroundColor: 
                modalType === "confirm" ? "#FFF3CD" :
                modalType === "error" ? "#FFEBEE" :
                modalType === "success" ? "#E8F5E9" :
                "#E7F3FF",
            }
          ]}>
            <View style={[
              styles.modalIconBg,
              {
                backgroundColor: 
                  modalType === "confirm" ? "#FF9800" :
                  modalType === "error" ? "#EF4444" :
                  modalType === "success" ? "#10B981" :
                  "#2196F3",
              }
            ]}>
              <MaterialIcons
                name={
                  modalType === "confirm" ? "help-outline" :
                  modalType === "error" ? "error-outline" :
                  modalType === "success" ? "check-circle" :
                  "info"
                }
                size={32}
                color="#fff"
              />
            </View>
          </View>

          {/* Modal Content */}
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{modalTitle}</Text>
            <Text style={styles.modalMessage}>{modalMessage}</Text>
          </View>

          {/* Modal Footer - Buttons (Confirm vs OK) */}
          {modalType === "confirm" ? (
            <View style={styles.modalButtonsRow}>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: "#E0E0E0" }]}
                onPress={() => setLogoutModalVisible(false)}
              >
                <Text style={[styles.modalButtonText, { color: "#333" }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: "#FF6B6B" }]}
                onPress={handleModalConfirm}
              >
                <Text style={styles.modalButtonText}>Logout</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: "#2196F3", marginHorizontal: 20, marginBottom: 20 }]}
              onPress={() => setLogoutModalVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
    </SafeAreaView>
  );
}
