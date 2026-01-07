import * as Notifications from 'expo-notifications';
import { Platform, Alert } from 'react-native';

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
    token = tokenResponse.data;
    
    if (!token) {
      console.error('❌ Token response is empty:', tokenResponse);
      return null;
    }
    
    console.log('✅ FCM Token received:', token);
    console.log('📝 Token length:', token.length);
    console.log('📝 First 50 chars:', token.substring(0, 50));
    
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
