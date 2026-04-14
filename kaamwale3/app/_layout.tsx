import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useRef, useState } from 'react';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, AppState, Modal, Text, TouchableOpacity, View, type AlertButton, type AlertOptions } from 'react-native';
import { registerForPushNotificationsAsync } from '../services/notification';
import { LanguageProvider } from '../context/LanguageContext';
import { AuthProvider } from '../context/AuthContext';
import { API_BASE } from '../utils/config';

// ******************** 1st step 
// Prevent splash screen from auto-hiding
SplashScreen.preventAutoHideAsync();

// Set up notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export default function RootLayout() {
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [modalButtons, setModalButtons] = useState<AlertButton[]>([{ text: 'OK' }]);
  const [modalOptions, setModalOptions] = useState<AlertOptions | undefined>(undefined);
  const originalAlertRef = useRef(Alert.alert);
  const dismissAlert = () => {
    if (modalOptions?.cancelable === false) return;
    setModalVisible(false);
    modalOptions?.onDismiss?.();
  };

  const syncFcmTokenWithBackend = async (fcmToken: string, maxRetries = 3) => {
    const accessToken = await AsyncStorage.getItem('accessToken');
    if (!accessToken || !fcmToken) return;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const response = await fetch(`${API_BASE}/auth/refresh-fcm-token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({ fcmToken })
        });
        if (response.ok) return;
      } catch (err) {
        if (attempt === maxRetries) {
          console.warn('⚠️ FCM backend sync failed after retries:', err);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * Math.pow(2, attempt - 1)));
    }
  };

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
          
          // ✅ NEW: If user is logged in, update backend with fresh token
          try {
            await syncFcmTokenWithBackend(fcmToken);
            console.log('✅ Backend FCM token sync attempted on startup');
          } catch (err) {
            console.warn('⚠️ Could not update backend token on startup:', err);
          }
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

  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      try {
        const existingToken = await AsyncStorage.getItem('appFcmToken');
        if (existingToken) {
          console.log('ℹ️ FCM token already available, skipping foreground refresh');
          return;
        }

        const latestToken = await registerForPushNotificationsAsync();
        if (latestToken) {
          await AsyncStorage.setItem('appFcmToken', latestToken);
          await syncFcmTokenWithBackend(latestToken, 3);
        }
      } catch (err) {
        console.warn('⚠️ Foreground FCM refresh failed:', err);
      }
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    Alert.alert = (title, message, buttons, options) => {
      let resolvedMessage: string | undefined = typeof message === 'string' ? message : undefined;
      let resolvedButtons: AlertButton[] | undefined = Array.isArray(buttons) ? buttons : undefined;
      let resolvedOptions: AlertOptions | undefined = options;

      if (Array.isArray(message)) {
        resolvedButtons = message as AlertButton[];
        resolvedOptions = (buttons as AlertOptions | undefined) || options;
      } else if (message && typeof message === 'object') {
        resolvedOptions = message as AlertOptions;
      }

      const safeTitle = typeof title === 'string' ? title : String(title ?? '');
      const safeMessage = typeof resolvedMessage === 'string' ? resolvedMessage : '';
      const safeButtons =
        resolvedButtons && resolvedButtons.length
          ? resolvedButtons.map((btn) => ({
              text: btn?.text || 'OK',
              style: btn?.style || 'default',
              onPress: btn?.onPress,
            }))
          : [{ text: 'OK', style: 'default' as const }];

      setModalTitle(safeTitle);
      setModalMessage(safeMessage);
      setModalButtons(safeButtons);
      setModalOptions(resolvedOptions);
      setModalVisible(true);
    };

    return () => {
      Alert.alert = originalAlertRef.current;
    };
  }, []);

  return (
    <AuthProvider>
      <LanguageProvider>
        <View style={{ flex: 1 }}>
          <Stack screenOptions={{ headerShown: false }}>
            {/* Login/Auth screen is the entry point */}
            <Stack.Screen name="index" />
            
            {/* Forgot Password screens */}
            <Stack.Screen name="forgot-password" />
            <Stack.Screen name="forgot-password-otp" />
            <Stack.Screen name="forgot-password-reset" />
            
            {/* Home with role-based routing */}
            <Stack.Screen name="home" />
            
            {/* Other screens */}
            <Stack.Screen name="register" />
            <Stack.Screen name="waiting" />
            <Stack.Screen name="verify-otp" />
            <Stack.Screen name="dashboard/index" />
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

          <Modal
            visible={modalVisible}
            transparent
            animationType="fade"
            onRequestClose={() => {
              if (modalOptions?.cancelable === false) return;
              setModalVisible(false);
              modalOptions?.onDismiss?.();
            }}
          >
            <View
              style={{
                flex: 1,
                backgroundColor: 'rgba(0,0,0,0.45)',
                justifyContent: 'center',
                alignItems: 'center',
                paddingHorizontal: 18,
              }}
            >
              <TouchableOpacity
                activeOpacity={1}
                onPress={dismissAlert}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              />
              <View
                style={{
                  width: '100%',
                  maxWidth: 360,
                  backgroundColor: '#ffffff',
                  borderRadius: 14,
                  padding: 18,
                  borderWidth: 1,
                  borderColor: '#e5e7eb',
                }}
              >
                <Text style={{ fontSize: 18, fontWeight: '700', color: '#0f172a', marginBottom: 8 }}>
                  {modalTitle || 'Notice'}
                </Text>
                <Text style={{ fontSize: 14, color: '#334155', lineHeight: 20, marginBottom: 16 }}>
                  {modalMessage || ''}
                </Text>

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                  {modalButtons.map((button, idx) => {
                    const isCancel = button.style === 'cancel';
                    const isDestructive = button.style === 'destructive';
                    return (
                      <TouchableOpacity
                        key={`${button.text}-${idx}`}
                        style={{
                          paddingHorizontal: 14,
                          paddingVertical: 10,
                          borderRadius: 8,
                          marginLeft: 8,
                          backgroundColor: isCancel ? '#f1f5f9' : isDestructive ? '#ef4444' : '#1a2f4d',
                        }}
                        onPress={() => {
                          setModalVisible(false);
                          button.onPress?.();
                        }}
                      >
                        <Text style={{ color: isCancel ? '#0f172a' : '#ffffff', fontWeight: '700', fontSize: 13 }}>
                          {button.text || 'OK'}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>
          </Modal>
        </View>
      </LanguageProvider>
    </AuthProvider>
  );
}
