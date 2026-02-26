import * as Notifications from 'expo-notifications';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

let pushTokenSubscription = null;

function extractPushToken(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload?.data === 'string' && payload.data) return payload.data;
  if (typeof payload?.pushToken?.data === 'string' && payload.pushToken.data) return payload.pushToken.data;
  return null;
}

export async function registerForPushNotificationsAsync() {
  let token;
  
  try {
    console.log('🔔 Starting notification setup...');
    console.log('📱 Platform:', Platform.OS);
    
    // Android: Set up notification channel
    if (Platform.OS === 'android') {
      console.log('📱 Setting up Android notification channel...');
      await Notifications.setNotificationChannelAsync('default', {
        name: 'default',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#FF231F7C',
        bypassDnd: true,
        enableVibration: true,
        enableLights: true,
        sound: 'default'
      });
      console.log('✅ Android channel configured with sound');
    }
    
    // Check current permission status
    console.log('🔐 Checking current permission status...');
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    console.log('📊 Current permission status:', existingStatus);
    
    let finalStatus = existingStatus;
    
    // Request permission if not already granted
    if (existingStatus !== 'granted') {
      console.log('⚠️ Permissions not granted, requesting...');
      const { status } = await Notifications.requestPermissionsAsync();
      console.log('📊 Permission request result:', status);
      finalStatus = status;
    }
    
    // Check final status
    if (finalStatus !== 'granted') {
      console.warn('❌ Notification permissions DENIED by user');
      Alert.alert(
        'Permissions Required',
        'Please allow notifications to receive OTP via push notifications.',
        [{ text: 'OK' }]
      );
      return null;
    }
    
    console.log('✅ Permissions GRANTED - proceeding to get token');
    
    // Get the Android FCM token (not Expo token)
    console.log('🔑 Getting Android FCM token...');
    const tokenResponse = await Notifications.getDevicePushTokenAsync();
    token = extractPushToken(tokenResponse);
    
    if (!token) {
      console.error('❌ Token response is empty:', tokenResponse);
      return null;
    }
    
    console.log('✅ FCM Token received:', token);
    console.log('📝 Token length:', token.length);
    console.log('📝 First 50 chars:', token.substring(0, 50));
    
    // ✅ NEW: Listen for token refresh/changes
    if (pushTokenSubscription) {
      try {
        pushTokenSubscription.remove();
      } catch {}
      pushTokenSubscription = null;
    }

    pushTokenSubscription = Notifications.addPushTokenListener((event) => {
      const newToken = extractPushToken(event);
      if (!newToken) {
        console.warn('⚠️ Push token refresh payload missing token:', event);
        return;
      }
      console.log('🔄 FCM Token refreshed/changed:', newToken.substring(0, 30) + '...');
      
      // Update stored token
      AsyncStorage.setItem('appFcmToken', newToken).catch(err => {
        console.error('Failed to save new token to storage:', err);
      });
      
      // Notify backend of token change (if user logged in)
      updateBackendTokenOnChange(newToken).catch(err => {
        console.error('Failed to update backend token:', err);
      });
    });
    
    return token;
    
  } catch (err) {
    console.error('❌ Error in notification setup:', err);
    console.error('Error details:', {
      name: err.name,
      message: err.message,
      stack: err.stack
    });
    return null;
  }
}

// ✅ NEW: Helper to update backend when token changes
async function updateBackendTokenOnChange(newToken) {
  try {
    // Only update if user is logged in
    const accessToken = await AsyncStorage.getItem('accessToken');
    if (!accessToken) {
      console.log('ℹ️ User not logged in - token change not synced to backend');
      return;
    }
    
    console.log('📱 Syncing new FCM token to backend...');
    const API_BASE = process.env.EXPO_PUBLIC_API_BASE || 'http://localhost:3000';
    
    const response = await fetch(`${API_BASE}/auth/refresh-fcm-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({ fcmToken: newToken })
    });
    
    const data = await response.json();
    if (data.success) {
      console.log('✅ Backend FCM token updated on token change');
    } else {
      console.warn('⚠️ Failed to update backend token:', data.message);
    }
  } catch (err) {
    console.error('Error updating backend on token change:', err);
  }
}
