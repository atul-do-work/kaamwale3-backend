import React from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface TermsAndConditionsModalProps {
  visible: boolean;
  onClose: () => void;
}

export default function TermsAndConditionsModal({ visible, onClose }: TermsAndConditionsModalProps) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Terms & Conditions</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <MaterialIcons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Content */}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <Text style={styles.sectionTitle}>1. Acceptance of Terms</Text>
          <Text style={styles.sectionText}>
            By registering for and using this Kaamwale application, you agree to be bound by these Terms and Conditions. If you do not agree with any part of these terms, you must not use this service.
          </Text>

          <Text style={styles.sectionTitle}>2. User Eligibility</Text>
          <Text style={styles.sectionText}>
            You must be at least 18 years old to use this service. You are responsible for ensuring that all information provided during registration is accurate, current, and complete. You must maintain the confidentiality of your account credentials and are responsible for all activities that occur under your account.
          </Text>

          <Text style={styles.sectionTitle}>3. Service Description</Text>
          <Text style={styles.sectionText}>
            Kaamwale is a platform that connects contractors/employers with workers for job opportunities. We do not employ workers; we are a platform for matching job seekers with employers. We are not responsible for the quality, timing, or legality of work performed.
          </Text>

          <Text style={styles.sectionTitle}>4. User Responsibilities</Text>
          <Text style={styles.sectionText}>
            Users agree to:{"\n"}
            • Use the platform only for legitimate job matching purposes{"\n"}
            • Not engage in fraudulent, illegal, or harmful activities{"\n"}
            • Not harass, abuse, or discriminate against other users{"\n"}
            • Comply with all applicable laws and regulations{"\n"}
            • Maintain accurate account information
          </Text>

          <Text style={styles.sectionTitle}>5. Payment & Transactions</Text>
          <Text style={styles.sectionText}>
            All payments are processed through secured payment gateways. Workers are responsible for reporting income as per local tax regulations. Contractors are responsible for wages, benefits, and statutory compliance as per labor laws. We charge a nominal fee for transactions and services.
          </Text>

          <Text style={styles.sectionTitle}>6. Limitation of Liability</Text>
          <Text style={styles.sectionText}>
            Kaamwale is provided on an "as-is" basis. We do not guarantee the availability, accuracy, or completeness of information. We are not liable for lost wages, work-related injuries, accidents, or disputes between users. Users indemnify Kaamwale from any claims arising from their use of the platform.
          </Text>

          <Text style={styles.sectionTitle}>7. Termination of Account</Text>
          <Text style={styles.sectionText}>
            We reserve the right to suspend or terminate accounts that violate these terms. Users may also delete their accounts at any time through settings.
          </Text>

          <Text style={styles.sectionTitle}>8. Privacy & Data Protection</Text>
          <Text style={styles.sectionText}>
            Your personal data will be processed according to our Privacy Policy. We use encrypted connections for data transmission. Your location and contact information may be shared with matched job opportunities.
          </Text>

          <Text style={styles.sectionTitle}>9. Dispute Resolution</Text>
          <Text style={styles.sectionText}>
            In case of disputes, users agree to resolve matters directly or through our support team. If unresolved, disputes shall be governed by applicable local laws and jurisdiction.
          </Text>

          <Text style={styles.sectionTitle}>10. Changes to Terms</Text>
          <Text style={styles.sectionText}>
            We may update these terms periodically. Continued use of the platform constitutes acceptance of updated terms. We will notify users of significant changes via the app.
          </Text>

          <Text style={styles.sectionTitle}>11. Contact Us</Text>
          <Text style={styles.sectionText}>
            For questions regarding these terms, please contact our support team through the Help Centre in the app.
          </Text>

          <View style={{ height: 30 }} />
        </ScrollView>

        {/* Footer Button */}
        <View style={styles.footer}>
          <TouchableOpacity style={styles.agreeButton} onPress={onClose}>
            <Text style={styles.agreeButtonText}>I Understand</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  header: {
    backgroundColor: '#007AFF',
    paddingTop: 16,
    paddingBottom: 16,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: 'bold',
  },
  closeButton: {
    width: 40,
    height: 40,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
    marginTop: 16,
    marginBottom: 8,
  },
  sectionText: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 12,
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#0a0a0a',
    borderTopWidth: 1,
    borderTopColor: '#333',
  },
  agreeButton: {
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  agreeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
