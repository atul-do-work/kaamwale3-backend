import { useEffect, useState } from 'react';
import { Redirect } from 'expo-router';
import { useAuth } from '../../context/AuthContext';
import { View, ActivityIndicator, TouchableOpacity, Text } from 'react-native';

/**
 * Home router - redirects based on user role
 * This is the single source of truth for role-based navigation
 * The _layout.tsx should NOT do role checking to avoid race conditions
 */
export default function HomeIndex() {
  const { user, accessToken } = useAuth();
  const [redirect, setRedirect] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) {
      console.log('→ [HomeIndex] No accessToken, redirecting to login');
      setRedirect('/');
      return;
    }

    if (!user) {
      console.log('→ [HomeIndex] No user data, redirecting to login');
      setRedirect('/');
      return;
    }

    console.log(`✅ [HomeIndex] User role detected: ${user.role} (phone: ${user.phone})`);

    if (user.role === 'worker') {
      console.log('→ [HomeIndex] Setting redirect to /home/worker');
      setRedirect('/home/worker');
    } else if (user.role === 'contractor') {
      console.log('→ [HomeIndex] Setting redirect to /home/contractor');
      setRedirect('/home/contractor');
    } else {
      console.warn(`⚠️ [HomeIndex] Unknown role: ${user.role}`);
      setRedirect('/');
    }
  }, [user, accessToken]);

  // Redirect to worker home
  if (redirect === '/home/worker') {
    return <Redirect href="/home/worker" />;
  }

  // Redirect to contractor home
  if (redirect === '/home/contractor') {
    return <Redirect href="/home/contractor" />;
  }

  // Redirect to login if no role
  if (redirect === '/') {
    console.log('→ [HomeIndex] Redirecting to login');
    return <Redirect href="/" />;
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color="#1a2f4d" />
    </View>
  );
}
