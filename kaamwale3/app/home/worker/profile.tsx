import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  Modal,
  StyleSheet,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useRouter, useFocusEffect } from "expo-router";
import axios from "axios";
import { API_BASE } from "../../../utils/config";
import { clearAllUserData } from "../../../utils/socket";
import { getAuthAccessToken } from "../../../utils/secureStore";
import ReferralModal from "../../../components/ReferralModal";
import { useLanguage } from "../../../context/LanguageContext";
import { useAuth } from "../../../context/AuthContext";
import * as Progress from "react-native-progress";

const MAIN_SKILLS = ["labour", "mason", "engineer", "itiTechnician"] as const;
const WAGE_RANGES = [
  { label: "₹400 to ₹550", value: "400-550" },
  { label: "₹550 to ₹700", value: "550-700" },
  { label: "₹700 to Max", value: "700-max" },
];

const WAGE_RANGE_KEYS: Record<string, keyof typeof import("../../../constants/translations").translations.en> = {
  "400-550": "wageRange400To550",
  "550-700": "wageRange550To700",
  "700-max": "wageRange700ToMax",
};

const styles = StyleSheet.create({
  screen: {
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
    paddingTop: 26,
    paddingBottom: 24,
    paddingHorizontal: 20,
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 28,
    overflow: "hidden",
  },
  bubbleLg: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: "rgba(255,255,255,0.07)",
    top: -10,
    right: -10,
  },
  bubbleSm: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,255,255,0.08)",
    bottom: 20,
    left: 18,
  },
  editHeaderButton: {
    position: "absolute",
    top: 14,
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  profilePhotoWrap: {
    position: "relative",
    marginBottom: 14,
  },
  profilePhoto: {
    width: 94,
    height: 94,
    borderRadius: 47,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.92)",
  },
  profilePlaceholder: {
    width: 94,
    height: 94,
    borderRadius: 47,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.92)",
    backgroundColor: "rgba(255,255,255,0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  cameraBadge: {
    position: "absolute",
    bottom: 2,
    right: 2,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  nameText: {
    fontSize: 24,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  workerId: {
    fontSize: 14,
    color: "rgba(255,255,255,0.78)",
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
    color: "rgba(255,255,255,0.84)",
    fontWeight: "600",
    letterSpacing: 0.4,
  },
  headerMetaRow: {
    flexDirection: "row",
    gap: 10,
    width: "100%",
    marginTop: 18,
  },
  headerMetaCard: {
    flex: 1,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 18,
    paddingVertical: 13,
    paddingHorizontal: 10,
    alignItems: "center",
  },
  headerMetaValue: {
    fontSize: 16,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  headerMetaLabel: {
    marginTop: 4,
    fontSize: 11,
    color: "rgba(255,255,255,0.72)",
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
  actionRow: {
    flexDirection: "row",
    paddingHorizontal: 16,
    gap: 12,
  },
  actionCard: {
    flex: 1,
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    paddingVertical: 18,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "#EEF2F7",
    alignItems: "flex-start",
  },
  actionIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
  },
  actionCardText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#111827",
  },
  referralCard: {
    marginHorizontal: 16,
    marginTop: 14,
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    padding: 18,
    borderWidth: 1,
    borderColor: "#EEF2F7",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  referralHeading: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  referralText: {
    marginTop: 4,
    fontSize: 13,
    color: "#6B7280",
    maxWidth: 220,
    lineHeight: 18,
  },
  infoCard: {
    backgroundColor: "#FFFFFF",
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
    backgroundColor: "#EEF2FF",
    alignItems: "center",
    justifyContent: "center",
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
    fontWeight: "500",
  },
  logoutButton: {
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 24,
    backgroundColor: "#111827",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 16,
    borderRadius: 18,
  },
  logoutText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    marginLeft: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(15, 23, 42, 0.38)",
    justifyContent: "center",
    alignItems: "center",
    padding: 18,
  },
  sheetCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    overflow: "hidden",
  },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  sheetBody: {
    padding: 18,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#374151",
    marginBottom: 8,
  },
  pickerButton: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#F9FAFB",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  pickerButtonText: {
    color: "#111827",
    fontSize: 14,
    flex: 1,
  },
  pickerMenu: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#FFFFFF",
  },
  pickerItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  primaryButton: {
    marginTop: 8,
    backgroundColor: "#17263A",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
  },
  earningsModalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#FFFFFF",
    borderRadius: 24,
    overflow: "hidden",
    maxHeight: "80%",
  },
  earningsHeader: {
    paddingHorizontal: 18,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#F3F4F6",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  earningsTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#111827",
  },
  earningsContent: {
    padding: 18,
  },
  totalEarningsCard: {
    borderRadius: 22,
    padding: 18,
    marginBottom: 14,
  },
  totalEarningsLabel: {
    fontSize: 13,
    color: "rgba(255,255,255,0.78)",
  },
  totalEarningsValue: {
    marginTop: 6,
    fontSize: 30,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  totalEarningsSubtext: {
    marginTop: 4,
    fontSize: 12,
    color: "rgba(255,255,255,0.76)",
  },
  earningsItem: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    borderRadius: 18,
    padding: 14,
    marginBottom: 10,
  },
  earningsIconBox: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 12,
  },
  earningsItemContent: {
    flex: 1,
  },
  earningsItemLabel: {
    fontSize: 13,
    color: "#6B7280",
  },
  earningsItemValue: {
    marginTop: 2,
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
  },
  withdrawButton: {
    marginTop: 8,
    backgroundColor: "#17263A",
    borderRadius: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
  },
  withdrawButtonText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    marginLeft: 8,
  },
});

