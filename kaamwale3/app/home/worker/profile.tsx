import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Alert,
  Image,
  Platform,
  SafeAreaView,
  Modal,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import styles from "../../../styles/WorkerProfileStyles";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import axios from "axios";
import { API_BASE } from "../../../utils/config";
import { clearAllUserData } from "../../../utils/socket";
import ReferralModal from "../../../components/ReferralModal";

const MAIN_SKILLS = ['Labour', 'Mason', 'Engineer', 'ITI/Technician'];
const WAGE_RANGES = [
  { label: 'Min to ₹400', value: '0-400' },
  { label: '₹400 to ₹550', value: '400-550' },
  { label: '₹550 to ₹700', value: '550-700' },
  { label: '₹700 to Max', value: '700-max' },
];

export default function Profile(): React.ReactElement {
  const [userName, setUserName] = useState<string>("Worker");
  const [workerId, setWorkerId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [referralModalVisible, setReferralModalVisible] = useState(false);
  const [earningsModalVisible, setEarningsModalVisible] = useState(false);
  const [workerName, setWorkerName] = useState<string>("");
  const [workerPhone, setWorkerPhone] = useState<string>("");
  const [totalEarnings, setTotalEarnings] = useState(2450);
  const [totalDeductions, setTotalDeductions] = useState(245);
  const [totalBonus, setTotalBonus] = useState(500);
  const [referralBonus, setReferralBonus] = useState(500);
  const [userToken, setUserToken] = useState<string>("");
  
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
        }

        if (profileStr) setProfilePhoto(profileStr);
        if (token) setUserToken(token);
      } catch (err) {
        console.error("Failed to load user/profile photo", err);
      }
    })();
  }, []);

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert(
        "Permission denied",
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
          Alert.alert("Error", "No auth token found");
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
          Alert.alert("Success", "Profile photo updated!");
        } else {
          console.log("❌ Invalid response:", response.data);
          Alert.alert("Error", "Server returned invalid response");
          const savedPhoto = await AsyncStorage.getItem("profilePhoto");
          if (savedPhoto) setProfilePhoto(savedPhoto);
        }
      } catch (err: any) {
        console.error("❌ Profile photo upload error:", err);
        console.error("❌ Error response:", err.response?.data);
        console.error("❌ Error status:", err.response?.status);
        console.error("❌ Error message:", err.message);
        
        Alert.alert(
          "Upload failed",
          err?.response?.data?.message || err.message || "Could not upload profile photo. Please check your internet connection and try again."
        );
        
        // Revert to previously saved photo
        const savedPhoto = await AsyncStorage.getItem("profilePhoto");
        if (savedPhoto) setProfilePhoto(savedPhoto);
        else setProfilePhoto(null);
      }
    }
  };

  const handleLogout = async () => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Logout",
        style: "destructive",
        onPress: async () => {
          try {
            // ✅ Comprehensive cleanup including socket
            await clearAllUserData();
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
      Alert.alert("Error", "Please select both skill and wage range");
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
        
        Alert.alert("Success", "Profile updated successfully!");
        setMenuModalVisible(false);
        setShowMenu(false);
      }
    } catch (err: any) {
      console.error("Profile update error:", err);
      Alert.alert("Error", err?.response?.data?.message || "Failed to update profile");
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
    <SafeAreaView style={{ flex: 1, backgroundColor: "#f5f5f5" }}>
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
              <Text style={styles.ratingText}>Rating: 4.5 ⭐</Text>
            </View>
          </LinearGradient>
        </View>

        <View style={styles.cardsRow}>
        {[
          { title: "Gig History", icon: "history", route: "/GigHistory" },
          { title: "Earnings", icon: "attach-money", action: () => setEarningsModalVisible(true) },
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
              <Text style={styles.totalEarningsSubtext}>From {15} completed gigs</Text>
            </LinearGradient>

            {/* Earnings Breakdown */}
            <View style={styles.earningsBreakdown}>
              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#E8F5E9" }]}>
                  <MaterialIcons name="trending-up" size={24} color="#27AE60" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Gig Earnings</Text>
                  <Text style={styles.earningsItemValue}>₹{2450}</Text>
                </View>
              </View>

              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#FFF3E0" }]}>
                  <MaterialIcons name="card-giftcard" size={24} color="#F39C12" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Referral Bonus</Text>
                  <Text style={styles.earningsItemValue}>₹{referralBonus}</Text>
                </View>
              </View>

              <View style={styles.earningsItem}>
                <View style={[styles.earningsIconBox, { backgroundColor: "#F3E5F5" }]}>
                  <MaterialIcons name="card-membership" size={24} color="#9C27B0" />
                </View>
                <View style={styles.earningsItemContent}>
                  <Text style={styles.earningsItemLabel}>Bonus</Text>
                  <Text style={styles.earningsItemValue}>₹{totalBonus}</Text>
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

            {/* Net Earnings */}
            <View style={styles.netEarningsCard}>
              <Text style={styles.netEarningsLabel}>Available Balance</Text>
              <Text style={styles.netEarningsValue}>₹{totalEarnings + totalBonus + referralBonus - totalDeductions}</Text>
              <TouchableOpacity style={styles.withdrawButton}>
                <MaterialIcons name="wallet" size={20} color="#fff" />
                <Text style={styles.withdrawButtonText}>Withdraw to Wallet</Text>
              </TouchableOpacity>
            </View>
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
    </SafeAreaView>
  );
}
