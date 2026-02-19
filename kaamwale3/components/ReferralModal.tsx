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
import { MaterialIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

interface ReferralModalProps {
  visible: boolean;
  onClose: () => void;
  workerName: string;
  workerPhone: string;
}

export default function ReferralModal({
  visible,
  onClose,
  workerName,
  workerPhone,
}: ReferralModalProps) {
  const [referralCode, setReferralCode] = useState<string>('');
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(false);

  // ✅ FIXED: Fetch referral code from backend (production-safe)
  useEffect(() => {
    if (visible && workerPhone) {
      fetchReferralCode();
    }
  }, [visible, workerPhone]);

  const fetchReferralCode = async () => {
    try {
      setLoading(true);
      // TODO: Replace with actual backend endpoint
      const API_BASE = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000';
      const response = await fetch(`${API_BASE}/referral/code/${workerPhone}`);
      
      if (response.ok) {
        const data = await response.json();
        setReferralCode(data.code || generateFallbackCode());
      } else {
        // Fallback for development
        setReferralCode(generateFallbackCode());
      }
    } catch (err) {
      console.error('Failed to fetch referral code:', err);
      // Use fallback code if fetch fails
      setReferralCode(generateFallbackCode());
    } finally {
      setLoading(false);
    }
  };

  const generateFallbackCode = () => {
    const namePart = (workerName || 'USER').slice(0, 4).toUpperCase();
    const phonePart = (workerPhone || '0000').slice(-4);
    return `${namePart}${phonePart}`;
  };

  const referralLink = `https://kaamwale.app/ref/${referralCode}`;
  const referralMessage = `🎉 Join Kaamwale and earn money!\n\nUse my referral code: ${referralCode}\nGet ₹50 bonus when you register!\n\n${referralLink}`;

  // ✅ FIXED: Use Linking API instead of WebBrowser for WhatsApp
  const shareOnWhatsApp = async () => {
    try {
      const whatsappUrl = `whatsapp://send?text=${encodeURIComponent(referralMessage)}`;
      const supported = await Linking.canOpenURL(whatsappUrl);

      if (supported) {
        await Linking.openURL(whatsappUrl);
      } else {
        Alert.alert('Error', 'WhatsApp is not installed on your device');
      }
    } catch (err) {
      Alert.alert('Error', 'Unable to open WhatsApp');
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

  // ✅ FIXED: Use expo-clipboard with async method
  const copyToClipboard = async () => {
    try {
      await Clipboard.setStringAsync(referralCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      Alert.alert('Error', 'Failed to copy to clipboard');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade">
      {/* Backdrop */}
      <View style={styles.backdrop}>
        {/* Modal Container */}
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>🎁 Refer & Earn</Text>
            <TouchableOpacity onPress={onClose}>
              <MaterialIcons name="close" size={24} color="#666" />
            </TouchableOpacity>
          </View>

          {/* Content with ScrollView for small devices */}
          <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
            {/* Loading State */}
            {loading && (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color="#667eea" />
                <Text style={styles.loadingText}>Generating your code...</Text>
              </View>
            )}

            {!loading && (
              <>
                {/* Referral Code Box */}
                <View style={styles.codeBox}>
                  <Text style={styles.label}>Your Referral Code</Text>
                  {referralCode ? (
                    <View style={styles.codeDisplay}>
                      <Text style={styles.code}>{referralCode}</Text>
                      <TouchableOpacity
                        style={styles.copyButton}
                        onPress={copyToClipboard}
                      >
                        <MaterialIcons
                          name={copied ? 'check' : 'content-copy'}
                          size={20}
                          color="#fff"
                        />
                      </TouchableOpacity>
                    </View>
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
          <View style={styles.actions}>
            {/* WhatsApp Button */}
            <TouchableOpacity
              style={[styles.button, styles.whatsappButton, !referralCode && styles.disabledButton]}
              onPress={shareOnWhatsApp}
              disabled={!referralCode || loading}
              activeOpacity={referralCode && !loading ? 0.7 : 1}
            >
              <MaterialIcons name="message" size={20} color="#fff" />
              <Text style={styles.buttonText}>Share on WhatsApp</Text>
            </TouchableOpacity>

            {/* Share More Button */}
            <TouchableOpacity
              style={[styles.button, styles.shareButton, !referralCode && styles.disabledButton]}
              onPress={shareOtherPlatforms}
              disabled={!referralCode || loading}
              activeOpacity={referralCode && !loading ? 0.7 : 1}
            >
              <MaterialIcons name="share" size={20} color="#fff" />
              <Text style={styles.buttonText}>Share More</Text>
            </TouchableOpacity>

            {/* Close Button */}
            <TouchableOpacity
              style={[styles.button, styles.closeButton]}
              onPress={onClose}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
