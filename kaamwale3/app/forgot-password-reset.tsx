import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Alert, StatusBar, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { API_BASE } from '../utils/config';
import styles from '../styles/LoginScreenStyles';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function ForgotPasswordResetScreen() {
  const router = useRouter();
  const { phone, otp } = useLocalSearchParams<{ phone: string; otp: string }>();

  const [newPassword, setNewPassword] = useState<string>('');
  const [confirmPassword, setConfirmPassword] = useState<string>('');
  const [loading, setLoading] = useState(false);

  const resetPassword = async () => {
    if (!phone || !otp) {
      return Alert.alert('Error', 'Phone/OTP is missing. Start over.');
    }

    if (!newPassword || newPassword.length < 8) {
      return Alert.alert('Invalid', 'Password must be at least 8 characters long');
    }
    if (!/\d/.test(newPassword)) {
      return Alert.alert('Invalid', 'Password must contain at least one number');
    }
    if (!/[A-Z]/.test(newPassword)) {
      return Alert.alert('Invalid', 'Password must contain at least one uppercase letter');
    }
    if (!/[a-z]/.test(newPassword)) {
      return Alert.alert('Invalid', 'Password must contain at least one lowercase letter');
    }

    if (newPassword !== confirmPassword) {
      return Alert.alert('Invalid', 'Passwords do not match');
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE}/auth/forgot-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, otp, newPassword, confirmPassword }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || !data?.success) {
        return Alert.alert('Error', data?.message || 'Password reset failed');
      }

      Alert.alert('Success', 'Your password has been updated. Please login.');
      router.replace('/');
    } catch (err) {
      console.error('Reset password failed:', err);
      Alert.alert('Error', 'Could not reset password. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <StatusBar barStyle="light-content" backgroundColor="#007bff" />
      <View style={{ width: '100%', alignItems: 'center' }}>
        <Text style={styles.title}>Reset Password</Text>

        <TextInput
          style={styles.input}
          placeholder="New password"
          secureTextEntry
          value={newPassword}
          onChangeText={setNewPassword}
          placeholderTextColor="#999"
        />

        <TextInput
          style={styles.input}
          placeholder="Confirm new password"
          secureTextEntry
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          placeholderTextColor="#999"
        />

        <TouchableOpacity
          style={[styles.loginButton, loading ? { opacity: 0.6 } : {}]}
          onPress={resetPassword}
          disabled={loading}
        >
          {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Reset Password</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => router.replace('/forgot-password')}>
          <Text style={styles.forgotPasswordText}>Start over</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
