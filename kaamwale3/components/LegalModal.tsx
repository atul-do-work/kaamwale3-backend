import React, { useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';

interface LegalModalProps {
  visible: boolean;
  onClose: () => void;
}

export default function LegalModal({ visible, onClose }: LegalModalProps) {
  const [activeTab, setActiveTab] = useState<'terms' | 'privacy'>('terms');

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
          <Text style={styles.headerTitle}>
            {activeTab === 'terms' ? 'Terms & Conditions' : 'Privacy Policy'}
          </Text>
          <TouchableOpacity onPress={onClose} style={styles.closeButton}>
            <MaterialIcons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'terms' && styles.activeTab]}
            onPress={() => setActiveTab('terms')}
          >
            <Text style={[styles.tabText, activeTab === 'terms' && styles.activeTabText]}>
              Terms & Conditions
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'privacy' && styles.activeTab]}
            onPress={() => setActiveTab('privacy')}
          >
            <Text style={[styles.tabText, activeTab === 'privacy' && styles.activeTabText]}>
              Privacy Policy
            </Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <ScrollView contentContainerStyle={styles.scrollContent}>
          {activeTab === 'terms' ? (
            <>
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
            </>
          ) : (
            <>
              <Text style={styles.sectionTitle}>1. Information We Collect</Text>
              <Text style={styles.sectionText}>
                We collect personal information you provide during registration, including name, phone number, email, and location data. We also collect information about your activities on the platform, device information, and payment details.
              </Text>

              <Text style={styles.sectionTitle}>2. How We Use Your Information</Text>
              <Text style={styles.sectionText}>
                Your information is used to:{"\n"}
                • Verify your identity and create your account{"\n"}
                • Match you with appropriate job opportunities{"\n"}
                • Process payments and financial transactions{"\n"}
                • Send you notifications and updates{"\n"}
                • Improve our services and user experience{"\n"}
                • Comply with legal obligations
              </Text>

              <Text style={styles.sectionTitle}>3. Location Data</Text>
              <Text style={styles.sectionText}>
                We collect and store your GPS location data to enable job matching and tracking features. Your location helps us find jobs/workers near you and display real-time information on maps. Location data is stored on our secure servers using encryption.
              </Text>

              <Text style={styles.sectionTitle}>4. Data Sharing</Text>
              <Text style={styles.sectionText}>
                We share your information with matched contractors/workers to facilitate job opportunities. We do not sell your personal information to third parties. Your data may be shared with payment processors and service providers necessary to operate the platform.
              </Text>

              <Text style={styles.sectionTitle}>5. Data Security</Text>
              <Text style={styles.sectionText}>
                We implement industry-standard security measures including encryption, secure servers, and restricted access. However, no method of transmission over the internet is 100% secure. You are responsible for maintaining confidentiality of your account credentials.
              </Text>

              <Text style={styles.sectionTitle}>6. Your Rights</Text>
              <Text style={styles.sectionText}>
                You have the right to:{"\n"}
                • Access your personal information{"\n"}
                • Correct inaccurate information{"\n"}
                • Request deletion of your data{"\n"}
                • Opt-out of marketing communications{"\n"}
                • Request a copy of your data
              </Text>

              <Text style={styles.sectionTitle}>7. Cookies & Tracking</Text>
              <Text style={styles.sectionText}>
                Our app may use cookies and similar tracking technologies to enhance functionality and analytics. You can control tracking preferences through your device settings.
              </Text>

              <Text style={styles.sectionTitle}>8. Children's Privacy</Text>
              <Text style={styles.sectionText}>
                Our service is not intended for individuals under 18. We do not knowingly collect information from children. If we become aware of such collection, we will delete it immediately.
              </Text>

              <Text style={styles.sectionTitle}>9. Third-Party Services</Text>
              <Text style={styles.sectionText}>
                We use third-party services for payments (Razorpay), mapping (MapTiler), and notifications (Firebase). These services have their own privacy policies, and we are not responsible for their practices.
              </Text>

              <Text style={styles.sectionTitle}>10. Data Retention</Text>
              <Text style={styles.sectionText}>
                We retain your personal information for as long as your account is active and for a reasonable period afterward for legal compliance. You can request deletion of your account and associated data.
              </Text>

              <Text style={styles.sectionTitle}>11. International Transfers</Text>
              <Text style={styles.sectionText}>
                Your information may be transferred and processed in countries outside your country of residence. By using our service, you consent to such transfers in accordance with this Privacy Policy.
              </Text>

              <Text style={styles.sectionTitle}>12. Policy Updates</Text>
              <Text style={styles.sectionText}>
                We may update this Privacy Policy periodically. Significant changes will be communicated to you via the app. Continued use of the platform constitutes acceptance of updated policies.
              </Text>

              <Text style={styles.sectionTitle}>13. Contact Us</Text>
              <Text style={styles.sectionText}>
                For privacy-related questions or requests, please contact our support team through the Help Centre in the app or via email at our support contact address.
              </Text>

              <View style={{ height: 30 }} />
            </>
          )}
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
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: '#0a0a0a',
    borderBottomWidth: 1,
    borderBottomColor: '#333',
  },
  tab: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 8,
    alignItems: 'center',
    borderBottomWidth: 3,
    borderBottomColor: 'transparent',
  },
  activeTab: {
    borderBottomColor: '#007AFF',
  },
  tabText: {
    color: '#999',
    fontSize: 13,
    fontWeight: '500',
  },
  activeTabText: {
    color: '#007AFF',
    fontWeight: '600',
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
    color: '#ccc',
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
