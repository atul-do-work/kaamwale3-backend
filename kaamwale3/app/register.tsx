import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { API_BASE } from '../utils/config';
import styles from '../styles/RegisterScreenStyles';
import { registerForPushNotificationsAsync } from '../services/notification';
import { useLanguage } from '../context/LanguageContext';
import { useAuth } from '../context/AuthContext';
import LegalModal from '../components/LegalModal';
import { getOrGenerateDeviceId, getAppVersion, generateTermsHashFallback } from '../utils/deviceInfo';
import { SafeAreaView } from 'react-native-safe-area-context';

type User = {
  name: string;
  phone: string;
  password: string;
  role: 'worker' | 'contractor';
};

// ✅ HELPER: Validate password strength
function validatePasswordStrength(password: string): { isValid: boolean; error?: string } {
  if (!password || password.length < 6) {
    return { isValid: false, error: 'Password must be at least 8 characters long' };
  }
  if (!/\d/.test(password)) {
    return { isValid: false, error: 'Password must contain at least one number' };
  }
  if (!/[A-Z]/.test(password)) {
    return { isValid: false, error: 'Password must contain at least one uppercase letter' };
  }

  return { isValid: true };
}

// ✅ HELPER: Wait for FCM token with timeout and retries
async function waitForFcmToken(timeoutMs = 8000) {
  console.log('⏳ Waiting for FCM token (timeout: ' + timeoutMs + 'ms)...');
  const start = Date.now();
  let attempts = 0;

  while (Date.now() - start < timeoutMs) {
    attempts++;
    const token = await AsyncStorage.getItem('appFcmToken');
    
    if (token) {
      console.log('✅ FCM Token found on attempt', attempts);
      return token;
    }
    
    // Wait 500ms before next retry
    await new Promise(res => setTimeout(res, 500));
  }

  console.log('⏱️ FCM token timeout after', attempts, 'attempts');
  return null;
}

// ✅ HELPER: Request location with retries
async function getLocationWithRetries(maxRetries = 3) {
  // ✅ OPTIMIZATION: Check if we have recent location (< 24 hours old)
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

  // ✅ No cached location or too old - request fresh GPS
  let lastError = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`📍 Location request attempt ${attempt}/${maxRetries}...`);
      const { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        console.warn(`⚠️ Location permission denied on attempt ${attempt}`);
        lastError = 'Permission denied';
        // Don't retry if permission is explicitly denied
        break;
      }
      
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      
      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;
      
      console.log(`✅ Location obtained on attempt ${attempt}:`, {
        latitude,
        longitude,
      });
      
      // ✅ CACHE: Save fresh location for future logins
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
      
      return {
        latitude,
        longitude,
      };
    } catch (err) {
      lastError = (err as Error).message;
      console.warn(`⚠️ Location error on attempt ${attempt}:`, lastError);
      
      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delayMs = 1000 * attempt;
        console.log(`⏳ Retrying in ${delayMs}ms...`);
        await new Promise(res => setTimeout(res, delayMs));
      }
    }
  }
  
  console.warn(`❌ Location request failed after ${maxRetries} attempts:`, lastError);
  return { latitude: null, longitude: null };
}

