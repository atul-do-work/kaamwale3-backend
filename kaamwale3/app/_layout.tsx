import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { registerForPushNotificationsAsync } from '../services/notification';

// ******************** 1st step 
// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

// Set up notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function RootLayout() {
  useEffect(() => {
    const initializeApp = async () => {
      try {
        // ✅ REQUEST FCM TOKEN ON APP STARTUP
        console.log('🚀 App starting - requesting FCM token...');
        const fcmToken = await registerForPushNotificationsAsync();
        
        if (fcmToken) {
          console.log('✅ FCM Token obtained on app startup:', fcmToken.substring(0, 30) + '...');
          // Store for later use
          await AsyncStorage.setItem('appFcmToken', fcmToken);
        } else {
          console.warn('⚠️ FCM Token request returned null');
        }
      } catch (error) {
        console.error('❌ Error initializing FCM:', error);
      } finally {
        // Hide splash screen
        SplashScreen.hideAsync().catch(() => {});
      }
    };

    initializeApp();
  }, []);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Login/Auth screen is the entry point */}
      <Stack.Screen name="index" />
      
      {/* Home with role-based routing */}
      <Stack.Screen name="home" />
      
      {/* Other screens */}
      <Stack.Screen name="register" />
      <Stack.Screen name="waiting" />
      <Stack.Screen name="verify-otp" />
      <Stack.Screen name="dashboard" />
      <Stack.Screen name="ActivityHistory" />
      <Stack.Screen name="DocumentsAndPolicies" />
      <Stack.Screen name="GigHistory" />
      <Stack.Screen name="HelpCentre" />
      <Stack.Screen name="NotificationHistory" />
      <Stack.Screen name="PaymentHistory" />
      <Stack.Screen name="Settings" />
      <Stack.Screen name="SupportTickets" />
      <Stack.Screen name="Verification" />
      <Stack.Screen name="VideosAndTutorials" />
    </Stack>
  );
}
