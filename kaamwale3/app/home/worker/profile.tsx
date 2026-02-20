import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  Platform,
  Modal,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import styles from "../../../styles/WorkerProfileStyles";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useRouter, useFocusEffect } from "expo-router";
import axios from "axios";
import { API_BASE } from "../../../utils/config";
import { clearAllUserData } from "../../../utils/socket";
import ReferralModal from "../../../components/ReferralModal";
import { useLanguage } from "../../../context/LanguageContext";
import { useAuth } from "../../../context/AuthContext";

const MAIN_SKILLS = ['Labour', 'Mason', 'Engineer', 'ITI/Technician'];
const WAGE_RANGES = [
  { label: '₹400 to ₹550', value: '400-550' },
  { label: '₹550 to ₹700', value: '550-700' },
  { label: '₹700 to Max', value: '700-max' },
];

export default function Profile(): React.ReactElement {
  const { t } = useLanguage();
  const { logout } = useAuth();
  const insets = useSafeAreaInsets();
  const [userName, setUserName] = useState<string>("Worker");
  const [workerId, setWorkerId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [referralModalVisible, setReferralModalVisible] = useState(false);
  const [earningsModalVisible, setEarningsModalVisible] = useState(false);
  const [workerName, setWorkerName] = useState<string>("");
  const [workerPhone, setWorkerPhone] = useState<string>("");
  const [totalEarnings, setTotalEarnings] = useState(0); // ✅ From backend
  const [gigEarnings, setGigEarnings] = useState(0); // ✅ Earned from gigs
  const [jobsEarnings, setJobsEarnings] = useState(0); // ✅ Earned from jobs/pending
  const [totalDeductions, setTotalDeductions] = useState(0); // ✅ From backend
  const [referralBonus, setReferralBonus] = useState(0); // ✅ From backend
  const [userToken, setUserToken] = useState<string>("");
  const [workerRating, setWorkerRating] = useState<number>(0); // ✅ Average rating
  const [totalReviews, setTotalReviews] = useState<number>(0); // ✅ Number of ratings
  
  // Menu states
  const [showMenu, setShowMenu] = useState(false);
  const [showSkillMenu, setShowSkillMenu] = useState(false);
  const [showWageMenu, setShowWageMenu] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<string>("");
  const [selectedWage, setSelectedWage] = useState<string>("");
  const [menuModalVisible, setMenuModalVisible] = useState(false);
  
  const router = useRouter();

  // Use central API base

  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const profileStr = await AsyncStorage.getItem("profilePhoto");
        const token = await AsyncStorage.getItem("token");

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

  // ✅ Reload profile photo and rating when screen is focused (instant update after photo selection or rating received)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const profileStr = await AsyncStorage.getItem("profilePhoto");
        if (profileStr) setProfilePhoto(profileStr);
        
        // ✅ Fetch fresh rating data when screen comes into focus
        await fetchWorkerRating();
      })();
    }, [])
  );

  // ✅ Fetch worker's average rating and review count
  const fetchWorkerRating = async () => {
    try {
      const token = await AsyncStorage.getItem("token");
      if (!token) return;

      const response = await fetch(`${API_BASE}/worker/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.worker) {
          setWorkerRating(data.worker.performanceMetrics?.averageRating || data.worker.rating || 0);
          setTotalReviews(data.worker.performanceMetrics?.totalReviews || 0);
          console.log(`⭐ Worker rating fetched: ${data.worker.performanceMetrics?.averageRating}/5 (${data.worker.performanceMetrics?.totalReviews} reviews)`);
        }
      }
    } catch (err) {
      console.error('Error fetching worker rating:', err);
    }
  };

  // ✅ Fetch earnings data when modal is opened
  const fetchEarningsData = async () => {
    try {
      const token = await AsyncStorage.getItem("token");
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
        
        // You can also set deductions here if available from backend
        console.log('✅ Earnings fetched:', data.earnings);
      }
    } catch (err) {
      console.error('Error fetching earnings:', err);
    }
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        t('warning'),
        "Camera roll permission is required to select a profile photo."
      );
      return;
    }

    const result: any = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });

    if (!result.canceled && result.assets?.length > 0) {
      const uri = result.assets[0].uri;

      // Show local image immediately
      setProfilePhoto(uri);

      try {
        const userToken = await AsyncStorage.getItem("token");
        if (!userToken) {
          Alert.alert(t('error'), t('photoUploadError'));
          return;
        }

        const formData = new FormData();
        formData.append("photo", {
          uri: uri,
          name: `profile-${workerId}-${Date.now()}.jpg`,
          type: "image/jpeg",
        } as any);

        console.log("📤 Uploading profile photo to:", `${API_BASE}/users/photo`);
        console.log("📤 Token present:", !!userToken);
        
        const response = await axios.post(`${API_BASE}/users/photo`, formData, {
          timeout: 30000, // 30 second timeout
          headers: {
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "multipart/form-data",
          },
        });

        console.log("✅ Upload response:", response.data);

        if (response.data.success && response.data.profilePhoto) {
          console.log("✅ Saving profile photo URL:", response.data.profilePhoto);
          setProfilePhoto(response.data.profilePhoto);
          await AsyncStorage.setItem("profilePhoto", response.data.profilePhoto);
          Alert.alert(t('success'), t('profilePhotoUpdated'));
        } else {
          console.log("❌ Invalid response:", response.data);
          Alert.alert(t('error'), t('serverError'));
          const savedPhoto = await AsyncStorage.getItem("profilePhoto");
          if (savedPhoto) setProfilePhoto(savedPhoto);
        }
      } catch (err: any) {
        console.error("❌ Profile photo upload error:", err);
        console.error("❌ Error response:", err.response?.data);
        console.error("❌ Error status:", err.response?.status);
        console.error("❌ Error message:", err.message);
        
        Alert.alert(
          t('error'),
          err?.response?.data?.message || err.message || t('photoUploadError')
        );
        
        // Revert to previously saved photo
        const savedPhoto = await AsyncStorage.getItem("profilePhoto");
        if (savedPhoto) setProfilePhoto(savedPhoto);
        else setProfilePhoto(null);
      }
    }
  };

  const handleLogout = async () => {
    Alert.alert(t('logout'), t('confirmLogout'), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout",
        style: "destructive",
        onPress: async () => {
          try {
            // ✅ Clear socket state
            await clearAllUserData();
            // ✅ Clear AuthContext state (CRITICAL - this clears AsyncStorage and state)
            await logout();
            router.replace("/");
          } catch (err) {
            console.error("Failed to logout", err);
            // Even if cleanup fails, navigate to login
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
      Alert.alert(t('error'), t('selectSkillWage'));
      return;
    }

    try {
      const response = await axios.post(
        `${API_BASE}/users/update-profile`,
        {
          mainSkill: selectedSkill,
          expectedWage: selectedWage,
        },
        {
          headers: {
            Authorization: `Bearer ${userToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data.success) {
        // Update local storage
        const userStr = await AsyncStorage.getItem("user");
        if (userStr) {
          const user = JSON.parse(userStr);
          user.mainSkill = selectedSkill;
          user.expectedWage = selectedWage;
          await AsyncStorage.setItem("user", JSON.stringify(user));
        }
        
        Alert.alert(t('success'), t('profileUpdated'));
        setMenuModalVisible(false);
        setShowMenu(false);
      }
    } catch (err: any) {
      console.error("Profile update error:", err);
      Alert.alert(t('error'), err?.response?.data?.message || t('failedUpdateProfile'));
    }
  };

  const infoCards = [
    {
      header: "Support",
      icon: "support-agent",
      options: [
        { name: "Help Centre", screen: "/HelpCentre" },
        { name: "Support Ticket", screen: "/SupportTickets" },
      ],
    },
    {
      header: "Documents & Policies",
      icon: "description",
      options: [
        { name: "Aadhar Card & 90-Day Policy", screen: "/DocumentsAndPolicies" },
      ],
    },
    {
      header: "Partner Options",
      icon: "handshake",
      options: [
        { name: "Videos & Tutorials", screen: "/VideosAndTutorials" },
      ],
    },
  ];

  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f5", paddingTop: insets.top }}>
      <ScrollView style={styles.container}>
        {/* Header with Three-Dot Menu */}
        <View style={{ position: 'relative' }}>
          <TouchableOpacity 
            style={styles.menuButton}
            onPress={() => setMenuModalVisible(true)}
          >
            <MaterialIcons name="more-vert" size={28} color="#1a2f4d" />
          </TouchableOpacity>

          <LinearGradient
            colors={["#1a2f4d", "#1a2f4d"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.headerContainer}
          >
            <TouchableOpacity onPress={pickImage} style={styles.profileIcon}>
              {profilePhoto ? (
                <Image source={{ uri: profilePhoto }} style={styles.profilePhoto} />
              ) : (
                <MaterialIcons name="person" size={60} color="#fff" />
              )}
            </TouchableOpacity>

            <View style={styles.profileInfo}>
              <Text style={styles.nameText}>{userName}</Text>
              <Text style={styles.workerId}>Worker ID: {workerId}</Text>
              <Text style={styles.ratingText}>Rating: {workerRating.toFixed(1)} ⭐ ({totalReviews} reviews)</Text>
            </View>
          </LinearGradient>
        </View>

        <View style={styles.cardsRow}>
        {[
          { title: "Gig History", icon: "history", route: "/GigHistory" },
          { title: "Earnings", icon: "attach-money", action: () => {
            fetchEarningsData(); // ✅ Fetch fresh earnings when clicking
            setEarningsModalVisible(true);
          } },
          { title: "Settings", icon: "settings", route: "/Settings" },
        ].map((card, index) => (
          <TouchableOpacity
            key={index}
            style={styles.profileCard}
            onPress={() => {
              if ('route' in card) {
                router.push(card.route as any);
              } else if ('action' in card) {
                (card.action as () => void)();
              }
            }}
          >
            <MaterialIcons name={card.icon as any} size={28} color="#1a2f4d" />
            <Text style={styles.cardTitle}>{card.title}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity 
        style={styles.referralContainer}
        onPress={() => setReferralModalVisible(true)}
        activeOpacity={0.7}
      >
        <View>
          <Text style={styles.referralHeading}>Referral Bonus</Text>
          <Text style={styles.referralText}>You have earned ₹50 from referrals</Text>
        </View>
        <MaterialIcons name="card-giftcard" size={40} color="#1a2f4d" />
      </TouchableOpacity>

      {infoCards.map((card, index) => (
        <View key={index} style={styles.supportContainer}>
          <View style={styles.headerWithIcon}>
            <MaterialIcons name={card.icon as any} size={24} color="#1a2f4d" />
            <Text style={styles.supportHeader}>{card.header}</Text>
          </View>

          {card.options.map((option, idx) => (
            <TouchableOpacity
              key={idx}
              style={styles.supportOption}
              onPress={() => navigateTo(option.screen)}
            >
              <Text style={styles.supportText}>{option.name}</Text>
              <MaterialIcons name="keyboard-arrow-right" size={24} color="#1a2f4d" />
            </TouchableOpacity>
          ))}
        </View>
      ))}

        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
        <MaterialIcons name="logout" size={22} color="#fff" />
        <Text style={styles.logoutText}>Logout</Text>
      </TouchableOpacity>

        <ReferralModal
          visible={referralModalVisible}
          onClose={() => setReferralModalVisible(false)}
          workerName={workerName}
          workerPhone={workerPhone}
        />

        {/* Earnings Modal */}
        <TouchableOpacity
          style={[styles.modalBackdrop, earningsModalVisible && styles.modalBackdropActive]}
          activeOpacity={1}
          onPress={() => setEarningsModalVisible(false)}
        >
        <View style={[styles.earningsModal, earningsModalVisible && { opacity: 1 }]}>
          <View style={styles.earningsHeader}>
            <Text style={styles.earningsTitle}>Earnings Breakdown</Text>
            <TouchableOpacity onPress={() => setEarningsModalVisible(false)}>
              <MaterialIcons name="close" size={28} color="#fff" />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.earningsContent} showsVerticalScrollIndicator={false}>
            {/* Total Earnings Card */}
            <LinearGradient
              colors={["#27AE60", "#1E8449"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.totalEarningsCard}
            >
              <Text style={styles.totalEarningsLabel}>Total Earnings</Text>
              <Text style={styles.totalEarningsValue}>₹{totalEarnings}</Text>
              <Text style={styles.totalEarningsSubtext}>From {totalEarnings > 0 ? 'completed gigs' : 'no gigs yet'}</Text>
            </LinearGradient>

            {/* Earnings Breakdown */}
            <View style={styles.earningsBreakdown}>
              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#E8F5E9" }]}>
                  <MaterialIcons name="trending-up" size={24} color="#27AE60" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Gig Earnings</Text>
                  <Text style={styles.earningsItemValue}>₹{gigEarnings}</Text>
                </View>
              </View>

              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#FFF3E0" }]}>
                  <MaterialIcons name="assessment" size={24} color="#F39C12" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Jobs Earned</Text>
                  <Text style={styles.earningsItemValue}>₹{jobsEarnings}</Text>
                </View>
              </View>

              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#FCE4EC" }]}>
                  <MaterialIcons name="card-giftcard" size={24} color="#E91E63" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Referral Bonus</Text>
                  <Text style={styles.earningsItemValue}>₹{referralBonus}</Text>
                </View>
              </View>

              <View style={[styles.earningsItem, { borderBottomWidth: 0 }]}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#FFEBEE" }]}>
                  <MaterialIcons name="trending-down" size={24} color="#E74C3C" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Deductions</Text>
                  <Text style={[styles.earningsItemValue, { color: "#E74C3C" }]}>-₹{totalDeductions}</Text>
                </View>
              </View>
            </View>

            {/* Net Earnings - Removed Available Balance Section */}
            <TouchableOpacity style={styles.withdrawButton}>
              <MaterialIcons name="wallet" size={20} color="#fff" />
              <Text style={styles.withdrawButtonText}>View Withdrawal Options</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
        </TouchableOpacity>

        {/* Skill & Wage Selection Modal */}
        <Modal visible={menuModalVisible} transparent animationType="fade">
        <TouchableOpacity 
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }}
          onPress={() => setMenuModalVisible(false)}
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
              {/* Modal Header */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#1a2f4d' }}>Update Profile</Text>
                <TouchableOpacity onPress={() => setMenuModalVisible(false)}>
                  <Ionicons name="close" size={26} color="#1a2f4d" />
                </TouchableOpacity>
              </View>

              {/* Main Skill Dropdown */}
              <View style={{ marginBottom: 18 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a2f4d', marginBottom: 8 }}>Main Skill</Text>
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
                  onPress={() => setShowSkillMenu(!showSkillMenu)}
                >
                  <Text style={{ color: selectedSkill ? '#1a2f4d' : '#999', fontSize: 14 }}>
                    {selectedSkill || 'Select Main Skill'}
                  </Text>
                  <Ionicons name={showSkillMenu ? 'chevron-up' : 'chevron-down'} size={20} color="#1a2f4d" />
                </TouchableOpacity>

                {showSkillMenu && (
                  <View style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderTopWidth: 0,
                    borderBottomLeftRadius: 10,
                    borderBottomRightRadius: 10,
                    backgroundColor: '#f0f0f0',
                    marginTop: -1,
                  }}>
                    {MAIN_SKILLS.map((skill) => (
                      <TouchableOpacity 
                        key={skill}
                        style={{ paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' }}
                        onPress={() => { setSelectedSkill(skill); setShowSkillMenu(false); }}
                      >
                        <Text style={{ color: '#1a2f4d', fontSize: 14 }}>{skill}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>

              {/* Expected Wages Dropdown */}
              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a2f4d', marginBottom: 8 }}>Expected Wages</Text>
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
                  onPress={() => setShowWageMenu(!showWageMenu)}
                >
                  <Text style={{ color: selectedWage ? '#1a2f4d' : '#999', fontSize: 14 }}>
                    {selectedWage ? WAGE_RANGES.find(w => w.value === selectedWage)?.label : 'Select Wage Range'}
                  </Text>
                  <Ionicons name={showWageMenu ? 'chevron-up' : 'chevron-down'} size={20} color="#1a2f4d" />
                </TouchableOpacity>

                {showWageMenu && (
                  <View style={{ 
                    borderWidth: 1, 
                    borderColor: '#ddd', 
                    borderTopWidth: 0,
                    borderBottomLeftRadius: 10,
                    borderBottomRightRadius: 10,
                    backgroundColor: '#f0f0f0',
                    marginTop: -1,
                  }}>
                    {WAGE_RANGES.map((range) => (
                      <TouchableOpacity 
                        key={range.value}
                        style={{ paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#eee' }}
                        onPress={() => { setSelectedWage(range.value); setShowWageMenu(false); }}
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
                  backgroundColor: '#1a2f4d', 
                  borderRadius: 10, 
                  paddingVertical: 14,
                  alignItems: 'center',
                }}
                onPress={handleSaveProfile}
              >
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Save Changes</Text>
              </TouchableOpacity>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
        </Modal>
      </ScrollView>
    </View>
  );
}