export default function Profile(): React.ReactElement {
  const { t } = useLanguage();
  const { logout, accessToken, updateUserField } = useAuth();
  const tx = (key: keyof typeof import("../../../constants/translations").translations.en, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  };
  const [userName, setUserName] = useState<string>("Worker");
  const [workerId, setWorkerId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [referralModalVisible, setReferralModalVisible] = useState(false);
  const [earningsModalVisible, setEarningsModalVisible] = useState(false);
  const [workerName, setWorkerName] = useState<string>("");
  const [workerPhone, setWorkerPhone] = useState<string>("");
  const [totalEarnings, setTotalEarnings] = useState(0);
  const [gigEarnings, setGigEarnings] = useState(0);
  const [jobsEarnings, setJobsEarnings] = useState(0);
  const [totalDeductions, setTotalDeductions] = useState(0);
  const [referralBonus, setReferralBonus] = useState(0);
  const [userToken, setUserToken] = useState<string>("");
  const [workerRating, setWorkerRating] = useState<number>(0);
  const [totalReviews, setTotalReviews] = useState<number>(0);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [showWageMenu, setShowWageMenu] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string>("");
  const [selectedWage, setSelectedWage] = useState<string>("");
  const [menuModalVisible, setMenuModalVisible] = useState(false);

  const router = useRouter();
  const wageLabelMap = Object.keys(WAGE_RANGE_KEYS).reduce<Record<string, string>>((acc, value) => {
    acc[value] = t(WAGE_RANGE_KEYS[value]);
    return acc;
  }, {});

  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const profileStr = await AsyncStorage.getItem("profilePhoto");
        const token = await getAuthAccessToken();

        if (userStr) {
          const parsed = JSON.parse(userStr);
          setUserName(parsed.name || "Worker");
          setWorkerId(parsed.phone || "0000");
          setWorkerName(parsed.name || "Worker");
          setWorkerPhone(parsed.phone || "0000");
          setSelectedSkill(parsed.mainSkill || "");
          setSelectedWage(parsed.expectedWage || "");
          if (parsed.profilePhoto && !profileStr) {
            setProfilePhoto(parsed.profilePhoto);
            await AsyncStorage.setItem("profilePhoto", parsed.profilePhoto);
          }
        }

        if (profileStr) setProfilePhoto(profileStr);
        if (token) setUserToken(token);
      } catch (err) {
        console.error("Failed to load user/profile photo", err);
      }
    })();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const profileStr = await AsyncStorage.getItem("profilePhoto");
        if (profileStr) setProfilePhoto(profileStr);
        await fetchWorkerRating();
      })();
    }, [])
  );

  const fetchWorkerRating = async () => {
    try {
      const token = await getAuthAccessToken();
      if (!token) return;

      const response = await fetch(`${API_BASE}/worker/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.worker) {
          setWorkerRating(data.worker.performanceMetrics?.averageRating || data.worker.rating || 0);
          setTotalReviews(data.worker.performanceMetrics?.totalReviews || 0);
        }
      }
    } catch (err) {
      console.error("Error fetching worker rating:", err);
    }
  };

  const fetchEarningsData = async () => {
    try {
      const token = await getAuthAccessToken();
      if (!token) return;

      const response = await fetch(`${API_BASE}/worker/earnings`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) throw new Error("Failed to fetch earnings");

      const data = await response.json();
      if (data.success && data.earnings) {
        const earned = data.earnings.byStatus?.earned?.amount || 0;
        const pending = data.earnings.byStatus?.pending?.amount || 0;

        setGigEarnings(earned);
        setJobsEarnings(pending);
        setTotalEarnings(data.earnings.totalEarned || 0);
      }
    } catch (err) {
      console.error("Error fetching earnings:", err);
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(t("warning"), t("cameraRollPermissionRequired"));
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

      setProfilePhoto(uri);
      setUploadProgress(0);

      try {
        const authToken = accessToken || userToken || await getAuthAccessToken();
        if (!authToken) {
          Alert.alert(t("error"), t("photoUploadError"));
          return;
        }

        setUploadProgress(25);
        const formData = new FormData();
        formData.append("file", {
          uri,
          name: asset.fileName || `worker-${workerId}-${Date.now()}.jpg`,
          type: asset.mimeType || "image/jpeg",
        } as any);
        formData.append("type", "profilePhoto");

        // Use fetch multipart upload (works reliably in React Native)
        setUploadProgress(40);
        const response = await fetch(`${API_BASE}/upload/upload`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
          body: formData,
        });
        setUploadProgress(90);
        const data = await response.json();

        if (data.success && data.profilePhoto) {
          setProfilePhoto(data.profilePhoto);
          await AsyncStorage.setItem("profilePhoto", data.profilePhoto);
          await updateUserField("profilePhoto", data.profilePhoto);
          Alert.alert(t("success"), t("profilePhotoUpdated"));
        } else {
          Alert.alert(t("error"), data.message || t("serverError"));
          setProfilePhoto(previousPhoto || null);
        }
      } catch (err: any) {
        const responseData = err?.response?.data;
        const errorMessage = responseData?.message || err?.message || "Unknown upload error";
        Alert.alert(t("error"), errorMessage);
        setProfilePhoto(previousPhoto || null);
      } finally {
        setUploadProgress(0);
      }
    }
  };

  const handleLogout = async () => {
    Alert.alert(t("logout"), t("confirmLogout"), [
      { text: t("cancel"), style: "cancel" },
      {
        text: t("logout"),
        style: "destructive",
        onPress: async () => {
          try {
            await clearAllUserData();
            await logout();
            router.replace("/");
          } catch (err) {
            console.error("Failed to logout", err);
            router.replace("/");
          }
        },
      },
    ]);
  };

  const navigateTo = (path: string | null) => {
    if (path) router.push(path as any);
  };

  const handleSaveProfile = async () => {
    if (!selectedSkill || !selectedWage) {
      Alert.alert(t("error"), t("selectSkillWage"));
      return;
    }

    try {
      const authToken = accessToken || userToken || await getAuthAccessToken();
      const response = await axios.post(
        `${API_BASE}/users/update-profile`,
        {
          mainSkill: selectedSkill,
          expectedWage: selectedWage,
        },
        {
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.success) {
        const userStr = await AsyncStorage.getItem("user");
        if (userStr) {
          const user = JSON.parse(userStr);
          user.mainSkill = selectedSkill;
          user.expectedWage = selectedWage;
          await AsyncStorage.setItem("user", JSON.stringify(user));
        }

        Alert.alert(t("success"), t("profileUpdated"));
        setMenuModalVisible(false);
      }
    } catch (err: any) {
      console.error("Profile update error:", err);
      Alert.alert(t("error"), err?.response?.data?.message || t("failedUpdateProfile"));
    }
  };

  const infoCards = [
    {
      header: tx("supportSection", "Support"),
      icon: "support-agent",
      options: [
        { name: t("helpCentre"), screen: "/HelpCentre" },
        { name: tx("supportTicket", "Support Ticket"), screen: "/SupportTickets" },
      ],
    },
    {
      header: tx("documentsPolicies", "Documents & Policies"),
      icon: "description",
      options: [
        { name: tx("aadharAndPolicy", "Aadhar Card & 90-Day Policy"), screen: "/DocumentsAndPolicies" },
      ],
    },
    {
      header: tx("partnerOptions", "Partner Options"),
      icon: "handshake",
      options: [
        { name: t("videosTutorials"), screen: "/VideosAndTutorials" },
      ],
    },
  ];

  return (
    <SafeAreaView style={styles.screen} edges={["top", "left", "right"]}>
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
          <Text style={styles.progressText}>{uploadProgress}% {tx("uploadingLabel", "uploading")}</Text>
        </View>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: 16 }}>
        <LinearGradient colors={["#17263A", "#243B55"]} style={styles.headerGradient}>
          <View style={styles.bubbleLg} />
          <View style={styles.bubbleSm} />
          <TouchableOpacity style={styles.editHeaderButton} onPress={() => setMenuModalVisible(true)}>
            <MaterialIcons name="edit" size={18} color="#FFFFFF" />
          </TouchableOpacity>

          <TouchableOpacity onPress={pickImage} style={styles.profilePhotoWrap}>
            {profilePhoto ? (
              <Image source={{ uri: profilePhoto }} style={styles.profilePhoto} />
            ) : (
              <View style={styles.profilePlaceholder}>
                <MaterialIcons name="person" size={46} color="#fff" />
              </View>
            )}
            <View style={styles.cameraBadge}>
              <MaterialIcons name="camera-alt" size={16} color="#17263A" />
            </View>
          </TouchableOpacity>

          <Text style={styles.nameText}>{userName}</Text>
          <Text style={styles.workerId}>{tx("workerIdLabel", "Worker ID")}: {workerId}</Text>
          <View style={styles.identityChip}>
            <Text style={styles.identityChipText}>Worker Profile</Text>
          </View>

          <View style={styles.headerMetaRow}>
            <View style={styles.headerMetaCard}>
              <Text style={styles.headerMetaValue}>{workerRating.toFixed(1)}</Text>
              <Text style={styles.headerMetaLabel}>{tx("ratingLabel", "Rating")}</Text>
            </View>
            <View style={styles.headerMetaCard}>
              <Text style={styles.headerMetaValue}>{totalReviews}</Text>
              <Text style={styles.headerMetaLabel}>{tx("reviewsLabel", "Reviews")}</Text>
            </View>
            <View style={styles.headerMetaCard}>
              <Text style={styles.headerMetaValue}>{selectedSkill ? t(selectedSkill as any) : "--"}</Text>
              <Text style={styles.headerMetaLabel}>{t("mainSkill")}</Text>
            </View>
          </View>
        </LinearGradient>

        <View style={styles.contentWrap}>
          <Text style={styles.sectionTitle}>Overview</Text>
          <View style={styles.actionRow}>
            {[
              { title: t("gigHistory"), icon: "history", route: "/GigHistory" },
              {
                title: t("earnings"),
                icon: "payments",
                action: () => {
                  fetchEarningsData();
                  setEarningsModalVisible(true);
                },
              },
              { title: t("settings"), icon: "settings", route: "/Settings" },
            ].map((card, index) => (
              <TouchableOpacity
                key={index}
                style={styles.actionCard}
                onPress={() => {
                  if ("route" in card) {
                    router.push(card.route as any);
                  } else if ("action" in card) {
                    (card.action as () => void)();
                  }
                }}
              >
                <View style={styles.actionIconWrap}>
                  <MaterialIcons name={card.icon as any} size={20} color="#17263A" />
                </View>
                <Text style={styles.actionCardText}>{card.title}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.referralCard} onPress={() => setReferralModalVisible(true)} activeOpacity={0.8}>
            <View>
              <Text style={styles.referralHeading}>{t("referralBonus")}</Text>
              <Text style={styles.referralText}>{tx("referralBonusEarned", "You have earned ₹50 from referrals")}</Text>
            </View>
            <MaterialIcons name="card-giftcard" size={32} color="#17263A" />
          </TouchableOpacity>

          <Text style={styles.sectionTitle}>Manage</Text>
          {infoCards.map((card, index) => (
            <View key={index} style={styles.infoCard}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIconBg}>
                  <MaterialIcons name={card.icon as any} size={20} color="#17263A" />
                </View>
                <Text style={styles.cardHeaderText}>{card.header}</Text>
              </View>

              {card.options.map((option, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.optionRow}
                  onPress={() => navigateTo(option.screen)}
                >
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

        <ReferralModal
          visible={referralModalVisible}
          onClose={() => setReferralModalVisible(false)}
          workerName={workerName}
          workerPhone={workerPhone}
        />

        <Modal visible={earningsModalVisible} transparent animationType="fade" onRequestClose={() => setEarningsModalVisible(false)}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setEarningsModalVisible(false)}>
            <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={styles.earningsModalCard}>
              <View style={styles.earningsHeader}>
                <Text style={styles.earningsTitle}>{t("earningBreakdown")}</Text>
                <TouchableOpacity onPress={() => setEarningsModalVisible(false)}>
                  <MaterialIcons name="close" size={24} color="#111827" />
                </TouchableOpacity>
              </View>

              <ScrollView style={styles.earningsContent} showsVerticalScrollIndicator={false}>
                <LinearGradient colors={["#27AE60", "#1E8449"]} style={styles.totalEarningsCard}>
                  <Text style={styles.totalEarningsLabel}>{t("totalEarnings")}</Text>
                  <Text style={styles.totalEarningsValue}>₹{totalEarnings}</Text>
                  <Text style={styles.totalEarningsSubtext}>
                    {totalEarnings > 0 ? tx("fromCompletedGigs", "From completed gigs") : tx("fromNoGigsYet", "From no gigs yet")}
                  </Text>
                </LinearGradient>

                <View style={styles.earningsItem}>
                  <View style={[styles.earningsIconBox, { backgroundColor: "#E8F5E9" }]}>
                    <MaterialIcons name="trending-up" size={22} color="#27AE60" />
                  </View>
                  <View style={styles.earningsItemContent}>
                    <Text style={styles.earningsItemLabel}>{t("gigEarnings")}</Text>
                    <Text style={styles.earningsItemValue}>₹{gigEarnings}</Text>
                  </View>
                </View>

                <View style={styles.earningsItem}>
                  <View style={[styles.earningsIconBox, { backgroundColor: "#FFF3E0" }]}>
                    <MaterialIcons name="assessment" size={22} color="#F39C12" />
                  </View>
                  <View style={styles.earningsItemContent}>
                    <Text style={styles.earningsItemLabel}>{tx("jobsEarned", "Jobs Earned")}</Text>
                    <Text style={styles.earningsItemValue}>₹{jobsEarnings}</Text>
                  </View>
                </View>

                <View style={styles.earningsItem}>
                  <View style={[styles.earningsIconBox, { backgroundColor: "#FCE4EC" }]}>
                    <MaterialIcons name="card-giftcard" size={22} color="#E91E63" />
                  </View>
                  <View style={styles.earningsItemContent}>
                    <Text style={styles.earningsItemLabel}>{t("referralBonus")}</Text>
                    <Text style={styles.earningsItemValue}>₹{referralBonus}</Text>
                  </View>
                </View>

                <View style={styles.earningsItem}>
                  <View style={[styles.earningsIconBox, { backgroundColor: "#FFEBEE" }]}>
                    <MaterialIcons name="trending-down" size={22} color="#E74C3C" />
                  </View>
                  <View style={styles.earningsItemContent}>
                    <Text style={styles.earningsItemLabel}>{t("deductions")}</Text>
                    <Text style={[styles.earningsItemValue, { color: "#E74C3C" }]}>-₹{totalDeductions}</Text>
                  </View>
                </View>

                <TouchableOpacity style={styles.withdrawButton}>
                  <MaterialIcons name="wallet" size={18} color="#fff" />
                  <Text style={styles.withdrawButtonText}>{tx("viewWithdrawalOptions", "View Withdrawal Options")}</Text>
                </TouchableOpacity>
              </ScrollView>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>

        <Modal visible={menuModalVisible} transparent animationType="fade" onRequestClose={() => setMenuModalVisible(false)}>
          <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setMenuModalVisible(false)}>
            <TouchableOpacity activeOpacity={1} onPress={(e) => e.stopPropagation()} style={styles.sheetCard}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetTitle}>{tx("updateProfile", "Update Profile")}</Text>
                <TouchableOpacity onPress={() => setMenuModalVisible(false)}>
                  <Ionicons name="close" size={24} color="#111827" />
                </TouchableOpacity>
              </View>

              <View style={styles.sheetBody}>
                <Text style={styles.fieldLabel}>{t("mainSkill")}</Text>
                <TouchableOpacity style={styles.pickerButton} onPress={() => setShowSkillMenu(!showSkillMenu)}>
                  <Text style={styles.pickerButtonText}>
                    {selectedSkill ? t(selectedSkill as keyof typeof import("../../../constants/translations").translations.en) : t("selectMainSkill")}
                  </Text>
                  <Ionicons name={showSkillMenu ? "chevron-up" : "chevron-down"} size={18} color="#4B5563" />
                </TouchableOpacity>
                {showSkillMenu && (
                  <View style={styles.pickerMenu}>
                    {MAIN_SKILLS.map((skill) => (
                      <TouchableOpacity key={skill} style={styles.pickerItem} onPress={() => { setSelectedSkill(skill); setShowSkillMenu(false); }}>
                        <Text style={styles.pickerButtonText}>{t(skill)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                <Text style={[styles.fieldLabel, { marginTop: 18 }]}>{tx("expectedWages", "Expected Wages")}</Text>
                <TouchableOpacity style={styles.pickerButton} onPress={() => setShowWageMenu(!showWageMenu)}>
                  <Text style={styles.pickerButtonText}>
                    {selectedWage ? wageLabelMap[selectedWage] : tx("selectWageRange", "Select Wage Range")}
                  </Text>
                  <Ionicons name={showWageMenu ? "chevron-up" : "chevron-down"} size={18} color="#4B5563" />
                </TouchableOpacity>
                {showWageMenu && (
                  <View style={styles.pickerMenu}>
                    {WAGE_RANGES.map((range) => (
                      <TouchableOpacity key={range.value} style={styles.pickerItem} onPress={() => { setSelectedWage(range.value); setShowWageMenu(false); }}>
                        <Text style={styles.pickerButtonText}>{t(WAGE_RANGE_KEYS[range.value])}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                <TouchableOpacity style={styles.primaryButton} onPress={handleSaveProfile}>
                  <Text style={styles.primaryButtonText}>{tx("saveChanges", "Save Changes")}</Text>
                </TouchableOpacity>
              </View>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      </ScrollView>
    </SafeAreaView>
  );
}
