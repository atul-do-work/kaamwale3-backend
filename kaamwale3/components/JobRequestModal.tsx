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
import * as Location from 'expo-location';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';

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
  const { user: authUser } = useAuth();

  // Form state
  const [date, setDate] = useState(new Date());
  const [startTime, setStartTime] = useState(new Date());
  const [endTime, setEndTime] = useState(new Date());
  const [location, setLocation] = useState('');
  const [locationSource, setLocationSource] = useState<'manual' | 'current'>('manual');
  const [currentLocationLabel, setCurrentLocationLabel] = useState('');
  const [fetchingLocation, setFetchingLocation] = useState(false);
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
    setLocationSource('manual');
    setCurrentLocationLabel('');
  }, []);

  const fetchCurrentLocation = useCallback(async () => {
    setFetchingLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Location required', 'Please allow location access to use current location.');
        setLocationSource('manual');
        return;
      }

      const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest });
      const { latitude, longitude } = position.coords;
      const geocoded = await Location.reverseGeocodeAsync({ latitude, longitude });
      const place = geocoded[0];
      const address = place
        ? [
            place.name,
            place.street,
            place.subregion || place.district || place.city || place.region || '',
            place.postalCode,
          ]
            .filter(Boolean)
            .join(', ')
        : `Lat ${latitude.toFixed(5)}, Lon ${longitude.toFixed(5)}`;
      const normalized = address.length > 0 ? address : `Lat ${latitude.toFixed(5)}, Lon ${longitude.toFixed(5)}`;

      setCurrentLocationLabel(normalized);
      setLocation(normalized);
    } catch (err) {
      console.error('Failed to fetch current location:', err);
      Alert.alert('Location error', 'Unable to retrieve current location. Please try again or use manual location.');
      setLocationSource('manual');
    } finally {
      setFetchingLocation(false);
    }
  }, []);

  const handleSendRequest = useCallback(async () => {
    if (!worker) return;

    // Validation
    if (locationSource === 'current' && !currentLocationLabel) {
      Alert.alert('Error', 'Please fetch your current location before sending the request.');
      return;
    }

    const trimmedLocation = (locationSource === 'current' ? currentLocationLabel : location).trim();
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

      const response = await api.post('/workers/request-job', requestData);

      if (response.data?.success) {
        onRequestSent(worker.phone, response.data.requestId);
        resetForm();
        onClose();
        Alert.alert('Success', 'Job request sent successfully!');
      } else {
        Alert.alert('Error', response.data?.message || 'Failed to send request');
        resetForm(); // Reset on error to prevent confusion
      }
    } catch (error) {
      console.error('Send request error:', error);
      Alert.alert('Error', 'Failed to send job request. Please try again.');
      resetForm(); // Reset on error
    } finally {
      setLoading(false);
    }
  }, [worker, location, date, startTime, endTime, onRequestSent, resetForm, onClose]);

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

                  <View style={styles.locationToggleRow}>
                    <TouchableOpacity
                      style={[
                        styles.locationToggleButton,
                        locationSource === 'manual' && styles.locationToggleButtonActive,
                      ]}
                      onPress={() => setLocationSource('manual')}
                    >
                      <MaterialIcons name="edit" size={18} color={locationSource === 'manual' ? '#fff' : '#333'} />
                      <Text style={[styles.locationToggleText, locationSource === 'manual' && styles.locationToggleTextActive]}>
                        Manual
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={[
                        styles.locationToggleButton,
                        locationSource === 'current' && styles.locationToggleButtonActive,
                      ]}
                      onPress={() => {
                        setLocationSource('current');
                        if (!currentLocationLabel) {
                          fetchCurrentLocation();
                        }
                      }}
                    >
                      <MaterialIcons name="my-location" size={18} color={locationSource === 'current' ? '#fff' : '#333'} />
                      <Text style={[styles.locationToggleText, locationSource === 'current' && styles.locationToggleTextActive]}>
                        Current
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {locationSource === 'manual' ? (
                    <TextInput
                      style={styles.textInput}
                      placeholder="Enter job location"
                      value={location}
                      onChangeText={(text) => setLocation(text.slice(0, 200))}
                      multiline
                      numberOfLines={2}
                      accessibilityLabel="Job location"
                    />
                  ) : (
                    <View style={styles.currentLocationContainer}>
                      <Text style={styles.currentLocationLabel} numberOfLines={2}>
                        {currentLocationLabel || 'Fetching current location...'}
                      </Text>
                      <TouchableOpacity
                        style={styles.refreshLocationButton}
                        onPress={fetchCurrentLocation}
                        disabled={fetchingLocation}
                      >
                        <MaterialIcons name="refresh" size={20} color="#667eea" />
                      </TouchableOpacity>
                    </View>
                  )}
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
  locationToggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  locationToggleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingVertical: 10,
    backgroundColor: '#fafafa',
  },
  locationToggleButtonActive: {
    backgroundColor: '#667eea',
    borderColor: '#667eea',
  },
  locationToggleText: {
    fontSize: 13,
    color: '#333',
    fontWeight: '600',
  },
  locationToggleTextActive: {
    color: '#fff',
  },
  currentLocationContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f7ff',
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  currentLocationLabel: {
    flex: 1,
    color: '#333',
    fontSize: 15,
    marginRight: 12,
  },
  refreshLocationButton: {
    padding: 8,
    borderRadius: 999,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  actions: {
    flexDirection: 'row',
    padding: 20,
    borderTopWidth: 1,
    borderTopColor: '#f0f0f0',
    gap: 12,
  },
  panelOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
    zIndex: 999,
  },
  panelContainer: {
    flex: 1,
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
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