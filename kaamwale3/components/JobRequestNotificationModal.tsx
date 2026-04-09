import React, { useState } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  Alert,
  Linking,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { SERVER_URL } from '../utils/config';

interface JobRequest {
  requestId: string;
  contractorPhone: string;
  contractorName?: string;
  date: string;
  startTime: string;
  endTime: string;
  location: string;
  message?: string;
  timestamp: string;
}

interface JobRequestNotificationModalProps {
  visible: boolean;
  onClose: () => void;
  jobRequest: JobRequest | null;
  onResponse: (accepted: boolean, requestId: string) => void;
}

export default function JobRequestNotificationModal({
  visible,
  onClose,
  jobRequest,
  onResponse,
}: JobRequestNotificationModalProps) {
  const { accessToken } = useAuth();
  const [loading, setLoading] = useState(false);

  const handleResponse = async (accepted: boolean) => {
    if (!jobRequest) return;

    setLoading(true);
    try {
      const response = await fetch(`${SERVER_URL}/workers/respond-job-request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requestId: jobRequest.requestId,
          accepted,
        }),
      });

      const data = await response.json();

      if (data.success) {
        onResponse(accepted, jobRequest.requestId);
        onClose();
        Alert.alert(
          'Success',
          accepted ? 'Job request accepted!' : 'Job request declined.'
        );
      } else {
        Alert.alert('Error', data.message || 'Failed to respond to job request');
      }
    } catch (error) {
      console.error('Response error:', error);
      Alert.alert('Error', 'Failed to respond to job request. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCallContractor = () => {
    if (!jobRequest?.contractorPhone) return;

    const phoneNumber = `tel:${jobRequest.contractorPhone}`;
    Linking.canOpenURL(phoneNumber)
      .then(supported => {
        if (supported) {
          Linking.openURL(phoneNumber);
        } else {
          Alert.alert('Error', 'Phone calls are not supported on this device');
        }
      })
      .catch(err => console.error('Error opening phone dialer:', err));
  };

  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    } catch {
      return dateString;
    }
  };

  const formatTime = (timeString: string) => {
    try {
      // Assuming timeString is in HH:MM format
      const [hours, minutes] = timeString.split(':');
      const date = new Date();
      date.setHours(parseInt(hours), parseInt(minutes));
      return date.toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch {
      return timeString;
    }
  };

  if (!jobRequest) return null;

  return (
    <Modal visible={visible} animationType="slide" transparent={true}>
      <View style={styles.overlay}>
        <SafeAreaView style={styles.container}>
          {/* Header with close button */}
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
            <Text style={styles.headerTitle}>Job Request</Text>
            <View style={{ width: 28 }} />
          </View>

          {/* Content */}
          <View style={styles.content}>
            {/* Contractor Info */}
            <View style={styles.contractorInfo}>
              <View style={styles.contractorHeader}>
                <MaterialIcons name="person" size={24} color="#667eea" />
                <Text style={styles.contractorName}>
                  {jobRequest.contractorName || jobRequest.contractorPhone}
                </Text>
                <TouchableOpacity
                  style={styles.callButton}
                  onPress={handleCallContractor}
                >
                  <MaterialIcons name="call" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
              <Text style={styles.contractorPhone}>{jobRequest.contractorPhone}</Text>
            </View>

            {/* Job Details */}
            <View style={styles.detailsSection}>
              <Text style={styles.sectionTitle}>Job Details</Text>

              <View style={styles.detailRow}>
                <MaterialIcons name="calendar-today" size={20} color="#667eea" />
                <Text style={styles.detailText}>{formatDate(jobRequest.date)}</Text>
              </View>

              <View style={styles.detailRow}>
                <MaterialIcons name="schedule" size={20} color="#667eea" />
                <Text style={styles.detailText}>
                  {formatTime(jobRequest.startTime)} - {formatTime(jobRequest.endTime)}
                </Text>
              </View>

              <View style={styles.detailRow}>
                <MaterialIcons name="location-on" size={20} color="#667eea" />
                <Text style={styles.detailText}>{jobRequest.location}</Text>
              </View>

              {jobRequest.message && (
                <View style={styles.messageSection}>
                  <Text style={styles.messageLabel}>Message:</Text>
                  <Text style={styles.messageText}>{jobRequest.message}</Text>
                </View>
              )}
            </View>

            {/* Timestamp */}
            <Text style={styles.timestamp}>
              Received {new Date(jobRequest.timestamp).toLocaleString('en-IN')}
            </Text>
          </View>

          {/* Action Buttons */}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.declineButton, loading && styles.buttonDisabled]}
              onPress={() => handleResponse(false)}
              disabled={loading}
            >
              <MaterialIcons name="close" size={20} color="#fff" />
              <Text style={styles.declineText}>
                {loading ? 'Processing...' : 'Decline'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptButton, loading && styles.buttonDisabled]}
              onPress={() => handleResponse(true)}
              disabled={loading}
            >
              <MaterialIcons name="check" size={20} color="#fff" />
              <Text style={styles.acceptText}>
                {loading ? 'Processing...' : 'Accept'}
              </Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    backgroundColor: '#fff',
    borderRadius: 20,
    width: '90%',
    maxHeight: '80%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  content: {
    padding: 20,
  },
  contractorInfo: {
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  contractorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  contractorName: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginLeft: 8,
  },
  callButton: {
    backgroundColor: '#667eea',
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
  },
  contractorPhone: {
    fontSize: 14,
    color: '#666',
    marginLeft: 32,
  },
  detailsSection: {
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 12,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  detailText: {
    fontSize: 14,
    color: '#333',
    marginLeft: 12,
    flex: 1,
  },
  messageSection: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#f8f9fa',
    borderRadius: 8,
  },
  messageLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  messageText: {
    fontSize: 14,
    color: '#666',
    lineHeight: 20,
  },
  timestamp: {
    fontSize: 12,
    color: '#999',
    textAlign: 'center',
    marginTop: 10,
  },
  actions: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 12,
  },
  declineButton: {
    flex: 1,
    backgroundColor: '#E74C3C',
    borderRadius: 8,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  acceptButton: {
    flex: 1,
    backgroundColor: '#2ECC71',
    borderRadius: 8,
    paddingVertical: 12,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  declineText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
  acceptText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
});