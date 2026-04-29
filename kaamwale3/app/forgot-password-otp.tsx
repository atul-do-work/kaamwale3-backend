import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { API_BASE } from '../utils/config';
import styles from '../styles/LoginScreenStyles';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ForgotPasswordOtpScreen() {
  const router = useRouter();
  const { phone } = useLocalSearchParams<{ phone: string }>();

  const [otp, setOtp] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const verifyOtp = async () => {
    if (!phone || !otp || otp.trim().length !== 6) {
      return Alert.alert('Invalid', 'Please enter a 6-digit OTP');
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/forgot-password-verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp: otp.trim() }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        return Alert.alert('Error', data?.message || 'OTP verification failed');
      }

      Alert.alert('Success', 'OTP verified. Proceed to set new password.');
      router.push({
        pathname: '/forgot-password-reset',
        params: { phone, otp: otp.trim() },
      });
    } catch (err) {
      console.error('OTP verify failed:', err);
      Alert.alert('Error', 'Could not verify OTP. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    if (!phone) return Alert.alert('Error', 'Phone number is missing');

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/forgot-password-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        return Alert.alert('Error', data?.message || 'Failed to resend OTP');
      }
      Alert.alert('Success', 'OTP resent via push notification.');
    } catch (err) {
      console.error('Resend OTP failed:', err);
      Alert.alert('Error', 'Could not resend OTP.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor="#007bff" />
      <View style={{ width: '100%', alignItems: 'center' }}>
        <Text style={styles.title}>Enter OTP</Text>
        <Text style={styles.subtitle}>Code sent to {phone || 'your number'}</Text>

        <TextInput
          style={styles.input}
          placeholder="6-digit OTP"
          keyboardType="numeric"
          value={otp}
          onChangeText={setOtp}
          maxLength={6}
          placeholderTextColor="#999"
        />

        <TouchableOpacity
          style={[styles.loginButton, loading ? { opacity: 0.6 } : {}]}
          onPress={verifyOtp}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify OTP</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={resendOtp}>
          <Text style={styles.forgotPasswordText}>Resend OTP</Text>
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.replace('/forgot-password')}>
          <Text style={styles.forgotPasswordText}>Back</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
