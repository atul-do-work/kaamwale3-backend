import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Alert,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useAuth } from '../context/AuthContext';
import { SERVER_URL } from '../utils/config';

interface Worker {
  phone: string;
  name: string;
  mainSkill: string;
  expectedWage: string;
  distanceKm: number;
  distanceMeters: number;
  rating: number;
  totalReviews?: number;
  skills: string[];
  profilePhoto?: string;
  isAvailable?: boolean;
}

interface JobRequestModalProps {
  visible: boolean;
  renderAsPanel?: boolean;
  onClose: () => void;
  worker: Worker | null;
  onRequestSent: (workerPhone: string, requestId: string) => void;
}

export default function JobRequestModal({
  visible,
  renderAsPanel,
  onClose,
  worker,
  onRequestSent,
}: JobRequestModalProps) {
  const { accessToken, user: authUser } = useAuth();

  // Form state
  const [date, setDate] = useState(new Date());
  const [startTime, setStartTime] = useState(new Date());
  const [endTime, setEndTime] = useState(new Date());
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);

  // Picker visibility
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);

  const resetForm = useCallback(() => {
    setDate(new Date());
    setStartTime(new Date());
    setEndTime(new Date());
    setLocation('');
  }, []);

  const handleSendRequest = useCallback(async () => {
    if (!worker) return;

    // Validation
    const trimmedLocation = location.trim();
    if (!trimmedLocation || trimmedLocation.length > 200) {
      Alert.alert('Error', 'Please enter a valid location (1-200 characters)');
      return;
    }

    const now = new Date();
    const startDateTime = new Date(date);
    startDateTime.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
    const endDateTime = new Date(date);
    endDateTime.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

    if (startDateTime <= now) {
      Alert.alert('Error', 'Please select a future start date and time');
      return;
    }

    if (endDateTime <= startDateTime) {
      Alert.alert('Error', 'End time must be after start time');
      return;
    }

    const jobDurationHours = (endDateTime.getTime() - startDateTime.getTime()) / (1000 * 60 * 60);
    if (jobDurationHours > 24) {
      Alert.alert('Error', 'Job duration cannot exceed 24 hours');
      return;
    }

    setLoading(true);
    try {
      const requestData = {
        workerPhone: worker.phone,
        date: date.toISOString().split('T')[0], // YYYY-MM-DD
        startTime: startTime.toTimeString().slice(0, 5), // HH:MM
        endTime: endTime.toTimeString().slice(0, 5), // HH:MM
        location: trimmedLocation,
        message: `Job request for ${worker.mainSkill || 'work'}`,
      };

      const response = await fetch(`${SERVER_URL}/workers/request-job`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestData),
      });

      const data = await response.json();

      if (data.success) {
        onRequestSent(worker.phone, data.requestId);
        resetForm();
        onClose();
        Alert.alert('Success', 'Job request sent successfully!');
      } else {
        Alert.alert('Error', data.message || 'Failed to send request');
        resetForm(); // Reset on error to prevent confusion
      }
    } catch (error) {
      console.error('Send request error:', error);
      Alert.alert('Error', 'Failed to send job request. Please try again.');
      resetForm(); // Reset on error
    } finally {
      setLoading(false);
    }
  }, [worker, location, date, startTime, endTime, accessToken, onRequestSent, resetForm, onClose]);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-IN', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTime = (time: Date) => {
    return time.toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  };

  if (!worker) return null;

  const content = (
    <KeyboardAvoidingView
      style={[styles.overlay, renderAsPanel && styles.centerOverlay]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <SafeAreaView style={renderAsPanel ? [styles.panelContainer, styles.centerPanel] : styles.container}>
            <View style={styles.modalContent} pointerEvents="box-none">
              <View style={styles.header}>
                <TouchableOpacity onPress={onClose} accessibilityLabel="Close modal">
                  <MaterialIcons name="close" size={28} color="#333" />
                </TouchableOpacity>
                <Text style={styles.headerTitle}>Send Job Request</Text>
                <View style={{ width: 28 }} />
              </View>

              <ScrollView
                style={styles.content}
                contentContainerStyle={styles.scrollContentContainer}
                showsVerticalScrollIndicator={false}
                nestedScrollEnabled={true}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
              >
                {/* Worker Info */}
                <View style={styles.workerInfo}>
                  <Text style={styles.workerName}>{worker.name || 'Unknown Worker'}</Text>
                  <Text style={styles.workerSkill}>{worker.mainSkill || 'Multi-skilled'}</Text>
                  <Text style={styles.workerWage}>₹{worker.expectedWage}/day</Text>
                </View>

                {/* Date Picker */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Date</Text>
                  <TouchableOpacity
                    style={styles.pickerButton}
                    onPress={() => setShowDatePicker(true)}
                    accessibilityLabel="Select date"
                  >
                    <Text style={styles.pickerText}>{formatDate(date)}</Text>
                    <MaterialIcons name="calendar-today" size={20} color="#667eea" />
                  </TouchableOpacity>
                </View>

                {/* Start Time Picker */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Start Time</Text>
                  <TouchableOpacity
                    style={styles.pickerButton}
                    onPress={() => setShowStartTimePicker(true)}
                    accessibilityLabel="Select start time"
                  >
                    <Text style={styles.pickerText}>{formatTime(startTime)}</Text>
                    <MaterialIcons name="schedule" size={20} color="#667eea" />
                  </TouchableOpacity>
                </View>

                {/* End Time Picker */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>End Time</Text>
                  <TouchableOpacity
                    style={styles.pickerButton}
                    onPress={() => setShowEndTimePicker(true)}
                    accessibilityLabel="Select end time"
                  >
                    <Text style={styles.pickerText}>{formatTime(endTime)}</Text>
                    <MaterialIcons name="schedule" size={20} color="#667eea" />
                  </TouchableOpacity>
                </View>

                {/* Location Input */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Location</Text>
                  <TextInput
                    style={styles.textInput}
                    placeholder="Enter job location"
                    value={location}
                    onChangeText={(text) => setLocation(text.slice(0, 200))}
                    multiline
                    numberOfLines={2}
                    accessibilityLabel="Job location"
                  />
                </View>
              </ScrollView>

              {/* Action Buttons */}
              <View style={styles.actions}>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={onClose}
                  disabled={loading}
                  accessibilityLabel="Cancel request"
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sendButton, loading && styles.sendButtonDisabled]}
                  onPress={handleSendRequest}
                  disabled={loading}
                  accessibilityLabel="Send job request"
                >
                  {loading ? (
                    <View style={styles.loadingContainer}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.sendText}>Sending...</Text>
                    </View>
                  ) : (
                    <Text style={styles.sendText}>Send Request</Text>
                  )}
                </TouchableOpacity>
              </View>

              {/* Date Picker Modal */}
              {showDatePicker && (
                <DateTimePicker
                  value={date}
                  mode="date"
                  display="default"
                  minimumDate={new Date()}
                  onChange={(event, selectedDate) => {
                    setShowDatePicker(false);
                    if (selectedDate) setDate(selectedDate);
                  }}
                />
              )}

              {/* Start Time Picker Modal */}
              {showStartTimePicker && (
                <DateTimePicker
                  value={startTime}
                  mode="time"
                  display="default"
                  onChange={(event, selectedTime) => {
                    setShowStartTimePicker(false);
                    if (selectedTime) setStartTime(selectedTime);
                  }}
                />
              )}

              {/* End Time Picker Modal */}
              {showEndTimePicker && (
                <DateTimePicker
                  value={endTime}
                  mode="time"
                  display="default"
                  onChange={(event, selectedTime) => {
                    setShowEndTimePicker(false);
                    if (selectedTime) setEndTime(selectedTime);
                  }}
                />
              )}
            </View>
      </SafeAreaView>
      </KeyboardAvoidingView>
    );

  if (renderAsPanel) {
    return (
      <View style={styles.panelOverlay}>
        {content}
      </View>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent={true} onRequestClose={onClose}>
      {content}
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    flex: 1,
  },
  container: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  centerOverlay: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  centerPanel: {
    width: '92%',
    borderRadius: 20,
    maxHeight: '90%',
    alignSelf: 'center',
    overflow: 'hidden',
  },
  content: {
    flex: 1,
    padding: 20,
  },
  scrollContentContainer: {
    flexGrow: 1,
    paddingBottom: 24,
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
  workerInfo: {
    backgroundColor: '#f8f9fa',
    padding: 16,
    borderRadius: 12,
    marginBottom: 20,
  },
  workerName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
    marginBottom: 4,
  },
  workerSkill: {
    fontSize: 14,
    color: '#666',
    marginBottom: 2,
  },
  workerWage: {
    fontSize: 14,
    color: '#2ECC71',
    fontWeight: '500',
  },
  field: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#333',
    marginBottom: 8,
  },
  pickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  pickerText: {
    fontSize: 16,
    color: '#333',
  },
  textInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    fontSize: 16,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  actions: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 12,
  },
  panelOverlay: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  panelContainer: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    minHeight: '80%',
    maxHeight: '100%',
  },
  cancelButton: {
    flex: 1,
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cancelText: {
    fontSize: 16,
    color: '#666',
    fontWeight: '500',
  },
  sendButton: {
    flex: 2,
    backgroundColor: '#667eea',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  sendButtonDisabled: {
    backgroundColor: '#ccc',
  },
  loadingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sendText: {
    fontSize: 16,
    color: '#fff',
    fontWeight: '600',
  },
});