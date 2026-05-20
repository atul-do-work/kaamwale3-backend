import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Modal,
  ActivityIndicator,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from '../utils/config';
import { useRouter } from "expo-router";
import { locationPermissionHandler } from '../services/locationPermissionHandler';
import styles from "../styles/LoginScreenStyles";
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import { SafeAreaView } from 'react-native-safe-area-context';
//*******************2nd step */

// ✅ HELPER: Validate password strength
function validatePasswordStrength(password: string): { isValid: boolean; error?: string } {
  if (!password || password.length < 8) {
    return { isValid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/\d/.test(password)) {
    return { isValid: false, error: 'Password must contain at least one number' };
  }
  if (!/[A-Z]/.test(password)) {
    return { isValid: false, error: 'Password must contain at least one uppercase letter' };
  }
  if (!/[a-z]/.test(password)) {
    return { isValid: false, error: 'Password must contain at least one lowercase letter' };
  }
  return { isValid: true };
}

// ✅ HELPER: Request location with retries (improved version)
async function getLocationWithRetries(maxRetries = 3) {
  // ✅ OPTIMIZATION: Check if we have recent location (< 24 hours old) from registration
  const LOCATION_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
  
  try {
    const cached = await AsyncStorage.getItem('lastKnownLocation');
    if (cached) {
      const { latitude, longitude, timestamp } = JSON.parse(cached);
      const ageMs = Date.now() - (timestamp || 0);
      
      if (ageMs < LOCATION_CACHE_MS) {
        const ageSeconds = Math.round(ageMs / 1000);
        console.log(`✅ Using cached location from ${ageSeconds}s ago (no fresh GPS needed) 📍`);
        return { latitude, longitude };
      } else {
        const ageHours = Math.round(ageMs / 3600000);
        console.log(`⏰ Cached location is ${ageHours}h old, requesting fresh location...`);
      }
    }
  } catch (err) {
    console.warn('⚠️ Could not check cached location:', err);
  }

  // ✅ No recent cached location - request permission and current position through shared handler
  const locationResult = await locationPermissionHandler.getLocation();
  if (locationResult.success && locationResult.location) {
    const latitude = locationResult.location.latitude;
    const longitude = locationResult.location.longitude;

    try {
      await AsyncStorage.setItem('lastKnownLocation', JSON.stringify({
        latitude,
        longitude,
        timestamp: Date.now(),
      }));
      console.log('💾 Location cached for future logins (24h TTL)');
    } catch (cacheErr) {
      console.warn('⚠️ Could not cache location:', cacheErr);
    }

    return { latitude, longitude };
  }

  console.warn('❌ Location request failed:', locationResult.error);
  return { latitude: null, longitude: null };
}

export default function LoginScreen() {
  const router = useRouter();
  const { t } = useLanguage();
  const { saveTokens, accessToken, user, loading: authLoading } = useAuth();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  
  // ✅ Modal state for alerts
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<"success" | "error" | "info">("success");
  
  const showModal = (type: "success" | "error" | "info", title: string, message: string) => {
    setModalType(type);
    setModalTitle(title);
    setModalMessage(message);
    setModalVisible(true);
  };

  // ✅ FIX: Check if user is already logged in when screen mounts
  useEffect(() => {
    if (!authLoading && accessToken && user) {
      console.log('✅ [Login] User already logged in, redirecting to /home');
      router.replace('/home');
    }
  }, [accessToken, user, authLoading, router]);

  const handleLogin = async () => {
    if (!phone || !password) {
      showModal('error', t('required'), t('required'));
      return;
    }

    // ✅ Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      showModal('error', t('error'), passwordValidation.error || 'Invalid password');
      return;
    }

    // Validate phone (10 digits)
    const phoneTrim = phone.trim();
    if (!/^\d{10}$/.test(phoneTrim)) {
      showModal('error', t('invalidPhone'), t('invalidPhone'));
      return;
    }

    setLoading(true);

    try {
      // ✅ NEW: Get fresh FCM token for push notifications
      let fcmToken = null;
      try {
        fcmToken = await AsyncStorage.getItem('appFcmToken');
        if (fcmToken) {
          console.log('✅ FCM Token obtained from storage:', fcmToken.substring(0, 30) + '...');
        } else {
          console.warn('⚠️ FCM token not available');
        }
      } catch (err) {
        console.warn('⚠️ Could not get FCM token:', (err as Error).message);
      }

      // ✅ Try to fetch location before login so backend can save city/state immediately
      let latitude = null;
      let longitude = null;
      let locationProvidedOnLogin = false;
      try {
        const locationData = await getLocationWithRetries(2);
        if (locationData.latitude !== null && locationData.longitude !== null) {
          latitude = locationData.latitude;
          longitude = locationData.longitude;
          locationProvidedOnLogin = true;
          console.log(`📍 Sending location in login request: lat=${latitude}, lon=${longitude}`);
        } else {
          console.log('⚠️ Location not available for login request');
        }
      } catch (locErr) {
        console.warn('⚠️ Could not fetch location before login:', (locErr as Error).message);
      }

      const response = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            phone: phoneTrim,
            password,
            latitude,
            longitude,
            fcmToken,
          }),
      });

      const data = await response.json();

      if (!data.success) {
        showModal('error', "Login Failed", data.message || "Invalid credentials");
        setLoading(false);
        return;
      }

      // ✅ NEW: Save leaderboard data if contractor
      if (data.leaderboard) {
        await AsyncStorage.setItem("leaderboard", JSON.stringify(data.leaderboard));
        await AsyncStorage.setItem("myRank", data.leaderboard.myRank?.toString() || "0");
        await AsyncStorage.setItem("myScore", data.leaderboard.myScore?.toString() || "0");
      }

      // ------------------------
      //  SAVE TOKENS + USER (only when present)
      // ------------------------
      const accessToken = data.accessToken || data.token || null;
      const refreshToken = data.refreshToken || null;

      await AsyncStorage.setItem("user", JSON.stringify(data.user)); // save user object
      await AsyncStorage.setItem("locationProvidedOnLogin", locationProvidedOnLogin ? "true" : "false");
      
      // ✅ Store tokens securely and update AuthContext state
      await saveTokens(accessToken, refreshToken, data.user);
      
      console.log(`✅ Login successful for ${data.user.role}: ${data.user.phone}`);

      showModal('success', t('success'), `Logged in as ${data.user.role}`);

      // " + "------------------------
      //  NAVIGATION BASED ON ROLE
      // " + "------------------------
      console.log(`🚀 [Login] Navigating to /home after login`);
      // Navigate to /home which will then redirect to /home/worker or /home/contractor
      // Don't navigate directly - let home/index.tsx handle the role-based routing
      router.replace("/home");
    } catch (error) {
      console.error("Login error:", error);
      showModal('error', t('error'), (error as Error).message || "Server not responding");
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>{t('login')}</Text>
      <Text style={styles.subtitle}>{t('login')} to your account</Text>

      <TextInput
        style={styles.input}
        placeholder={t('phone')}
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
        placeholderTextColor="#888"
      />

      <View style={styles.passwordContainer}>
        <TextInput
          style={styles.passwordInput}
          placeholder={t('password')}
          secureTextEntry={!passwordVisible}
          value={password}
          onChangeText={setPassword}
          placeholderTextColor="#888"
        />
        <TouchableOpacity
          style={styles.passwordToggle}
          onPress={() => setPasswordVisible(!passwordVisible)}
        >
          <MaterialIcons
            name={passwordVisible ? "visibility" : "visibility-off"}
            size={22}
            color="#666"
          />
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
        {loading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{t('login')}</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.forgotPasswordButton}
        onPress={() => router.push("/forgot-password")}
      >
        <Text style={styles.forgotPasswordText}>Forgot Password?</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.registerButton}
        onPress={() => router.push("/register")}
      >
        <Text style={styles.registerText}>
          Don't have an account? {t('register')}
        </Text>
      </TouchableOpacity>

      {/* ✅ Custom Alert Modal */}
      <Modal
        transparent={true}
        animationType="fade"
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            {/* Modal Header with Icon */}
            <View style={[
              styles.modalHeader,
              {
                backgroundColor: modalType === "success" ? "#10B98120" : modalType === "error" ? "#EF444420" : "#3B82F620",
              }
            ]}>
              <View style={[
                styles.modalIconBg,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}>
                <MaterialIcons
                  name={
                    modalType === "success" ? "check-circle" :
                    modalType === "error" ? "error" :
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

            {/* Modal Footer - OK Button */}
            <TouchableOpacity
              style={[
                styles.modalButton,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}


// for login firebase Login.tsx

// import React, { useState } from "react";
// import {
//   View,
//   Text,
//   TextInput,
//   TouchableOpacity,
//   StatusBar,
//   Alert,
//   ActivityIndicator,
// } from "react-native";
// import AsyncStorage from "@react-native-async-storage/async-storage";
// import { useRouter } from "expo-router";
// import styles from "../styles/LoginScreenStyles";

// import { auth, db } from "../firebase/firebaseConfig";
// import { signInWithEmailAndPassword } from "firebase/auth";
// import { ref, get } from "firebase/database";

// // ---------------------
// // USER TYPE
// // ---------------------
// type UserType = {
//   name: string;
//   phone: string;
//   role: "worker" | "contractor";
//   profilePhoto?: string;
//   walletBalance?: number;
// };

// export default function LoginScreen() {
//   const router = useRouter();
//   const [phone, setPhone] = useState("");
//   const [password, setPassword] = useState("");
//   const [loading, setLoading] = useState(false);

//   const handleLogin = async () => {
//     if (!phone.trim() || !password.trim()) {
//       Alert.alert("Missing Details", "Please enter phone and password");
//       return;
//     }

//     setLoading(true);
//     try {
//       const email = `${phone}@kaamwale.com`;

//       // 1️⃣ Authenticate user
//       const userCredential = await signInWithEmailAndPassword(auth, email, password);
//       const user = userCredential.user;

//       // 2️⃣ Fetch extra info from Realtime DB
//       const snapshot = await get(ref(db, `users/${user.uid}`));
//       const userData = snapshot.val() as UserType;

//       if (!userData) {
//         Alert.alert("Login Failed", "User data not found");
//         setLoading(false);
//         return;
//       }

//       await AsyncStorage.setItem("user", JSON.stringify({ uid: user.uid, ...userData }));
//       Alert.alert("Success", `Logged in as ${userData.role}`);

//       if (userData.role === "worker") {
//         router.replace("/home/worker");
//       } else {
//         router.replace("/home/contractor");
//       }

//       setLoading(false);
//     } catch (error: any) {
//       Alert.alert("Login Failed", error.message);
//       setLoading(false);
//     }
//   };

//   return (
//     <View style={styles.container}>
//       <StatusBar barStyle="light-content" />
//       <Text style={styles.title}>Welcome Back</Text>
//       <Text style={styles.subtitle}>Login to your account</Text>

//       <TextInput
//         style={styles.input}
//         placeholder="Phone Number"
//         keyboardType="phone-pad"
//         value={phone}
//         onChangeText={setPhone}
//         placeholderTextColor="#888"
//       />

//       <TextInput
//         style={styles.input}
//         placeholder="Password"
//         secureTextEntry
//         value={password}
//         onChangeText={setPassword}
//         placeholderTextColor="#888"
//       />

//       <TouchableOpacity style={styles.loginButton} onPress={handleLogin}>
//         {loading ? (
//           <ActivityIndicator size="small" color="#fff" />
//         ) : (
//           <Text style={styles.buttonText}>Login</Text>
//         )}
//       </TouchableOpacity>

//       <TouchableOpacity
//         style={styles.registerButton}
//         onPress={() => router.push("/register")}
//       >
//         <Text style={styles.registerText}>
//           Don't have an account? Register
//         </Text>
//       </TouchableOpacity>
//     </View>
//   );
// }