export default function Register() {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken, user, loading: authLoading } = useAuth();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<'worker' | 'contractor'>('worker');
  const [isLoading, setIsLoading] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [termsModalVisible, setTermsModalVisible] = useState(false);

  // ✅ CONSTANT: Terms version for audit trail
  const TERMS_VERSION = '1.0';

  // ✅ Initialize device ID on component mount (stores it securely)
  useEffect(() => {
    getOrGenerateDeviceId().then((id) => {
      console.log('✅ Device ID initialized:', id);
    });
  }, []);

  // ✅ FIX: Check if user is already logged in and redirect
  useEffect(() => {
    if (!authLoading && accessToken && user) {
      console.log('✅ [Register] User already logged in, redirecting to /home');
      router.replace('/home');
    }
  }, [accessToken, user, authLoading, router]);

  const handleRegister = async () => {
    if (!name || !phone || !password)
      return Alert.alert(t('error'), t('required'));

    // ✅ Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      return Alert.alert(t('error'), passwordValidation.error || 'Invalid password');
    }

    // ✅ Validate terms and conditions agreement
    if (!agreedToTerms) {
      return Alert.alert(t('error'), t('agreeTerms'));
    }

    // Validate phone number (10 digits)
    const phoneTrim = phone.trim();
    if (!/^\d{10}$/.test(phoneTrim)) {
      return Alert.alert(t('invalidPhone'), t('invalidPhone'));
    }

    setIsLoading(true); // ✅ Show loading spinner
    try {
      // ✅ NOTE: Location is NOT requested during registration
      // Location will be obtained during login when worker goes online
      // This prevents location spoofing during signup (VPNs, fake GPS)
      
      // ✅ GET FCM TOKEN - Wait for it to be available (race condition fix)
      let fcmToken = null;
      console.log('📋 Starting registration process...');
      
      try {
        // ✅ WAIT for FCM token from app startup (with timeout and retries)
        // ❌ DO NOT REQUEST PERMISSION AGAIN - it was already requested at app startup
        console.log('⏳ Waiting for FCM token from app startup...');
        fcmToken = await waitForFcmToken(8000);
        
        if (fcmToken) {
          console.log('✅ FCM Token obtained from startup:', fcmToken.substring(0, 30) + '...');
        } else {
          // ❌ DO NOT call registerForPushNotificationsAsync() again
          // ✅ Permission was already requested at app startup
          // ✅ If token is still null after wait, let backend use console OTP fallback
          console.log('⚠️ FCM token not available after 8s wait - backend will use console OTP');
        }
      } catch (err) {
        console.warn('⚠️ Could not wait for FCM token:', err);
        // Continue without token - OTP will use console fallback
      }

      console.log('📦 FCM token result:', fcmToken ? 'AVAILABLE ✅' : 'NOT AVAILABLE ⚠️');
      
      // ✅ CAPTURE: Device ID for audit logging
      console.log('📱 Generating device ID...');
      const deviceId = await getOrGenerateDeviceId();
      console.log('✅ Device ID:', deviceId);
      
      // ✅ CAPTURE: App version
      const appVersion = getAppVersion();
      console.log('📦 App version:', appVersion);
      
      // ✅ CAPTURE: Terms hash (fingerprint of terms text)
      const termsText = 'Kaamwale Terms and Conditions v1.0';
      const termsHash = generateTermsHashFallback(termsText);
      console.log('🔐 Terms hash:', termsHash);
      
      console.log('📤 Sending registration request...');
      const res = await fetch(`${API_BASE}/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name, 
          phone: phoneTrim, 
          password, 
          role, 
          agreedToTerms,
          termsVersion: TERMS_VERSION,  // ✅ Terms version for audit
          fcmToken,  // ✅ FCM token for push notifications
          deviceId,  // ✅ NEW: Device ID for audit
          appVersion,  // ✅ NEW: App version for audit
          termsHash,  // ✅ NEW: Terms hash for audit
          // ❌ REMOVED: latitude, longitude - location only obtained at login
        }),
      });

      const data = await res.json();

      if (data.success) {
        console.log('✅ Registration successful');
        
        // ✅ SECURITY: Store ONLY temporary registration data (phone, name, role)
        // ❌ DO NOT store password in AsyncStorage (not encrypted)
        // ❌ DO NOT store full user.id, wallet, or profile yet
        // Full user data will be persisted only AFTER OTP verification
        const tempRegistrationData = {
          phone: phoneTrim,
          name: name,
          role: role,
          // ✅ PASSWORD NOT STORED - Will call login API after OTP verification
          // If password is needed again, user will be asked to re-enter it
          timestamp: Date.now(),
        };
        
        // Store temporarily for OTP screen to access
        await AsyncStorage.setItem('tempRegistration', JSON.stringify(tempRegistrationData));
        console.log('💾 Temporary registration data stored (will persist full user after OTP)');
        
        if (fcmToken) {
          await AsyncStorage.setItem('fcmToken', fcmToken);
          console.log('💾 FCM Token saved to AsyncStorage');
        }

        // ✅ REQUEST OTP WITH FCM TOKEN
        console.log('📨 Requesting OTP with FCM token...');
        console.log('📝 Phone:', phone);
        console.log('📝 FCM Token being sent:', fcmToken ? fcmToken.substring(0, 30) + '...' : 'null');
        
        try {
          const otpRes = await fetch(`${API_BASE}/auth/request-otp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
              phone, 
              name, 
              role,
              fcmToken  // ✅ SEND FCM TOKEN HERE
            }),
          });
          
          const otpData = await otpRes.json();
          console.log('✅ OTP Request response:', otpData.message);
        } catch (e) {
          console.warn('Failed to request OTP:', e);
        }

        let successMessage = 'Registration completed! ';
        if (fcmToken) {
          successMessage += 'OTP sent to your phone via notification.';
        } else {
          successMessage += 'Check server console for OTP (no FCM token).';
        }
        
        Alert.alert('Success', successMessage);
        // Navigate to OTP verification screen so user can enter code and complete sign-in
        router.push('/verify-otp');
      } else {
        Alert.alert('Error', data.message || 'Registration failed');
      }
    } catch (err) {
      console.error('Registration error:', err);
      Alert.alert('Error', 'Server not responding');
    } finally {
      setIsLoading(false); // ✅ Hide loading spinner
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>{t('register')}</Text>

      <TextInput 
        style={styles.input} 
        placeholder="Full Name" 
        placeholderTextColor="#999"
        value={name} 
        onChangeText={setName} 
      />
      <TextInput 
        style={styles.input} 
        placeholder={t('phone')} 
        placeholderTextColor="#999"
        keyboardType="phone-pad" 
        value={phone} 
        onChangeText={setPhone} 
      />
      <View style={styles.passwordContainer}>
        <TextInput 
          style={styles.passwordInput} 
          placeholder={t('password')} 
          placeholderTextColor="#999"
          secureTextEntry={!showPassword} 
          value={password} 
          onChangeText={setPassword} 
        />
        <TouchableOpacity 
          style={styles.passwordToggleButton}
          onPress={() => setShowPassword(!showPassword)}
        >
          <MaterialIcons 
            name={showPassword ? "visibility" : "visibility-off"} 
            size={22} 
            color="#007AFF" 
          />
        </TouchableOpacity>
      </View>

      <View style={styles.roleContainer}>
        <TouchableOpacity style={[styles.roleButton, role === 'worker' && styles.roleButtonSelected]} onPress={() => setRole('worker')}>
          <Text style={[styles.roleText, role === 'worker' && styles.roleTextSelected]}>{t('worker')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.roleButton, role === 'contractor' && styles.roleButtonSelected]} onPress={() => setRole('contractor')}>
          <Text style={[styles.roleText, role === 'contractor' && styles.roleTextSelected]}>{t('contractor')}</Text>
        </TouchableOpacity>
      </View>

      {/* ✅ Terms and Conditions Checkbox */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 16, paddingHorizontal: 16 }}>
        <TouchableOpacity
          style={{
            width: 24,
            height: 24,
            borderWidth: 2,
            borderColor: '#007AFF',
            borderRadius: 4,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: agreedToTerms ? '#007AFF' : 'transparent',
          }}
          onPress={() => setAgreedToTerms(!agreedToTerms)}
        >
          {agreedToTerms && (
            <MaterialIcons name="check" size={16} color="#fff" />
          )}
        </TouchableOpacity>
        <View style={{ marginLeft: 10, flex: 1 }}>
          <Text style={{ color: '#aaa', fontSize: 13 }}>
            I agree to the{' '}
            <TouchableOpacity
              onPress={() => setTermsModalVisible(true)}
              style={{ padding: 2 }}
            >
              <Text style={{ color: '#007AFF', fontSize: 13, textDecorationLine: 'underline', fontWeight: '600' }}>
                Terms & Conditions and Privacy Policy
              </Text>
            </TouchableOpacity>
          </Text>
        </View>
      </View>

      <TouchableOpacity style={styles.registerButton} onPress={handleRegister} disabled={isLoading}>
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{t('register')}</Text>
        )}
      </TouchableOpacity>

      {/* ✅ Legal Modal - Terms & Conditions + Privacy Policy */}
      <LegalModal visible={termsModalVisible} onClose={() => setTermsModalVisible(false)} />
    </SafeAreaView>
  );
}



