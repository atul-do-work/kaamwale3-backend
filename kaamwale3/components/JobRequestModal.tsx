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
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
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
  isVerified?: boolean;
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
  const { user: authUser, accessToken } = useAuth();

  // Form state
  const [startDate, setStartDate] = useState(new Date());
  const [endDate, setEndDate] = useState(new Date());
  const [startTime, setStartTime] = useState(new Date());
  const [endTime, setEndTime] = useState(new Date());
  const [paymentFrequency, setPaymentFrequency] = useState<'daily' | 'weekly' | 'monthly'>('daily');
  const [siteImageUri, setSiteImageUri] = useState<string | null>(null);
  const [siteImageName, setSiteImageName] = useState<string | null>(null);
  const [location, setLocation] = useState('');
  const [locationSource, setLocationSource] = useState<'manual' | 'current'>('manual');
  const [currentLocationLabel, setCurrentLocationLabel] = useState('');
  const [requiredWorkers, setRequiredWorkers] = useState('1');
  const [fetchingLocation, setFetchingLocation] = useState(false);
  const [loading, setLoading] = useState(false);

  // Picker visibility
  const [showStartDatePicker, setShowStartDatePicker] = useState(false);
  const [showEndDatePicker, setShowEndDatePicker] = useState(false);
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);

  const resetForm = useCallback(() => {
    const now = new Date();
    setStartDate(now);
    setEndDate(now);
    setStartTime(now);
    setEndTime(now);
    setPaymentFrequency('daily');
    setSiteImageUri(null);
    setSiteImageName(null);
    setLocation('');
    setLocationSource('manual');
    setCurrentLocationLabel('');
    setRequiredWorkers('1');
  }, []);

  const pickSiteImage = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Image access required', 'Please allow access to your photos to upload a site image.');
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.7,
      });

      if (!result.canceled && result.assets?.length) {
        const asset = result.assets[0];
        setSiteImageUri(asset.uri);
        setSiteImageName(asset.fileName || asset.uri.split('/').pop() || 'site-image');
      }
    } catch (err) {
      console.error('Image picker error:', err);
      Alert.alert('Image upload failed', 'Unable to select an image. Please try again.');
    }
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

    const parsedWorkerCount = Number.parseInt(requiredWorkers, 10);
    if (!Number.isInteger(parsedWorkerCount) || parsedWorkerCount < 1) {
      Alert.alert('Error', 'Please enter a valid number of required workers');
      return;
    }

    const now = new Date();
    const startDateTime = new Date(startDate);
    startDateTime.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
    const endDateTime = new Date(endDate);
    endDateTime.setHours(endTime.getHours(), endTime.getMinutes(), 0, 0);

    if (endDate < startDate) {
      Alert.alert('Error', 'End date cannot be earlier than start date');
      return;
    }

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
      let uploadedSiteImageUrl: string | undefined;
      if (siteImageUri) {
        if (!accessToken) {
          throw new Error('Missing auth token for image upload');
        }

        const imageFormData = new FormData();
        const extension = siteImageUri.split('.').pop()?.toLowerCase() || 'jpg';
        const fileType = extension === 'png' ? 'image/png' : 'image/jpeg';
        const fileName = `job-request-${Date.now()}.${extension}`;

        imageFormData.append('photo', {
          uri: siteImageUri,
          name: fileName,
          type: fileType,
        } as any);

        const uploadResponse = await fetch(`${SERVER_URL}/jobs/upload-image`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: imageFormData,
        });

        const uploadText = await uploadResponse.text();
        if (!uploadResponse.ok) {
          console.error('Site image upload failed:', uploadResponse.status, uploadText);
          throw new Error('Failed to upload site image');
        }

        const uploadJson = JSON.parse(uploadText);
        uploadedSiteImageUrl = uploadJson.imageUrl;
      }

      const workerCount = Number.parseInt(requiredWorkers, 10) || 1;
      const requestData = {
        workerPhone: worker.phone,
        date: startDate.toISOString().split('T')[0],
        startDate: startDate.toISOString().split('T')[0],
        endDate: endDate.toISOString().split('T')[0],
        startTime: startTime.toTimeString().slice(0, 5),
        endTime: endTime.toTimeString().slice(0, 5),
        location: trimmedLocation,
        paymentFrequency,
        requiredWorkers: workerCount,
        siteImageUri: uploadedSiteImageUrl || undefined,
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
  }, [
    worker,
    location,
    startDate,
    endDate,
    startTime,
    endTime,
    requiredWorkers,
    paymentFrequency,
    locationSource,
    currentLocationLabel,
    siteImageUri,
    accessToken,
    onRequestSent,
    resetForm,
    onClose,
  ]);

  const formatDate = (date: Date) => {
    return date.toLocaleDateString('en-IN', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  };

  const formatTime = (time: Date) => {
    const formatted = time.toLocaleTimeString('en-IN', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    return formatted.replace(':00', '').toLowerCase();
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
                  <View style={styles.workerInfoRow}>
                    <View style={styles.workerInfoLeft}>
                      <View style={styles.avatarContainer}>
                        {worker.profilePhoto ? (
                          <Image source={{ uri: worker.profilePhoto }} style={styles.avatarImage} />
                        ) : (
                          <View style={styles.avatarFallback}>
                            <MaterialIcons name="person" size={28} color="#667eea" />
                          </View>
                        )}
                      </View>
                      <View style={styles.workerDetails}>
                        <Text style={styles.workerName}>{worker.name || 'Unknown Worker'}</Text>
                        <Text style={styles.workerSkill}>{worker.mainSkill || 'Multi-skilled'}</Text>
                        <Text style={styles.workerWage}>₹{worker.expectedWage}/day</Text>
                      </View>
                    </View>
                    <View style={styles.workerMeta}>
                      <View style={[styles.statusBadge, worker.isAvailable ? styles.online : styles.offline]}>
                        <MaterialIcons
                          name={worker.isAvailable ? 'check-circle' : 'highlight-off'}
                          size={12}
                          color="#fff"
                        />
                        <Text style={styles.statusText}>
                          {worker.isAvailable ? 'Online' : 'Offline'}
                        </Text>
                      </View>
                      <View style={styles.verifiedBadge}>
                        <MaterialIcons name="verified" size={18} color="#fff" />
                      </View>
                    </View>
                  </View>
                </View>

                {/* Payment Frequency */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Payment frequency</Text>
                  <View style={styles.frequencyRow}>
                    {[
                      { value: 'daily' as const, label: 'Daily' },
                      { value: 'weekly' as const, label: 'Weekly' },
                      { value: 'monthly' as const, label: 'Monthly' },
                    ].map((option) => (
                      <TouchableOpacity
                        key={option.value}
                        style={[
                          styles.frequencyChip,
                          paymentFrequency === option.value && styles.frequencyChipSelected,
                        ]}
                        onPress={() => setPaymentFrequency(option.value)}
                      >
                        <Text
                          style={[
                            styles.frequencyText,
                            paymentFrequency === option.value && styles.frequencyTextSelected,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Date Range */}
                <View style={[styles.field, styles.splitRow]}> 
                  <View style={styles.splitColumn}>
                    <Text style={styles.fieldLabel}>Start date</Text>
                    <View style={styles.pickerWithIcon}>
                      <TouchableOpacity
                        style={styles.pickerButtonNoIcon}
                        onPress={() => setShowStartDatePicker(true)}
                        accessibilityLabel="Select start date"
                      >
                        <Text style={styles.pickerText}>{formatDate(startDate)}</Text>
                      </TouchableOpacity>
                      <View style={styles.pickerIconOutside}>
                        <MaterialIcons name="schedule" size={20} color="#667eea" />
                      </View>
                    </View>
                  </View>
                  <View style={styles.splitColumn}>
                    <Text style={styles.fieldLabel}>End date</Text>
                    <View style={styles.pickerWithIcon}>
                      <TouchableOpacity
                        style={styles.pickerButtonNoIcon}
                        onPress={() => setShowEndDatePicker(true)}
                        accessibilityLabel="Select end date"
                      >
                        <Text style={styles.pickerText}>{formatDate(endDate)}</Text>
                      </TouchableOpacity>
                      <View style={styles.pickerIconOutside}>
                        <MaterialIcons name="schedule" size={20} color="#667eea" />
                      </View>
                    </View>
                  </View>
                </View>

                {/* Time Range */}
                <View style={[styles.field, styles.splitRow]}>
                  <View style={styles.splitColumn}>
                    <Text style={styles.fieldLabel}>Start time</Text>
                    <TouchableOpacity
                      style={styles.pickerButton}
                      onPress={() => setShowStartTimePicker(true)}
                      accessibilityLabel="Select start time"
                    >
                      <Text style={styles.pickerText}>{formatTime(startTime)}</Text>
                      <MaterialIcons name="schedule" size={20} color="#667eea" />
                    </TouchableOpacity>
                  </View>
                  <View style={styles.splitColumn}>
                    <Text style={styles.fieldLabel}>End time</Text>
                    <TouchableOpacity
                      style={styles.pickerButton}
                      onPress={() => setShowEndTimePicker(true)}
                      accessibilityLabel="Select end time"
                    >
                      <Text style={styles.pickerText}>{formatTime(endTime)}</Text>
                      <MaterialIcons name="schedule" size={20} color="#667eea" />
                    </TouchableOpacity>
                  </View>
                </View>

                {/* Site Image Upload */}
                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Site image</Text>
                  <TouchableOpacity style={styles.uploadButton} onPress={pickSiteImage} accessibilityLabel="Upload site image">
                    <MaterialIcons name="photo-camera" size={20} color="#667eea" />
                    <Text style={styles.uploadText}>{siteImageUri ? 'Change Image' : 'Upload Image'}</Text>
                  </TouchableOpacity>
                  {siteImageUri ? (
                    <View style={styles.imagePreviewContainer}>
                      <Text style={styles.imagePreviewText} numberOfLines={1}>
                        {siteImageName}
                      </Text>
                    </View>
                  ) : (
                    <Text style={styles.helpText}>Attach a photo of the site or work area for better clarity.</Text>
                  )}
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

                <View style={styles.field}>
                  <Text style={styles.fieldLabel}>Workers Required</Text>
                  <TextInput
                    style={styles.numberInput}
                    placeholder="Enter number of workers"
                    value={requiredWorkers}
                    onChangeText={(text) => setRequiredWorkers(text.replace(/[^0-9]/g, ''))}
                    keyboardType="number-pad"
                    maxLength={2}
                    accessibilityLabel="Required number of workers"
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

              {/* Start Date Picker Modal */}
              {showStartDatePicker && (
                <DateTimePicker
                  value={startDate}
                  mode="date"
                  display="default"
                  minimumDate={new Date()}
                  onChange={(event, selectedDate) => {
                    setShowStartDatePicker(false);
                    if (selectedDate) {
                      setStartDate(selectedDate);
                      if (selectedDate > endDate) {
                        setEndDate(selectedDate);
                      }
                    }
                  }}
                />
              )}

              {/* End Date Picker Modal */}
              {showEndDatePicker && (
                <DateTimePicker
                  value={endDate}
                  mode="date"
                  display="default"
                  minimumDate={startDate}
                  onChange={(event, selectedDate) => {
                    setShowEndDatePicker(false);
                    if (selectedDate) setEndDate(selectedDate);
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
  workerInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  workerInfoLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
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
  avatarContainer: {
    width: 60,
    height: 60,
    borderRadius: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    overflow: 'hidden',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  avatarFallback: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#e7ebff',
  },
  workerDetails: {
    flex: 1,
  },
  workerMeta: {
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    marginLeft: 12,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    minWidth: 78,
    marginBottom: 8,
  },
  online: {
    backgroundColor: '#2ecc71',
  },
  offline: {
    backgroundColor: '#d1d5db',
  },
  statusText: {
    marginLeft: 6,
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  verifiedBadge: {
    width: 34,
    height: 34,
    borderRadius: 18,
    backgroundColor: '#667eea',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 6,
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
  frequencyRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10,
  },
  frequencyChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f5f5f5',
    borderWidth: 1,
    borderColor: '#d1d5db',
    alignItems: 'center',
  },
  frequencyChipSelected: {
    backgroundColor: '#667eea',
    borderColor: '#667eea',
  },
  frequencyText: {
    fontSize: 14,
    color: '#333',
    fontWeight: '600',
  },
  frequencyTextSelected: {
    color: '#fff',
  },
  splitRow: {
    flexDirection: 'row',
    gap: 12,
  },
  splitColumn: {
    flex: 1,
  },
  pickerWithIcon: {
    position: 'relative',
  },
  pickerButtonNoIcon: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-start',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingRight: 20,
  },
  pickerIconOutside: {
    position: 'absolute',
    right: 10,
    top: '50%',
    transform: [{ translateY: -12 }],
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
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
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  uploadText: {
    color: '#333',
    fontSize: 15,
    fontWeight: '600',
  },
  imagePreviewContainer: {
    marginTop: 10,
    borderRadius: 10,
    backgroundColor: '#eef2ff',
    padding: 12,
  },
  imagePreviewText: {
    color: '#333',
    fontSize: 14,
  },
  helpText: {
    marginTop: 8,
    color: '#667eea',
    fontSize: 13,
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
  fieldGroup: {
    marginTop: 12,
  },
  numberInput: {
    backgroundColor: '#f5f5f5',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: '#333',
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