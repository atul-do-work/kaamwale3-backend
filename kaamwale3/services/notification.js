import * as Notifications from 'expo-notifications';
import { Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuthAccessToken } from '../utils/secureStore';

let pushTokenSubscription = null;
const FCM_TOKEN_RETRY_COUNT = 3;
const FCM_TOKEN_RETRY_DELAY_MS = 1200;

function extractPushToken(payload) {
  if (!payload) return null;
  if (typeof payload === 'string') return payload;
  if (typeof payload?.data === 'string' && payload.data) return payload.data;
  if (typeof payload?.pushToken?.data === 'string' && payload.pushToken.data) return payload.pushToken.data;
  return null;
}

async function getAndroidPushTokenWithRetry(retries = FCM_TOKEN_RETRY_COUNT, delayMs = FCM_TOKEN_RETRY_DELAY_MS) {
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const tokenResponse = await Notifications.getDevicePushTokenAsync();
      const token = extractPushToken(tokenResponse);
      if (token) {
        return { token, tokenResponse };
      }
      console.warn('⚠️ Empty FCM token response on attempt', attempt, tokenResponse);
      lastError = new Error('Empty FCM token response');
    } catch (err) {
      lastError = err;
      const message = String(err?.message || err);
      const isServiceUnavailable = message.includes('SERVICE_NOT_AVAILABLE') || String(err?.code || '').toUpperCase().includes('E_REGISTRATION_FAILED');
      if (isServiceUnavailable) {
        console.warn(`⚠️ FCM service unavailable on attempt ${attempt}/${retries}:`, message);
      } else {
        console.error(`❌ FCM token fetch error on attempt ${attempt}/${retries}:`, err);
      }
    }

    if (attempt < retries) {
      const backoff = delayMs * attempt;
      console.log(`⏳ Retrying FCM token fetch in ${backoff}ms...`);
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }

  throw lastError;
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
    let tokenResponse;
    try {
      const result = await getAndroidPushTokenWithRetry();
      tokenResponse = result?.tokenResponse;
      token = result?.token;
    } catch (err) {
      console.warn('⚠️ Failed to obtain FCM token after retries:', err?.message || err);
    }

    if (!token) {
      console.error('❌ Token response is empty or unavailable:', tokenResponse);
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
    const accessToken = await getAuthAccessToken();
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
