import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { View, ActivityIndicator, TouchableOpacity, Text } from 'react-native';

/**
 * Home router - redirects based on user role
 * This is the single source of truth for role-based navigation
 * The _layout.tsx should NOT do role checking to avoid race conditions
 */
export default function HomeIndex() {
  const [role, setRole] = useState<'worker' | 'contractor' | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirect, setRedirect] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const getUserRole = async () => {
      try {
        console.log('🏠 [HomeIndex] Starting role detection...');
        const userDataString = await AsyncStorage.getItem('user');
        console.log('🏠 [HomeIndex] AsyncStorage user data retrieved');
        
        if (userDataString) {
          const userData = JSON.parse(userDataString);
          console.log(`✅ [HomeIndex] User role detected: ${userData.role} (phone: ${userData.phone})`);
          
          if (userData.role === 'worker') {
            console.log('→ [HomeIndex] Setting redirect to /home/worker');
            setRole('worker');
            setRedirect('/home/worker');
          } else if (userData.role === 'contractor') {
            console.log('→ [HomeIndex] Setting redirect to /home/contractor');
            setRole('contractor');
            setRedirect('/home/contractor');
          } else {
            console.warn(`⚠️ [HomeIndex] Unknown role: ${userData.role}`);
            setError(`Unknown role: ${userData.role}`);
            setRedirect('/');
          }
        } else {
          console.warn('⚠️ [HomeIndex] No user data in AsyncStorage, redirecting to login');
          setRedirect('/');
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error('❌ [HomeIndex] Error reading user role:', errorMsg);
        setError(errorMsg);
        setRedirect('/');
      } finally {
        setLoading(false);
      }
    };

    getUserRole();
  }, []);

  // Show loading screen while checking
  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#1a2f4d" />
      </View>
    );
  }

  // Redirect based on role
  if (redirect === '/home/worker') {
    console.log('→ [HomeIndex] Redirecting to /home/worker');
    // Add a small delay to ensure state is fully settled before redirect
    return <Redirect href="/home/worker" />;
  }
  
  if (redirect === '/home/contractor') {
    console.log('→ [HomeIndex] Redirecting to /home/contractor');
    // Add a small delay to ensure state is fully settled before redirect
    return <Redirect href="/home/contractor" />;
  }

  // Redirect to login if no role
  if (redirect === '/') {
    console.log('→ [HomeIndex] Redirecting to login');
    return <Redirect href="/" />;
  }

  // Fallback (should not happen)
  if (error) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff', padding: 20 }}>
        <Text style={{ fontSize: 16, color: '#e74c3c', textAlign: 'center', marginBottom: 20 }}>
          Error loading home:
        </Text>
        <Text style={{ fontSize: 14, color: '#666', textAlign: 'center', marginBottom: 20 }}>
          {error}
        </Text>
        <TouchableOpacity 
          style={{ padding: 10, backgroundColor: '#007AFF', borderRadius: 8 }}
          onPress={() => {
            setError(null);
            setLoading(true);
            setRedirect(null);
          }}
        >
          <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color="#1a2f4d" />
    </View>
  );
}
