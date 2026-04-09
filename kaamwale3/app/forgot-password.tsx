import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { API_BASE } from '../utils/config';
import styles from '../styles/LoginScreenStyles';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const requestOtp = async () => {
    if (!phone || phone.trim().length < 10) {
      return Alert.alert('Invalid', 'Please enter a valid phone number');
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/forgot-password-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim() }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        return Alert.alert('Error', data?.message || 'Unable to send OTP');
      }

      Alert.alert('Success', 'OTP sent to your phone via push notification.');
      router.push({
        pathname: '/forgot-password-otp',
        params: { phone: phone.trim() },
      });
    } catch (err) {
      console.error('Forgot password / request OTP failed:', err);
      Alert.alert('Error', 'Could not send OTP. Try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#007bff" />
      <View style={{ width: '100%', alignItems: 'center' }}>
        <Text style={styles.title}>Forgot Password</Text>

        <TextInput
          style={styles.input}
          placeholder="Enter Phone Number"
          keyboardType="phone-pad"
          value={phone}
          onChangeText={setPhone}
          maxLength={10}
          placeholderTextColor="#999"
        />

        <TouchableOpacity
          style={[styles.loginButton, loading ? { opacity: 0.6 } : {}]}
          onPress={requestOtp}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.buttonText}>Send OTP</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.replace('/')}>
          <Text style={styles.forgotPasswordText}>Back to Login</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
