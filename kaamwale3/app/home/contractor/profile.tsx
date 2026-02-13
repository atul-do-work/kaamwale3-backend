import React, { useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, Alert, Image, Platform , DimensionValue} from "react-native";
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
});

export default function ContractorProfile(): React.ReactElement {
  const { t } = useLanguage();
  const { accessToken, user: authUser, logout } = useAuth();
  const [userName, setUserName] = useState<string>("Contractor");
  const [contractorId, setContractorId] = useState<string>("0000");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [postedCount, setPostedCount] = useState(0);
  const [completedCount, setCompletedCount] = useState(0);
  const [inProgressCount, setInProgressCount] = useState(0);
  const router = useRouter();

  // Use configured API base

  const fetchJobStats = async (authToken: string) => {
    try {
      const res = await api.get(`/jobs`);
      const data = res.data;
      
      if (data && Array.isArray(data)) {
        const jobs = data;
        
        // Count statistics
        const posted = jobs.length;
        // ✅ FIXED: Completed = Jobs with paymentStatus === "Paid"
        const completed = jobs.filter((j: any) => j.paymentStatus === "Paid").length;
        // ✅ FIXED: In Progress = Jobs accepted but paymentStatus is NOT "Paid"
        const inProgress = jobs.filter((j: any) => j.acceptedBy && j.paymentStatus !== "Paid").length;

        setPostedCount(posted);
        setCompletedCount(completed);
        setInProgressCount(inProgress);
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
        }

        // Fetch wallet balance
        if (accessToken) {
          const res = await api.get(`/wallet`);
          const data = res.data;
          if (data && data.success) setWalletBalance(data.wallet?.balance || 0);

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

  const handleLogout = async () => {
    Alert.alert("Logout", "Are you sure you want to logout?", [
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
            console.error("Error logging out", err);
            // Even if cleanup fails, navigate to login
            router.replace("/");
          }
        },
      },
    ]);
  };

  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== "granted") {
      Alert.alert("Permission denied", "Camera roll permission is required.");
      return;
    }

    const result: any = await ImagePicker.launchImageLibraryAsync({
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });

    if (!result.canceled && result.assets?.length > 0) {
      const uri = result.assets[0].uri;
      
      // Save locally first
      setProfilePhoto(uri);
      await AsyncStorage.setItem("profilePhoto", uri);

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
              // ⚠️ Do NOT set Content-Type: multipart/form-data
              // The browser will set it automatically with the correct boundary
            },
            body: formData,
          });

          const data = await response.json();
          if (data.success) {
            // Update AsyncStorage with the backend URL
            await AsyncStorage.setItem("profilePhoto", data.profilePhoto);
            setProfilePhoto(data.profilePhoto);
            
            // Update user object in AsyncStorage
            const userStr = await AsyncStorage.getItem("user");
            if (userStr) {
              const user = JSON.parse(userStr);
              user.profilePhoto = data.profilePhoto;
              await AsyncStorage.setItem("user", JSON.stringify(user));
            }
            
            Alert.alert("Success", "Profile photo updated successfully");
          } else {
            Alert.alert("Error", data.message || "Failed to upload profile photo");
          }
        } catch (err) {
          console.error("Profile photo upload error:", err);
          Alert.alert("Error", "Failed to upload profile photo. Photo saved locally.");
        }
      }
    }
  };

  const navigateTo = (path: string | null) => {
    if (path) {
      router.push(path as any);
    }
  };

  const infoCards = [
    {
      header: "Job Manager",
      icon: "work-outline",
      color: "#667eea",
      options: [
        { name: "View Workers", icon: "people", screen: "/home/contractor/nearby-workers" },
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
    <SafeAreaView style={styles.container}>
      <ScrollView>
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
    </SafeAreaView>
  );
}
