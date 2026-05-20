import React, { useState, useCallback, useEffect } from 'react';
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
import { MaterialIcons, Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { MapView, Camera } from '@maplibre/maplibre-react-native';
import { locationPermissionHandler } from '../services/locationPermissionHandler';
import { useAuth } from '../context/AuthContext';
import api from '../utils/api';
import { SERVER_URL } from '../utils/config';

const MAPTILER_API_KEY = 'rmEy5CtIKMlSfVx4fckr';
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`;

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
  showWorkerInfo?: boolean;
}

export default function JobRequestModal({
  visible,
  renderAsPanel,
  onClose,
  worker,
  onRequestSent,
  showWorkerInfo = true,
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
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number }>({ lat: 26.9124, lon: 75.7873 });
  const [mapLoading, setMapLoading] = useState(false);
  const [selectedMapLocation, setSelectedMapLocation] = useState<{ lat: number; lon: number; placeName?: string } | null>(null);
  const [mapSearchQuery, setMapSearchQuery] = useState('');
  const [mapSearchResults, setMapSearchResults] = useState<Array<{ id: string; label: string; lat: number; lon: number }>>([]);
  const [mapSearchLoading, setMapSearchLoading] = useState(false);
  const [mapSearchError, setMapSearchError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);

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
    setSelectedMapLocation(null);
    setMapSearchQuery('');
    setMapSearchResults([]);
    setMapSearchError(null);
  }, []);

  // Fetch user location when modal opens (for broadcast mode)
  useEffect(() => {
    if (!visible || worker) return; // Skip if modal is closed or worker is selected (not broadcast)

    const initializeLocation = async () => {
      if (authUser?.location?.coordinates) {
        const [lon, lat] = authUser.location.coordinates;
        setUserLocation({ lat, lon });
        return;
      }

      try {
        const result = await locationPermissionHandler.getLocation();
        if (result.success && result.location) {
          setUserLocation({ lat: result.location.latitude, lon: result.location.longitude });
        }
      } catch (err) {
        console.error('Error getting location for broadcast:', err);
      }
    };

    initializeLocation();
  }, [visible, worker, authUser]);

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

  const onMapRegionDidChange = (event: any) => {
    const coordinates =
      event?.geometry?.coordinates ||
      event?.properties?.center ||
      event?.nativeEvent?.geometry?.coordinates ||
      event?.coordinates;

    if (!coordinates || coordinates.length < 2) return;
    const [lon, lat] = coordinates;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    setMapCenter({ lat, lon });
  };

  const searchMapLocation = async () => {
    if (!mapSearchQuery.trim()) {
      setMapSearchResults([]);
      return;
    }

    setMapSearchLoading(true);
    setMapSearchError(null);
    try {
      const response = await fetch(
        `https://api.maptiler.com/geocoding/${encodeURIComponent(mapSearchQuery.trim())}.json?key=${MAPTILER_API_KEY}&limit=5`
      );
      const results = await response.json();
      if (!results?.features) {
        throw new Error('No results found');
      }

      const mapped = results.features.map((feature: any) => ({
        id: feature.id || feature.properties?.id || `${feature.geometry?.coordinates?.[1]}-${feature.geometry?.coordinates?.[0]}`,
        label: feature.place_name || feature.properties?.name || '',
        lon: feature.geometry?.coordinates?.[0],
        lat: feature.geometry?.coordinates?.[1],
      }));
      setMapSearchResults(mapped);
    } catch (err: any) {
      console.error('Map search error:', err);
      setMapSearchError(err?.message || 'Unable to search location');
      setMapSearchResults([]);
    } finally {
      setMapSearchLoading(false);
    }
  };

  const selectMapSearchResult = (result: { id: string; label: string; lat: number; lon: number }) => {
    setMapCenter({ lat: result.lat, lon: result.lon });
    setMapSearchQuery(result.label);
    setMapSearchResults([]);
  };

  const confirmMapLocation = async () => {
    try {
      setMapLoading(true);
      let placeName = `${mapCenter.lat.toFixed(4)}, ${mapCenter.lon.toFixed(4)}`;
      try {
        const reverse = await Location.reverseGeocodeAsync({
          latitude: mapCenter.lat,
          longitude: mapCenter.lon,
        });
        if (reverse && reverse.length > 0) {
          const g = reverse[0];
          const parts = [g.name, g.street, g.subregion || g.region || g.city, g.postalCode, g.country].filter(Boolean);
          if (parts.length > 0) placeName = parts.join(', ');
        }
      } catch {
        // keep fallback coordinates
      }

      setSelectedMapLocation({
        lat: mapCenter.lat,
        lon: mapCenter.lon,
        placeName,
      });
      setLocation(placeName);
      setShowMapPicker(false);
      Alert.alert('Success', 'Location selected from map!');
    } catch (err) {
      Alert.alert('Error', 'Failed to select location from map. Please try again.');
    } finally {
      setMapLoading(false);
    }
  };

  const fetchCurrentLocation = useCallback(async () => {
    setFetchingLocation(true);
    try {
      const result = await locationPermissionHandler.getLocation();
      if (!result.success || !result.location) {
        Alert.alert('Location required', 'Please allow location access to use current location.');
        setLocationSource('manual');
        return;
      }

      const { latitude, longitude } = result.location;
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

  const showSuccess = useCallback(
    (message: string, workerPhone: string, requestId: string) => {
      setSuccessMessage(message);
      setShowSuccessOverlay(true);
      onRequestSent(workerPhone, requestId);

      setTimeout(() => {
        setShowSuccessOverlay(false);
        setSuccessMessage(null);
        resetForm();
        onClose();
      }, 1600);
    },
    [onRequestSent, resetForm, onClose]
  );

  const handleSendRequest = useCallback(async () => {
    if (!siteImageUri) {
      Alert.alert('Error', 'Please attach a site image before sending the request.');
      return;
    }

    if (locationSource === 'manual' && !selectedMapLocation) {
      Alert.alert('Error', 'Please select the job site from the map before sending the request.');
      return;
    }

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

    setLoading(true);
    try {
      let uploadedSiteImageUrl: string | undefined;
      if (siteImageUri) {
        if (!accessToken) {
          throw new Error('Missing auth token for image upload');
        }

        const imageFormData = new FormData();
        const candidateName = siteImageName || siteImageUri.split('/').pop() || `job-request-${Date.now()}.jpg`;
        const extension = candidateName.split('.').pop()?.split('?')[0].toLowerCase() || 'jpg';
        const fileType = extension === 'png' ? 'image/png' : 'image/jpeg';
        const fileName = candidateName.includes('.') ? candidateName : `job-request-${Date.now()}.${extension}`;

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
          let errorDescription = 'Failed to upload site image';
          try {
            const parsedError = JSON.parse(uploadText);
            errorDescription = parsedError.message || errorDescription;
          } catch {
            // keep original message
          }
          throw new Error(errorDescription);
        }

        const uploadJson = JSON.parse(uploadText);
        uploadedSiteImageUrl = uploadJson.imageUrl;
      }

      const workerCount = Number.parseInt(requiredWorkers, 10) || 1;
      const commonRequestData = {
        date: startDate.toISOString().split('T')[0],
        startTime: startTime.toTimeString().slice(0, 5),
        endTime: endTime.toTimeString().slice(0, 5),
        location: trimmedLocation,
        paymentFrequency,
        requiredWorkers: workerCount,
        siteImageUri: uploadedSiteImageUrl || undefined,
        message: worker ? `Job request for ${worker.mainSkill || 'work'}` : 'Job request - broadcast to nearby workers',
      };

      let response;

      if (worker) {
        // Individual request to specific worker
        const requestData = {
          workerPhone: worker.phone,
          ...commonRequestData,
        };
        response = await api.post('/workers/request-job', requestData);

        if (response.data?.success) {
          showSuccess('Job request sent successfully!', worker.phone, response.data.requestId);
        } else {
          Alert.alert('Error', response.data?.message || 'Failed to send request');
          resetForm();
        }
      } else {
        // Broadcast request to all workers within 80 km
        const broadcastAnchor =
          locationSource === 'manual' && selectedMapLocation
            ? selectedMapLocation
            : userLocation;

        if (!broadcastAnchor) {
          throw new Error('Location not available for broadcast');
        }

        const broadcastRequestData = {
          lat: broadcastAnchor.lat,
          lon: broadcastAnchor.lon,
          ...commonRequestData,
        };
        response = await api.post('/workers/broadcast-job-request', broadcastRequestData);

        if (response.data?.success) {
          showSuccess(
            `Job request broadcasted to ${response.data.sentCount || 0} worker(s) within 80 km radius!`,
            'broadcast',
            response.data.broadcastRequestIds?.[0] || String(response.data.sentCount || 0)
          );
        } else {
          Alert.alert('Error', response.data?.message || 'Failed to broadcast request');
          resetForm();
        }
      }
    } catch (error) {
      console.error('Send request error:', error);
      Alert.alert('Error', 'Failed to send job request. Please try again.');
      resetForm();
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
    userLocation,
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
                {showWorkerInfo && (
                <View style={styles.workerInfo}>
                  <View style={styles.workerInfoRow}>
                    <View style={styles.workerInfoLeft}>
                      <View style={styles.avatarContainer}>
                        {worker?.profilePhoto ? (
                          <Image source={{ uri: worker.profilePhoto }} style={styles.avatarImage} />
                        ) : (
                          <View style={styles.avatarFallback}>
                            <MaterialIcons name="person" size={28} color="#667eea" />
                          </View>
                        )}
                      </View>
                      <View style={styles.workerDetails}>
                        <Text style={styles.workerName}>{worker?.name || 'Unknown Worker'}</Text>
                        <Text style={styles.workerSkill}>{worker?.mainSkill || 'Multi-skilled'}</Text>
                        <Text style={styles.workerWage}>₹{worker?.expectedWage}/day</Text>
                      </View>
                    </View>
                    <View style={styles.workerMeta}>
                      <View style={[styles.statusBadge, worker?.isAvailable ? styles.online : styles.offline]}>
                        <MaterialIcons
                          name={worker?.isAvailable ? 'check-circle' : 'highlight-off'}
                          size={12}
                          color="#fff"
                        />
                        <Text style={styles.statusText}>
                          {worker?.isAvailable ? 'Online' : 'Offline'}
                        </Text>
                      </View>
                      <View style={styles.verifiedBadge}>
                        <MaterialIcons name="verified" size={18} color="#fff" />
                      </View>
                    </View>
                  </View>
                </View>
                )}

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
                    <View>
                      <TouchableOpacity
                        style={styles.mapPickerButton}
                        onPress={() => {
                          setShowMapPicker(true);
                          if (selectedMapLocation) {
                            setMapCenter({ lat: selectedMapLocation.lat, lon: selectedMapLocation.lon });
                          } else if (userLocation) {
                            setMapCenter({ lat: userLocation.lat, lon: userLocation.lon });
                          }
                        }}
                      >
                        <Ionicons name="map" size={18} color="#fff" />
                        <Text style={styles.mapPickerButtonText}>Select Location from Map</Text>
                      </TouchableOpacity>
                      {selectedMapLocation ? (
                        <View style={styles.selectedLocationBox}>
                          <MaterialIcons name="location-on" size={18} color="#667eea" />
                          <Text style={styles.selectedLocationText} numberOfLines={2}>
                            {selectedMapLocation.placeName}
                          </Text>
                        </View>
                      ) : (
                        <TextInput
                          style={styles.textInput}
                          placeholder="Enter job location or select from map"
                          value={location}
                          onChangeText={(text) => setLocation(text.slice(0, 200))}
                          multiline
                          numberOfLines={2}
                          accessibilityLabel="Job location"
                        />
                      )}
                    </View>
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
                  disabled={loading || showSuccessOverlay}
                  accessibilityLabel="Cancel request"
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.sendButton, (loading || showSuccessOverlay) && styles.sendButtonDisabled]}
                  onPress={handleSendRequest}
                  disabled={loading || showSuccessOverlay}
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

              {showSuccessOverlay && (
                <View style={styles.successOverlay} pointerEvents="box-none">
                  <View style={styles.successCard}>
                    <MaterialIcons name="check-circle" size={80} color="#2ecc71" />
                    <Text style={styles.successTitle}>Success!</Text>
                    <Text style={styles.successMessage}>{successMessage}</Text>
                  </View>
                </View>
              )}

              {/* Map Picker Modal */}
              <Modal
                visible={showMapPicker}
                animationType="slide"
                transparent={false}
                onRequestClose={() => setShowMapPicker(false)}
              >
                <SafeAreaView style={styles.mapModalContainer}>
                  <View style={styles.mapHeader}>
                    <Text style={styles.mapHeaderTitle}>Select Job Location</Text>
                    <TouchableOpacity onPress={() => setShowMapPicker(false)}>
                      <Ionicons name="close" size={24} color="#fff" />
                    </TouchableOpacity>
                  </View>

                  <View style={styles.mapSearchArea}>
                    <View style={styles.mapSearchInputRow}>
                      <TextInput
                        style={styles.mapSearchInput}
                        placeholder="Search address or place"
                        placeholderTextColor="#94a3b8"
                        value={mapSearchQuery}
                        onChangeText={(text) => setMapSearchQuery(text)}
                        onSubmitEditing={searchMapLocation}
                        returnKeyType="search"
                        clearButtonMode="while-editing"
                      />
                      <TouchableOpacity style={styles.mapSearchButton} onPress={searchMapLocation} disabled={mapSearchLoading}>
                        <Ionicons name="search" size={20} color="#fff" />
                      </TouchableOpacity>
                    </View>
                    {mapSearchLoading ? (
                      <Text style={styles.mapSearchStatus}>Searching...</Text>
                    ) : mapSearchError ? (
                      <Text style={styles.mapSearchError}>{mapSearchError}</Text>
                    ) : null}
                    {mapSearchResults.length > 0 && (
                      <View style={styles.mapSearchResults}>
                        {mapSearchResults.map((result) => (
                          <TouchableOpacity
                            key={result.id}
                            style={styles.mapSearchResultItem}
                            onPress={() => selectMapSearchResult(result)}
                          >
                            <Text style={styles.mapSearchResultText}>{result.label}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>

                  <View style={styles.mapWrapper}>
                    <MapView
                      style={StyleSheet.absoluteFillObject}
                      mapStyle={MAP_STYLE_URL}
                      logoEnabled={false}
                      attributionEnabled={false}
                      onRegionDidChange={onMapRegionDidChange}
                    >
                      <Camera
                        centerCoordinate={[mapCenter.lon, mapCenter.lat]}
                        zoomLevel={14}
                        animationDuration={400}
                      />
                    </MapView>
                    <View style={styles.mapCenterPin}>
                      <Ionicons name="location" size={24} color="#fff" />
                    </View>
                  </View>

                  <View style={styles.mapFooter}>
                    <Text style={styles.mapHint}>Move the map to position the pin at the job site.</Text>
                    <TouchableOpacity style={styles.confirmMapBtn} onPress={confirmMapLocation} disabled={mapLoading}>
                      {mapLoading ? (
                        <ActivityIndicator size="small" color="#fff" />
                      ) : (
                        <Text style={styles.confirmMapBtnText}>Confirm Location</Text>
                      )}
                    </TouchableOpacity>
                  </View>
                </SafeAreaView>
              </Modal>
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
  mapPickerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#2563eb',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  mapPickerButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  selectedLocationBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    backgroundColor: '#eef2ff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#dbeafe',
  },
  selectedLocationText: {
    flex: 1,
    color: '#1e3a8a',
    fontSize: 14,
  },
  mapSearchArea: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    backgroundColor: '#0b1d33',
  },
  mapSearchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  mapSearchInput: {
    flex: 1,
    backgroundColor: '#14263f',
    color: '#fff',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    borderWidth: 1,
    borderColor: '#1e3a8a',
  },
  mapSearchButton: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: '#2563eb',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mapSearchStatus: {
    color: '#cbd5e1',
    marginTop: 8,
    fontSize: 13,
  },
  mapSearchError: {
    color: '#fca5a5',
    marginTop: 8,
    fontSize: 13,
  },
  mapSearchResults: {
    marginTop: 10,
    backgroundColor: '#14263f',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e3a8a',
    maxHeight: 180,
  },
  mapSearchResultItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#0f172a',
  },
  mapSearchResultText: {
    color: '#fff',
    fontSize: 14,
  },
  mapModalContainer: {
    flex: 1,
    backgroundColor: '#0b1d33',
  },
  mapHeader: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#102a46',
  },
  mapHeaderTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
  },
  mapWrapper: {
    flex: 1,
    backgroundColor: '#0b1d33',
  },
  mapCenterPin: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    marginLeft: -18,
    marginTop: -36,
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
  },
  mapFooter: {
    padding: 14,
    backgroundColor: '#102a46',
  },
  mapHint: {
    color: '#c9d8e8',
    fontSize: 12,
    marginBottom: 10,
  },
  confirmMapBtn: {
    height: 44,
    borderRadius: 12,
    backgroundColor: '#1a5c3a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmMapBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
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
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255,255,255,0.95)',
    zIndex: 50,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 30,
  },
  successCard: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: '#fff',
    borderRadius: 18,
    padding: 28,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.08,
    shadowRadius: 20,
    elevation: 10,
  },
  successTitle: {
    marginTop: 18,
    fontSize: 24,
    fontWeight: '700',
    color: '#2ecc71',
  },
  successMessage: {
    marginTop: 10,
    fontSize: 16,
    textAlign: 'center',
    color: '#334155',
    lineHeight: 22,
  },
});