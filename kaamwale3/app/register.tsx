import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE } from '../utils/config';
import styles from '../styles/RegisterScreenStyles';
import { registerForPushNotificationsAsync } from '../services/notification';
import { useLanguage } from '../context/LanguageContext';

type User = {
  name: string;
  phone: string;
  password: string;
  role: 'worker' | 'contractor';
};

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

export default function Register() {
  const router = useRouter();
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<'worker' | 'contractor'>('worker');
  const [isLoading, setIsLoading] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);

  const handleRegister = async () => {
    if (!name || !phone || !password)
      return Alert.alert(t('error'), t('required'));

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
      
      console.log('📤 Sending registration request...');
      const res = await fetch(`${API_BASE}/users/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, phone: phoneTrim, password, role, agreedToTerms }), // ✅ Include agreedToTerms
      });

      const data = await res.json();

      if (data.success) {
        console.log('✅ Registration successful');
        // Save user locally for convenience
        await AsyncStorage.setItem('user', JSON.stringify(data.user));
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
    <View style={styles.container}>
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
        <Text style={{ marginLeft: 10, color: '#555', fontSize: 13, flex: 1 }}>
          {t('agreeTerms')}
        </Text>
      </View>

      <TouchableOpacity style={styles.registerButton} onPress={handleRegister} disabled={isLoading}>
        {isLoading ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.buttonText}>{t('register')}</Text>
        )}
      </TouchableOpacity>
    </View>
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