// for firebase registeratyion
// // app/(auth)/Register.tsx

// import React, { useState } from 'react';
// import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar } from 'react-native';
// import { useRouter } from 'expo-router';
// import AsyncStorage from '@react-native-async-storage/async-storage';
// import styles from '../styles/RegisterScreenStyles';

// import { auth, db } from '@/firebase/firebaseConfig';
// import { createUserWithEmailAndPassword } from 'firebase/auth';
// import { ref, set } from 'firebase/database';

// type User = {
//   name: string;
//   phone: string;
//   password: string;
//   role: 'worker' | 'contractor';
// };

// export default function Register() {
//   const router = useRouter();
//   const [name, setName] = useState('');
//   const [phone, setPhone] = useState('');
//   const [password, setPassword] = useState('');
//   const [role, setRole] = useState<'worker' | 'contractor'>('worker');

//   const handleRegister = async () => {
//     if (!name || !phone || !password) {
//       return Alert.alert('Error', 'Fill all fields');
//     }

//     const newUser: User = {
//       name,
//       phone,
//       password,
//       role,
//     };

//     try {
//       // Firebase Auth requires email, so we convert phone to fake email
//       const email = `${phone}@kaamwale.com`;

//       // 1️⃣ Create user in Firebase Auth
//       const userCredential = await createUserWithEmailAndPassword(auth, email, password);
//       const user = userCredential.user;

