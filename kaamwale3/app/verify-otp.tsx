import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { API_BASE } from '../utils/config';
import styles from '../styles/LoginScreenStyles';

export default function VerifyOtpScreen() {
  const router = useRouter();
  const [phone, setPhone] = useState<string>('');
  const [otp, setOtp] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem('user');
        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.phone) setPhone(user.phone);
        }
      } catch (err) {
        console.warn('Failed to load phone from storage', err);
      }
    })();
  }, []);

  const handleVerify = async () => {
    if (!phone || !otp) return Alert.alert('Missing', 'Enter phone and OTP');
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/auth/verify-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp }),
      });

      const data = await res.json().catch(() => null);

      if (!res.ok || !data?.success) {
        return Alert.alert('Verification Failed', data?.message || 'Invalid or expired OTP');
      }

      // Save tokens & user
      const accessToken = data.accessToken || data.token || null;
      const refreshToken = data.refreshToken || null;

      if (accessToken) {
        await AsyncStorage.setItem('accessToken', accessToken);
        await AsyncStorage.setItem('token', accessToken);
      }
      if (refreshToken) await AsyncStorage.setItem('refreshToken', refreshToken);

      if (data.user) await AsyncStorage.setItem('user', JSON.stringify(data.user));

      Alert.alert('Success', 'Phone verified — you are logged in');

      // Navigate based on role
      if (data.user?.role === 'worker') {
        router.replace('/home/worker');
      } else {
        router.replace('/home/contractor');
      }
    } catch (err) {
      console.error('Verify OTP error', err);
      Alert.alert('Error', 'Could not verify OTP');
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    if (!phone) return Alert.alert('Missing', 'Phone is empty');
    try {
      await fetch(`${API_BASE}/auth/request-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      Alert.alert('OTP sent', 'New OTP requested (dev-mode: check server logs)');
    } catch (err) {
      console.warn('Resend OTP failed', err);
      Alert.alert('Error', 'Could not resend OTP');
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" />
      <Text style={styles.title}>Verify OTP</Text>
      <Text style={{ color: '#999', marginBottom: 12 }}>Enter the 6-digit code sent to</Text>
      <Text style={{ fontWeight: '700', fontSize: 18, marginBottom: 18 }}>{phone || '—'}</Text>

      <TextInput
        style={styles.input}
        keyboardType="number-pad"
        placeholder="Enter OTP"
        value={otp}
        onChangeText={setOtp}
        maxLength={6}
      />

      <TouchableOpacity style={styles.loginButton} onPress={handleVerify} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Verify</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={{ marginTop: 12 }} onPress={resendOtp}>
        <Text style={{ color: '#667eea', fontWeight: '700' }}>Resend OTP</Text>
      </TouchableOpacity>

      <TouchableOpacity style={[styles.registerButton, { marginTop: 22 }]} onPress={() => router.replace('/') }>
        <Text style={styles.registerText}>Back to login</Text>
      </TouchableOpacity>
    </View>
  );
}
