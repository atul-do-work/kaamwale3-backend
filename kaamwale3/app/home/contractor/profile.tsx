import React, { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, Modal, Image, DimensionValue } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useFocusEffect } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { API_BASE } from "../../../utils/config";
import { clearAllUserData } from "../../../utils/socket";
import { useAuth } from "../../../context/AuthContext";
import { useLanguage } from "../../../context/LanguageContext";
import { StyleSheet } from "react-native";
import ViewWorkersModal from "../../../components/ViewWorkersModal";
import ReferralModal from "../../../components/ReferralModal";
import { useContractorStats } from "../../../hooks/useContractorStats";
import { statsCacheManager } from "../../../utils/statsCacheManager";
import * as Progress from "react-native-progress";

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

const isJobFullyPaid = (job: any): boolean => {
  const paymentStatus = String(job?.paymentStatus || "").toLowerCase();
  if (paymentStatus === "paid") return true;
  if (Array.isArray(job?.acceptedWorkers)) {
    return job.acceptedWorkers.some((worker: any) =>
      String(worker?.paymentStatus || "").toLowerCase() === "paid"
    );
  }
  return false;
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F4F6F8",
  },
  progressContainer: {
    marginHorizontal: 16,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "#FFFFFF",
    borderRadius: 16,
    shadowColor: "#0F172A",
    shadowOpacity: 0.05,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  progressText: {
    fontSize: 12,
    color: "#4B5563",
    fontWeight: "600",
    marginTop: 8,
    textAlign: "center",
  },
  headerGradient: {
    paddingTop: 28,
    paddingBottom: 24,
    paddingHorizontal: 20,
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 28,
    overflow: "hidden",
  },
  profilePhotoContainer: {
    position: "relative",
    marginBottom: 14,
  },
  profilePhoto: {
    width: 92,
    height: 92,
    borderRadius: 46,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.92)",
  },
  profilePhotoPlaceholder: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: "rgba(255,255,255,0.18)",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.92)",
  },
  cameraIcon: {
    position: "absolute",
    bottom: 2,
    right: 2,
    backgroundColor: "#FFFFFF",
    borderRadius: 14,
    padding: 7,
    borderWidth: 1,
    borderColor: "rgba(15, 23, 42, 0.08)",
    shadowColor: "#0F172A",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  identityBlock: {
    alignItems: "center",
    width: "100%",
  },
  nameText: {
    fontSize: 24,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: 0.2,
  },
  idText: {
    fontSize: 14,
    color: "rgba(255,255,255,0.76)",
    marginTop: 4,
  },
  identityChip: {
    marginTop: 8,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  identityChipText: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    color: "rgba(255,255,255,0.82)",
  },
  ratingContainer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 8,
  },
  ratingText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#FFD700",
    marginLeft: 4,
  },
  contentWrap: {
    paddingTop: 18,
    paddingBottom: 24,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#6B7280",
    letterSpacing: 0.4,
    textTransform: "uppercase",
    marginHorizontal: 20,
    marginBottom: 12,
    marginTop: 6,
  },
  statsContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
  },
  statCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 18,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#EEF2F7",
  },
  statIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 10,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    textAlign: "center",
  },
  statLabel: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 4,
    fontWeight: "500",
    textAlign: "center",
  },
  infoCard: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginBottom: 14,
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#EEF2F7",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 10,
  },
  cardIconBg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  cardHeaderText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111827",
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingVertical: 15,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    color: "#1F2937",
    marginLeft: 12,
    fontWeight: "500",
  },
  logoutButton: {
    marginHorizontal: 16,
    marginBottom: 24,
    marginTop: 6,
    backgroundColor: "#111827",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    borderRadius: 18,
  },
  logoutText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "600",
    marginLeft: 8,
  },
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
  const { accessToken, user: authUser, logout, updateUserField } = useAuth();
  const [userName, setUserName] = useState<string>("Contractor");
  const [contractorId, setContractorId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const { jobsCompleted, totalJobs, rating } = useContractorStats();
  const [overviewPosted, setOverviewPosted] = useState<number | null>(null);
  const [overviewCompleted, setOverviewCompleted] = useState<number | null>(null);
  const [viewWorkersModalVisible, setViewWorkersModalVisible] = useState(false);
  const [referralModalVisible, setReferralModalVisible] = useState(false);

  type ModalType = "confirm" | "info" | "success" | "error";
  const [logoutModalVisible, setLogoutModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<ModalType>("info");
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);

  const router = useRouter();

  useEffect(() => {
    (async () => {
      try {
        if (authUser) {
          setUserName(authUser.name || "Contractor");
          setContractorId(authUser.phone || "0000");
          if (authUser.profilePhoto) {
            setProfilePhoto(authUser.profilePhoto);
          }
        }
      } catch (err) {
        console.error("Failed to load contractor info", err);
      }
    })();
  }, [authUser]);

  useFocusEffect(
    useCallback(() => {
      const fetchContractorJobsOverview = async () => {
        if (!accessToken || !authUser?.phone) return;

        try {
          const response = await fetch(`${API_BASE}/jobs`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            throw new Error(`Failed to fetch jobs: ${response.status}`);
          }

          const jobs = await response.json();
          const myJobs = Array.isArray(jobs)
            ? jobs.filter((job: any) => job.contractorPhone === authUser.phone && !job.isCancelled)
            : [];

          setOverviewPosted(myJobs.length);
          setOverviewCompleted(myJobs.filter(isJobFullyPaid).length);
        } catch (err) {
          console.error("Contractor profile overview fetch error:", err);
        }
      };

      fetchContractorJobsOverview();
    }, [accessToken, authUser?.phone])
  );

  const handleLogout = () => {
    setModalType("confirm");
    setModalTitle(t("logout"));
    setModalMessage(t("confirmLogout"));
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
      setModalTitle(t("permissionDenied"));
      setModalMessage(t("cameraRollPermissionRequired"));
      setLogoutModalVisible(true);
      return;
    }

    const result: any = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 1,
    });

    if (!result.canceled && result.assets?.length > 0) {
      const asset = result.assets[0];
      const uri = asset.uri;
      const previousPhoto = profilePhoto;

      console.log("[profile-upload] contractor picker result", {
        phone: authUser?.phone || null,
        uri,
        mimeType: asset.mimeType || null,
        fileName: asset.fileName || null,
        fileSize: asset.fileSize || null,
        width: asset.width || null,
        height: asset.height || null,
      });

      setProfilePhoto(uri);
      setUploadProgress(0);

      if (accessToken) {
        try {
          console.log("[profile-upload] contractor auth resolved", {
            phone: authUser?.phone || null,
            hasAccessToken: Boolean(accessToken),
          });
          setUploadProgress(25);

          const formData = new FormData();
          formData.append("file", {
            uri,
            name: asset.fileName || `contractor-${authUser?.phone}-${Date.now()}.jpg`,
            type: asset.mimeType || "image/jpeg",
          } as any);
          formData.append("type", "profilePhoto");

          console.log("[profile-upload] contractor multipart upload start", {
            phone: authUser?.phone || null,
            fileName: asset.fileName || null,
            mimeType: asset.mimeType || "image/jpeg",
          });

          const response = await fetch(`${API_BASE}/upload/upload`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
            body: formData,
          });
          setUploadProgress(90);

          const data = await response.json();
          console.log("[profile-upload] contractor /upload/upload response", {
            phone: authUser?.phone || null,
            status: response.status,
            success: data?.success,
            hasProfilePhoto: Boolean(data?.profilePhoto),
            message: data?.message || null,
          });

          if (data.success) {
            setProfilePhoto(data.profilePhoto);
            await updateUserField("profilePhoto", data.profilePhoto);
            statsCacheManager.invalidate();

            const userStr = await AsyncStorage.getItem("user");
            if (userStr) {
              const user = JSON.parse(userStr);
              user.profilePhoto = data.profilePhoto;
              await AsyncStorage.setItem("user", JSON.stringify(user));
            }

            setModalType("info");
            setModalTitle(t("success"));
            setModalMessage(t("profilePhotoUpdatedSuccess"));
            setLogoutModalVisible(true);
          } else {
            setProfilePhoto(previousPhoto || authUser?.profilePhoto || null);
            setModalType("info");
            setModalTitle(t("error"));
            setModalMessage(data.message || t("photoUploadError"));
            setLogoutModalVisible(true);
          }
        } catch (err) {
          console.error("Profile photo upload error:", err);
          console.error("[profile-upload] contractor multipart failure", {
            phone: authUser?.phone || null,
            message: (err as any)?.message || "unknown error",
            responseStatus: (err as any)?.response?.status || null,
            responseData: (err as any)?.response?.data || null,
          });
          setProfilePhoto(previousPhoto || authUser?.profilePhoto || null);
          setModalType("info");
          setModalTitle(t("error"));
          setModalMessage(t("photoUploadRetry"));
          setLogoutModalVisible(true);
        } finally {
          setUploadProgress(0);
        }
      }
    }
  };

  const navigateTo = (path: string | null) => {
    if (path === "VIEW_WORKERS") {
      setViewWorkersModalVisible(true);
    } else if (path === "REFERRAL") {
      setReferralModalVisible(true);
    } else if (path) {
      router.push(path as any);
    }
  };

  const infoCards = [
    {
      header: t("jobManager"),
      icon: "work-outline",
      color: "#667eea",
      options: [
        { name: "View Workers", icon: "people", screen: "VIEW_WORKERS" },
      ],
    },
    {
      header: t("finance"),
      icon: "payments",
      color: "#2ECC71",
      options: [{ name: t("transactionHistory"), icon: "history", screen: "/PaymentHistory" }],
    },
    {
      header: t("account"),
      icon: "account-circle",
      color: "#F39C12",
      options: [
        { name: t("settings"), icon: "settings", screen: "/Settings" },
        { name: t("verification"), icon: "verified-user", screen: "/Verification" },
        { name: t("helpCentre"), icon: "help", screen: "/HelpCentre" },
      ],
    },
  ];

  return (
    <SafeAreaView edges={["top", "left", "right"]} style={styles.container}>
      {uploadProgress > 0 && uploadProgress < 100 && (
        <View style={styles.progressContainer}>
          <Progress.Bar
            progress={uploadProgress / 100}
            width={null}
            height={6}
            color="#17263A"
            unfilledColor="#E5E7EB"
            borderWidth={0}
          />
          <Text style={styles.progressText}>{uploadProgress}% uploading</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
        <LinearGradient colors={["#17263A", "#243B55"]} style={styles.headerGradient}>
          <Bubble size={88} left="8%" top="8%" opacity={0.08} />
          <Bubble size={54} left="80%" top="18%" opacity={0.08} />
          <Bubble size={110} left="68%" top="58%" opacity={0.06} />
          <Bubble size={40} left="14%" top="72%" opacity={0.06} />

          <TouchableOpacity onPress={pickImage} style={styles.profilePhotoContainer}>
            {profilePhoto ? (
              <Image source={{ uri: profilePhoto }} style={styles.profilePhoto} />
            ) : (
              <View style={styles.profilePhotoPlaceholder}>
                <MaterialIcons name="person" size={46} color="#fff" />
              </View>
            )}
            <View style={styles.cameraIcon}>
              <MaterialIcons name="camera-alt" size={16} color="#17263A" />
            </View>
          </TouchableOpacity>

          <View style={styles.identityBlock}>
            <Text style={styles.nameText}>{userName}</Text>
            <Text style={styles.idText}>ID: {contractorId}</Text>
            <View style={styles.ratingContainer}>
              <MaterialIcons name="star" size={16} color="#FFD700" />
              <Text style={styles.ratingText}>
                {rating !== null ? `${rating.toFixed(1)} ★` : "No rating yet"}
              </Text>
            </View>
          </View>

        </LinearGradient>

        <View style={styles.contentWrap}>
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.statsContainer}>
            {[
              { label: "Posted", value: ((overviewPosted ?? totalJobs) || 0).toString(), icon: "work", color: "#667eea" },
              { label: "Completed", value: ((overviewCompleted ?? jobsCompleted) || 0).toString(), icon: "check-circle", color: "#2ECC71" },
            ].map((stat, idx) => (
              <View key={idx} style={styles.statCard}>
                <View style={[styles.statIcon, { backgroundColor: stat.color + "20" }]}> 
                  <MaterialIcons name={stat.icon as any} size={22} color={stat.color} />
                </View>
                <Text style={styles.statValue}>{stat.value}</Text>
                <Text style={styles.statLabel}>{stat.label}</Text>
              </View>
            ))}
          </View>

          <Text style={styles.sectionTitle}>Manage</Text>
          {infoCards.map((card, index) => (
            <View key={index} style={styles.infoCard}>
              <View style={styles.cardHeader}>
                <View style={[styles.cardIconBg, { backgroundColor: card.color + "20" }]}>
                  <MaterialIcons name={card.icon as any} size={20} color={card.color} />
                </View>
                <Text style={styles.cardHeaderText}>{card.header}</Text>
              </View>

              {card.options.map((option, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.optionRow}
                  onPress={() => navigateTo(option.screen)}
                >
                  <MaterialIcons name={option.icon as any} size={20} color="#6B7280" />
                  <Text style={styles.optionText}>{option.name}</Text>
                  <MaterialIcons name="keyboard-arrow-right" size={20} color="#C7CDD4" />
                </TouchableOpacity>
              ))}
            </View>
          ))}

          <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
            <MaterialIcons name="logout" size={20} color="#fff" />
            <Text style={styles.logoutText}>{t("logout")}</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {viewWorkersModalVisible && (
        <ViewWorkersModal
          visible={viewWorkersModalVisible}
          onClose={() => setViewWorkersModalVisible(false)}
          onRequestWorker={(worker) => {
            console.log("Worker requested:", worker);
          }}
        />
      )}

        <ReferralModal
          visible={referralModalVisible}
          onClose={() => setReferralModalVisible(false)}
          workerName={authUser?.name || userName}
          workerPhone={authUser?.phone || contractorId}
          variant="minimal"
        />

      <Modal
        transparent={true}
        animationType="fade"
        visible={logoutModalVisible}
        onRequestClose={() => setLogoutModalVisible(false)}
      >
        <View style={[styles.modalOverlay, { backgroundColor: "rgba(0, 0, 0, 0.5)" }]}>
          <View style={styles.modalContainer}>
            <View
              style={[
                styles.modalHeader,
                {
                  backgroundColor:
                    modalType === "confirm"
                      ? "#FFF3CD"
                      : modalType === "error"
                        ? "#FFEBEE"
                        : modalType === "success"
                          ? "#E8F5E9"
                          : "#E7F3FF",
                },
              ]}
            >
              <View
                style={[
                  styles.modalIconBg,
                  {
                    backgroundColor:
                      modalType === "confirm"
                        ? "#FF9800"
                        : modalType === "error"
                          ? "#EF4444"
                          : modalType === "success"
                            ? "#10B981"
                            : "#2196F3",
                  },
                ]}
              >
                <MaterialIcons
                  name={
                    modalType === "confirm"
                      ? "help-outline"
                      : modalType === "error"
                        ? "error-outline"
                        : modalType === "success"
                          ? "check-circle"
                          : "info"
                  }
                  size={32}
                  color="#fff"
                />
              </View>
            </View>

            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>{modalTitle}</Text>
              <Text style={styles.modalMessage}>{modalMessage}</Text>
            </View>

            {modalType === "confirm" ? (
              <View style={styles.modalButtonsRow}>
                <TouchableOpacity
                  style={[styles.modalButton, { backgroundColor: "#E0E0E0" }]}
                  onPress={() => setLogoutModalVisible(false)}
                >
                  <Text style={[styles.modalButtonText, { color: "#333" }]}>{t("cancel")}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalButton, { backgroundColor: "#FF6B6B" }]}
                  onPress={handleModalConfirm}
                >
                  <Text style={styles.modalButtonText}>{t("logout")}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.modalButton, { backgroundColor: "#2196F3", marginHorizontal: 20, marginBottom: 20 }]}
                onPress={() => setLogoutModalVisible(false)}
              >
                <Text style={styles.modalButtonText}>{t("ok")}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
