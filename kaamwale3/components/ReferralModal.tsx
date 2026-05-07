import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  Share,
  Alert,
  StyleSheet,
  Linking,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';import { getAuthAccessToken } from '../utils/secureStore';import * as Clipboard from 'expo-clipboard';

interface ReferralModalProps {
  visible: boolean;
  onClose: () => void;
  workerName: string;
  workerPhone: string;
  variant?: 'default' | 'minimal';
}

export default function ReferralModal({
  visible,
  onClose,
  workerName,
  workerPhone,
  variant = 'default',
}: ReferralModalProps) {
  const [referralCode, setReferralCode] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch referral code from backend (production-safe)
  useEffect(() => {
    let isMounted = true;
    if (visible && workerPhone) {
      fetchReferralCode(isMounted);
    }

    return () => {
      isMounted = false;
    };
  }, [visible, workerPhone]);

  const fetchReferralCode = async (isMountedFlag = true) => {
    try {
      setLoading(true);
      setError(null);

      const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? '';
      if (!API_BASE) {
        console.warn('[referral] EXPO_PUBLIC_API_URL not set; using fallback code');
        if (isMountedFlag) setReferralCode(generateFallbackCode());
        return;
      }

      const url = `${API_BASE}/referral/code/${workerPhone}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      // attach auth token if available
      let headers: any = {};
      try {
        const token = await getAuthAccessToken();
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch (e) {
        // ignore
      }

      const response = await fetch(url, {
        signal: controller.signal,
        headers,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        if (isMountedFlag) setReferralCode(generateFallbackCode());
        return;
      }

      const data = await response.json();
      if (data?.code && typeof data.code === 'string') {
        if (isMountedFlag) setReferralCode(data.code);
      } else {
        if (isMountedFlag) setReferralCode(generateFallbackCode());
      }
    } catch (err: any) {
      console.error('Failed to fetch referral code:', err?.message || err);
      if (err?.name === 'AbortError') setError('Request timed out');
      if (isMountedFlag) setReferralCode(generateFallbackCode());
    } finally {
      if (isMountedFlag) setLoading(false);
    }
  };

  const generateFallbackCode = () => {
    const namePart = (workerName || 'USER').slice(0, 4).toUpperCase();
    const phonePart = (workerPhone || '0000').slice(-4);
    return `${namePart}${phonePart}`;
  };

  const APP_BASE_URL = process.env.EXPO_PUBLIC_APP_URL ?? 'https://kaamwale.app';
  const referralLink = `${APP_BASE_URL.replace(/\/$/, '')}/ref/${referralCode}`;
  const referralMessage = `🎉 Join Kaamwale and earn money!\n\nUse my referral code: ${referralCode}\nGet ₹50 bonus when you register and complete your first job.\n\n${referralLink}`;

  const copyReferralLink = async () => {
    try {
      await Clipboard.setStringAsync(referralLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      Alert.alert('Error', 'Failed to copy link');
    }
  };

  // ✅ FIXED: Use Linking API instead of WebBrowser for WhatsApp
  const shareOnWhatsApp = async () => {
    try {
      const encodedMessage = encodeURIComponent(referralMessage);
      const whatsappUrl = `whatsapp://send?text=${encodedMessage}`;
      const supported = await Linking.canOpenURL('whatsapp://send');

      if (supported) {
        await Linking.openURL(whatsappUrl);
      } else {
        await Linking.openURL(`https://wa.me/?text=${encodedMessage}`);
      }
    } catch (err) {
      await Share.share({ message: referralMessage, title: 'Kaamwale Referral' });
    }
  };

  // ✅ FIXED: Share using native share (removed url parameter as it's already in message)
  const shareOtherPlatforms = async () => {
    try {
      await Share.share({
        message: referralMessage,
        title: 'Kaamwale Referral',
      });
    } catch (err) {
      Alert.alert('Error', 'Share failed');
    }
  };

  const containerStyle = variant === 'minimal' ? minimalStyles.container : styles.container;
  const titleStyle = variant === 'minimal' ? minimalStyles.title : styles.title;
  const textStyle = variant === 'minimal' ? minimalStyles.text : undefined;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View style={variant === 'minimal' ? minimalStyles.backdrop : styles.backdrop}>
        <SafeAreaView style={styles.safeArea} edges={['bottom']}>
          <View style={containerStyle}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={titleStyle}>🎁 Refer & Earn</Text>
            <TouchableOpacity onPress={onClose}>
              <MaterialIcons name="close" size={24} color="#666" />
            </TouchableOpacity>
          </View>
          <Text style={[styles.subtitle, textStyle]}>
            Share your referral code with friends and both of you get ₹50 when they complete their first job.
          </Text>

          {/* Content with ScrollView for small devices */}
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
              {/* Loading State */}
              {loading && (
                <View style={styles.loadingContainer}>
                  {/* simple skeleton */}
                  <View style={styles.skeletonLine} />
                  <View style={[styles.skeletonLine, { width: '60%', marginTop: 12 }]} />
                </View>
              )}

            {!loading && (
              <>
                {/* Referral Code Box */}
                <View style={styles.codeBox}>
                  <Text style={styles.label}>Your Referral Code</Text>
                  {referralCode ? (
                    <>
                      <View style={styles.codeDisplay}>
                        <Text style={styles.code}>{referralCode}</Text>
                        <TouchableOpacity
                          style={styles.copyButton}
                          onPress={copyReferralLink}
                        >
                          <MaterialIcons
                            name={copied ? 'check' : 'content-copy'}
                            size={20}
                            color="#fff"
                          />
                        </TouchableOpacity>
                      </View>
                      <Text style={[styles.linkLabel, textStyle]}>Referral link</Text>
                      <Text style={[styles.linkText, textStyle]} numberOfLines={2}>{referralLink}</Text>
                    </>
                  ) : (
                    <Text style={styles.errorText}>Unable to generate code</Text>
                  )}
                  {copied && (
                    <Text style={styles.copiedText}>✅ Copied to clipboard!</Text>
                  )}
                </View>

                {/* Rewards Info */}
                <View style={styles.rewardBox}>
                  <MaterialIcons name="card-giftcard" size={30} color="#4CAF50" />
                  <Text style={styles.rewardTitle}>Earn ₹50 Per Referral</Text>
                  <Text style={styles.rewardDescription}>
                    Your friend gets ₹50 bonus on first job
                  </Text>
                  <Text style={styles.rewardDescription}>
                    You get ₹50 when they complete their first job
                  </Text>
                </View>

                {/* How it Works */}
                <View style={styles.stepsBox}>
                  <Text style={styles.stepsTitle}>How it Works</Text>
                  <View style={styles.step}>
                    <View style={styles.stepNumber}>
                      <Text style={styles.stepNumberText}>1</Text>
                    </View>
                    <Text style={styles.stepText}>Share your code with friends</Text>
                  </View>
                  <View style={styles.step}>
                    <View style={styles.stepNumber}>
                      <Text style={styles.stepNumberText}>2</Text>
                    </View>
                    <Text style={styles.stepText}>They register using your code</Text>
                  </View>
                  <View style={styles.step}>
                    <View style={styles.stepNumber}>
                      <Text style={styles.stepNumberText}>3</Text>
                    </View>
                    <Text style={styles.stepText}>Both get ₹50 bonus!</Text>
                  </View>
                </View>
              </>
            )}
          </ScrollView>

          {/* Action Buttons */}
            <View style={variant === 'minimal' ? minimalStyles.actions : styles.actions}>
            {/* WhatsApp Button */}
            <TouchableOpacity
              style={[styles.button, styles.whatsappButton, !referralCode && styles.disabledButton]}
              onPress={shareOnWhatsApp}
              disabled={!referralCode || loading}
              activeOpacity={referralCode && !loading ? 0.7 : 1}
            >
              <MaterialIcons name="message" size={20} color="#fff" />
              <Text style={[styles.buttonText, textStyle]}>Share on WhatsApp</Text>
            </TouchableOpacity>

            {/* Share More Button */}
            <TouchableOpacity
              style={[styles.button, styles.shareButton, !referralCode && styles.disabledButton]}
              onPress={shareOtherPlatforms}
              disabled={!referralCode || loading}
              activeOpacity={referralCode && !loading ? 0.7 : 1}
            >
              <MaterialIcons name="share" size={20} color="#fff" />
              <Text style={[styles.buttonText, textStyle]}>Share More</Text>
            </TouchableOpacity>

            {/* Close Button */}
            <TouchableOpacity
              style={[styles.button, styles.closeButton]}
              onPress={onClose}
            >
              <Text style={variant === 'minimal' ? minimalStyles.closeButtonText : styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    width: '100%',
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  container: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 20,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#333',
  },
  subtitle: {
    color: '#555',
    fontSize: 14,
    lineHeight: 20,
    marginHorizontal: 20,
    marginTop: 8,
    marginBottom: 10,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    maxHeight: '70%',
  },
  loadingContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 40,
  },
  loadingText: {
    fontSize: 14,
    color: '#667eea',
    marginTop: 12,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 12,
    color: '#e74c3c',
    fontWeight: '600',
    textAlign: 'center',
  },
  codeBox: {
    backgroundColor: '#f5f5f5',
    borderRadius: 12,
    padding: 15,
    marginBottom: 20,
  },
  label: {
    fontSize: 12,
    color: '#999',
    fontWeight: '600',
    marginBottom: 8,
  },
  codeDisplay: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    marginBottom: 8,
  },
  code: {
    fontSize: 24,
    fontWeight: '700',
    color: '#667eea',
    letterSpacing: 2,
  },
  linkLabel: {
    fontSize: 12,
    color: '#6B7280',
    fontWeight: '600',
    marginTop: 10,
  },
  linkText: {
    fontSize: 14,
    color: '#111827',
    marginTop: 6,
  },
  copyButton: {
    backgroundColor: '#667eea',
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copiedText: {
    fontSize: 12,
    color: '#4CAF50',
    fontWeight: '600',
    textAlign: 'center',
  },
  skeletonLine: {
    height: 16,
    backgroundColor: '#E5E7EB',
    borderRadius: 8,
    width: '80%',
  },
  rewardBox: {
    backgroundColor: '#f0f8f0',
    borderRadius: 12,
    padding: 15,
    alignItems: 'center',
    marginBottom: 20,
    borderLeftWidth: 4,
    borderLeftColor: '#4CAF50',
  },
  rewardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#333',
    marginTop: 8,
  },
  rewardDescription: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
    textAlign: 'center',
  },
  stepsBox: {
    backgroundColor: '#f9f9f9',
    borderRadius: 12,
    padding: 15,
  },
  stepsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#333',
    marginBottom: 12,
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#667eea',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  stepNumberText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
  },
  stepText: {
    fontSize: 13,
    color: '#666',
    flex: 1,
  },
  actions: {
    paddingHorizontal: 20,
    gap: 10,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  whatsappButton: {
    backgroundColor: '#25D366',
  },
  shareButton: {
    backgroundColor: '#667eea',
  },
  closeButton: {
    backgroundColor: '#f0f0f0',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  closeButtonText: {
    color: '#333',
    fontWeight: '600',
    fontSize: 14,
  },
  disabledButton: {
    opacity: 0.5,
  },
});

const minimalStyles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    width: '92%',
    backgroundColor: '#000',
    borderRadius: 12,
    paddingVertical: 18,
    paddingHorizontal: 16,
    maxHeight: '80%',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  text: {
    color: '#fff',
  },
  actions: {
    paddingHorizontal: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 12,
  },
  closeButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
});
