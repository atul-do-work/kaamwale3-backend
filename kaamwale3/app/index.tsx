import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StatusBar,
  Alert,
  ActivityIndicator,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from '../utils/config';
import { useRouter } from "expo-router";
import * as Location from 'expo-location';
import styles from "../styles/LoginScreenStyles";
//*******************2nd step */

export default function LoginScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!phone || !password) {
      Alert.alert("Missing Details", "Please enter phone and password");
      return;
    }

    setLoading(true);

    try {
      // ✅ NEW: Request location permission and get coordinates
      let latitude = null;
      let longitude = null;

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const location = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
          latitude = location.coords.latitude;
          longitude = location.coords.longitude;
          console.log('📍 Location obtained:', { latitude, longitude });
        } else {
          console.warn('⚠️ Location permission denied');
        }
      } catch (locError) {
        console.warn('⚠️ Could not get location:', (locError as Error).message);
      }

      const response = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          password,
          latitude,
          longitude,
        }),
      });

      const data = await response.json();

      if (!data.success) {
        Alert.alert("Login Failed", data.message || "Invalid credentials");
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
      // backend returns accessToken and refreshToken; keep legacy 'token' key for compatibility
      const accessToken = data.accessToken || data.token || null;
      const refreshToken = data.refreshToken || null;

      if (accessToken) {
        await AsyncStorage.setItem("accessToken", accessToken);
        // keep the legacy 'token' key for older code paths
        await AsyncStorage.setItem("token", accessToken);
      }

      if (refreshToken) {
        await AsyncStorage.setItem("refreshToken", refreshToken);
      }

      await AsyncStorage.setItem("user", JSON.stringify(data.user)); // save user object
      
      console.log(`✅ Login successful for ${data.user.role}: ${data.user.phone}`);

      Alert.alert("Success", `Logged in as ${data.user.role}`);

      // ------------------------
      //  NAVIGATION BASED ON ROLE
      // ------------------------
      console.log(`🚀 [Login] Navigating to /home after login`);
      // Navigate to /home which will then redirect to /home/worker or /home/contractor
      // Don't navigate directly - let home/index.tsx handle the role-based routing
      router.replace("/home");
    } catch (error) {
      console.error("Login error:", error);
      Alert.alert("Error", (error as Error).message || "Server not responding");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>Welcome Back</Text>
      <Text style={styles.subtitle}>Login to your account</Text>

      <TextInput
        style={styles.input}
        placeholder="Phone Number"
        keyboardType="phone-pad"
        value={phone}
        onChangeText={setPhone}
        placeholderTextColor="#888"
      />

      <View style={styles.passwordContainer}>
        <TextInput
          style={styles.passwordInput}
          placeholder="Password"
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
          <Text style={styles.buttonText}>Login</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.registerButton}
        onPress={() => router.push("/register")}
      >
        <Text style={styles.registerText}>
          Don't have an account? Register
        </Text>
      </TouchableOpacity>
    </View>
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