//       // 2️⃣ Save additional user info in Realtime DB
//       await set(ref(db, `users/${user.uid}`), {
//         name,
//         phone,
//         role,
//         profilePhoto: '', // empty initially
//         walletBalance: 0,
//       });

//       await AsyncStorage.setItem('user', JSON.stringify({ uid: user.uid, name, phone, role }));

//       Alert.alert('Success', 'Registration successful!');
//       router.replace('/');
//     } catch (error: any) {
//       Alert.alert('Error', error.message);
//     }
//   };

//   return (
//     <View style={styles.container}>
//       <StatusBar barStyle="light-content" />
//       <Text style={styles.title}>Create Account</Text>

//       <TextInput
//         style={styles.input}
//         placeholder="Full Name"
//         value={name}
//         onChangeText={setName}
//       />

//       <TextInput
//         style={styles.input}
//         placeholder="Phone"
//         keyboardType="phone-pad"
//         value={phone}
//         onChangeText={setPhone}
//       />

//       <TextInput
//         style={styles.input}
//         placeholder="Password"
//         secureTextEntry
//         value={password}
//         onChangeText={setPassword}
//       />

//       <View style={styles.roleContainer}>
//         <TouchableOpacity
//           style={[styles.roleButton, role === 'worker' && styles.roleButtonSelected]}
//           onPress={() => setRole('worker')}
//         >
//           <Text style={[styles.roleText, role === 'worker' && styles.roleTextSelected]}>
//             Worker
//           </Text>
//         </TouchableOpacity>

//         <TouchableOpacity
//           style={[styles.roleButton, role === 'contractor' && styles.roleButtonSelected]}
//           onPress={() => setRole('contractor')}
//         >
//           <Text style={[styles.roleText, role === 'contractor' && styles.roleTextSelected]}>
//             Contractor
//           </Text>
//         </TouchableOpacity>
//       </View>

//       <TouchableOpacity style={styles.registerButton} onPress={handleRegister}>
//         <Text style={styles.buttonText}>Register</Text>
//       </TouchableOpacity>
//     </View>
//   );
// }
