import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Image, ActivityIndicator, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { MapView, Camera } from '@maplibre/maplibre-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { socket } from "../../../utils/socket";
import { SERVER_URL } from "../../../utils/config";
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from "expo-router";  // ⭐ ADDED
import { useLanguage } from "../../../context/LanguageContext";
import { useAuth } from "../../../context/AuthContext";
import { useJobStatus } from "../../../hooks/useJobStatus"; // ✅ Real-time job status
import { premiumCacheManager } from "../../../utils/premiumCacheManager";
import { isPremiumPlanActive } from "../../../utils/premiumPlanState";

interface JobPayload {
  title: string;
  description: string;
  workerType: string;
  amount: string;
  contractorName: string;
  lat: number;
  lon: number;
  date: string;
  numberOfDays?: number;
  bulkHiring?: boolean;
  requiredWorkers?: number;
  idempotencyKey?: string;
}

const JOB_TITLES = [
  { value: 'Construction', labelKey: 'construction' as const },
  { value: 'Renovation', labelKey: 'renovation' as const },
  { value: 'Other', labelKey: 'otherOption' as const },
];
const MAIN_SKILLS = [
  { value: 'Labour', labelKey: 'labour' as const },
  { value: 'Mason', labelKey: 'mason' as const },
  { value: 'Engineer', labelKey: 'engineer' as const },
  { value: 'ITI/Technician', labelKey: 'itiTechnician' as const },
];
const MASON_TYPES = [
  { value: 'Tile Mason', labelKey: 'tileMason' as const },
  { value: 'Stone Mason', labelKey: 'stoneMason' as const },
  { value: 'Cement Mason', labelKey: 'cementMason' as const },
  { value: 'Composite Mason', labelKey: 'compositeMason' as const },
  { value: 'Bar Bender', labelKey: 'barBender' as const },
];
const BULK_HIRING_OPTIONS = [1, 2, 3, 5, 10];
const MAPTILER_API_KEY = "rmEy5CtIKMlSfVx4fckr";
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`;

export default function PostJobScreen() {
  const { t } = useLanguage();
  const { accessToken } = useAuth();
  const [title, setTitle] = useState('');
  const [mainSkill, setMainSkill] = useState('');
  const [workerType, setWorkerType] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [startTime, setStartTime] = useState(new Date());
  const [showStartTimePicker, setShowStartTimePicker] = useState(false);
  const [endTime, setEndTime] = useState(new Date());
  const [showEndTimePicker, setShowEndTimePicker] = useState(false);
  const [contractorName, setContractorName] = useState('Contractor');
  const [token, setToken] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const previousUserPhoneRef = useRef<string | null>(null); // ✅ Track previous user to detect changes
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{ lat: number; lon: number; placeName?: string } | null>(null);
  const [showTitleDropdown, setShowTitleDropdown] = useState(false);
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [showWorkerTypeDropdown, setShowWorkerTypeDropdown] = useState(false);
  const [priceError, setPriceError] = useState(false);
  const [hasPremium, setHasPremium] = useState(false); // ✅ Active premium status from backend
  const [bulkHiringEnabled, setBulkHiringEnabled] = useState(false); // ✅ Bulk hiring toggle
  const [requiredWorkers, setRequiredWorkers] = useState(1); // ✅ Number of workers needed
  const [numberOfDays, setNumberOfDays] = useState(1); // ✅ Job duration in days (1-30)
  const [showDaysDropdown, setShowDaysDropdown] = useState(false); // ✅ Days dropdown toggle
  const [gettingLocation, setGettingLocation] = useState(false); // ✅ Loading state for current location
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [mapLoading, setMapLoading] = useState(false);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lon: number }>({ lat: 26.9124, lon: 75.7873 });
  const [isPostingJob, setIsPostingJob] = useState(false); // ✅ Loading state for posting job
  const [showImagePreviewHold, setShowImagePreviewHold] = useState(false);

  // SERVER_URL is loaded from central config
  const router = useRouter();   // ⭐ ADDED

  // ✅ Helper: Format time as HH:MM AM/PM for consistent display across Android devices
  const formatTimeDisplay = (date: Date): string => {
    let hours = date.getHours() % 12 || 12;
    const mins = date.getMinutes().toString().padStart(2, '0');
    const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
    return `${hours}:${mins} ${ampm}`;
  };

  const getJobTitleLabel = (value: string) =>
    t(JOB_TITLES.find((item) => item.value === value)?.labelKey || 'jobTitle');

  const getSkillLabel = (value: string) =>
    t(MAIN_SKILLS.find((item) => item.value === value)?.labelKey || 'mainSkill');

  const getWorkerTypeLabel = (value: string) =>
    t(MASON_TYPES.find((item) => item.value === value)?.labelKey || 'workerType');

  const toSafeBalance = (payload: any): number => {
    const raw =
      typeof payload === "number"
        ? payload
        : payload?.pocketBalance ??
          payload?.wallet?.pocketBalance ??
          payload?.balance ??
          payload?.wallet?.balance ??
          0;
    const num = Number(raw);
    return Number.isFinite(num) ? num : 0;
  };

  // ✅ Consolidated user & token loading - single source of truth (no duplicated logic)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const userStr = await AsyncStorage.getItem("user");
          const storedToken = accessToken || await AsyncStorage.getItem("accessToken") || await AsyncStorage.getItem("token");
          
          // ✅ Safer: Parse user with try/catch to handle corrupted storage
          let user = null;
          try {
            user = userStr ? JSON.parse(userStr) : null;
          } catch {
            user = null;
          }
          const userPhone = user?.phone ?? null;
          
          // Load token
          setToken(storedToken || null);
          
          // Check for user changes
          if (userPhone && userPhone !== previousUserPhoneRef.current) {
            console.log(`👤 Postjobs: Contractor changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting wallet`);
            previousUserPhoneRef.current = userPhone;
            setWalletBalance(0);
            setHasPremium(false);
            setBulkHiringEnabled(false);
            setRequiredWorkers(1);
            setNumberOfDays(1);
          } else if (!userPhone && previousUserPhoneRef.current !== null) {
            console.log(`👤 Postjobs: User logged out, resetting wallet`);
            previousUserPhoneRef.current = null;
            setWalletBalance(0);
            setHasPremium(false);
            setBulkHiringEnabled(false);
            setRequiredWorkers(1);
            setNumberOfDays(1);
          }

          if (user?.name) setContractorName(user.name);

          if (storedToken) {
            try {
              const premiumData = await premiumCacheManager.getStatus(storedToken);
              const fallbackPlan = premiumData?.premiumDetails || user?.premiumPlan || null;
              const isActive = premiumData?.success
                ? Boolean(premiumData?.isActive)
                : isPremiumPlanActive(fallbackPlan);

              setHasPremium(isActive);

              if (!isActive) {
                setBulkHiringEnabled(false);
                setRequiredWorkers(1);
                setNumberOfDays(1);
              }
            } catch (premiumErr) {
              console.warn("Failed to load premium status in postjobs", premiumErr);
              const hasStoredPremium = isPremiumPlanActive(user?.premiumPlan);
              setHasPremium(hasStoredPremium);
              if (!hasStoredPremium) {
                setBulkHiringEnabled(false);
                setRequiredWorkers(1);
                setNumberOfDays(1);
              }
            }
          } else {
            setHasPremium(false);
            setBulkHiringEnabled(false);
            setRequiredWorkers(1);
            setNumberOfDays(1);
          }
        } catch (err) {
          console.error("Failed to load user/token in postjobs", err);
        }
      })();
    }, [accessToken])
  );

  // Fetch wallet balance using the balance endpoint to get contractor pocket balance directly.
  const fetchWallet = React.useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${SERVER_URL}/wallet/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = await res.text();
      let data: any = undefined;
      try { data = raw ? JSON.parse(raw) : undefined; } catch { console.warn('fetchWallet: non-JSON response', raw); }
      if (res.ok && data && data.success) {
        setWalletBalance(Number(data.balance ?? data.pocketBalance ?? 0));
      }
    } catch (err) {
      console.error("Failed to fetch wallet", err);
    }
  }, [token]);

  // Fetch wallet whenever screen is focused
  useFocusEffect(
    React.useCallback(() => {
      if (token) fetchWallet();
    }, [token, fetchWallet])
  );

  // Handle price change with validation
  const handlePriceChange = (value: string) => {
    setPrice(value);
    const numPrice = parseInt(value) || 0;
    setPriceError(numPrice > 0 && numPrice < 410);
  };

  // Pick image from gallery
  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('permissionDenied'), t('imageLibraryPermissionRequired'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [4, 3],
      quality: 0.8,
    });
    if (!result.canceled) {
      setSelectedImage(result.assets[0].uri);
    }
  };

  // Get current location
  const getCurrentLocation = async () => {
    // ✅ Ask for confirmation if location already selected
    if (selectedLocation) {
      Alert.alert(
        t('changeLocationTitle'),
        t('changeLocationMessage'),
        [
          { text: t('cancel'), onPress: () => {}, style: 'cancel' },
          { text: t('yes'), onPress: () => actuallyGetLocation() },
        ]
      );
    } else {
      actuallyGetLocation();
    }
  };

  const actuallyGetLocation = async () => {
    try {
      setGettingLocation(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('permissionDenied'), t('locationPermissionRequired'));
        setGettingLocation(false);
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      // Try reverse geocode for human readable address; fallback to lat/lon string
      let placeName = `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`;
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: location.coords.latitude, longitude: location.coords.longitude });
        if (geo && geo.length > 0) {
          const g = geo[0];
          const parts = [g.name, g.street, g.subregion || g.region || g.city, g.postalCode, g.country].filter(Boolean);
          if (parts.length > 0) placeName = parts.join(', ');
        }
      } catch (e) {
        // If reverse geocode fails, keep lat/lon string
      }

      setSelectedLocation({
        lat: location.coords.latitude,
        lon: location.coords.longitude,
        placeName,
      });
      Alert.alert(t('success'), t('currentLocationSet'));
    } catch (err) {
      Alert.alert(t('error'), (err as Error).message || t('failedGetLocation'));
    } finally {
      setGettingLocation(false);
    }
  };

  const openMapPicker = async () => {
    try {
      setMapLoading(true);
      if (selectedLocation) {
        setMapCenter({ lat: selectedLocation.lat, lon: selectedLocation.lon });
        setShowMapPicker(true);
        return;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status === 'granted') {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        setMapCenter({ lat: loc.coords.latitude, lon: loc.coords.longitude });
      }
      setShowMapPicker(true);
    } catch {
      setShowMapPicker(true);
    } finally {
      setMapLoading(false);
    }
  };

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

  const confirmMapLocation = async () => {
    try {
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
        // keep fallback text
      }

      setSelectedLocation({
        lat: mapCenter.lat,
        lon: mapCenter.lon,
        placeName,
      });
      setShowMapPicker(false);
      Alert.alert(t('success'), t('locationSelectedFromMap'));
    } catch (err) {
      Alert.alert(t('error'), (err as Error).message || t('failedSetLocationFromMap'));
    }
  };

  // Setup socket connection - use global socket
  useEffect(() => {
    if (!token) return;

    socket.on("walletUpdated", (data: any) => {
      console.log("💰 Wallet updated via socket:", data);
      setWalletBalance(Number(data.pocketBalance ?? data.balance ?? 0));
    });

    socket.on("newJob", (job) => {
      console.log("New job received via socket:", job);
    });

    return () => {
      // Clean up listeners only, don't disconnect
      socket.off("walletUpdated");
      socket.off("newJob");
    };
  }, [token]);

  // Post Job function
  const handlePostJob = async () => {
    // ✅ Guard: Prevent double-click during posting
    if (isPostingJob) return;
    
    if (!title) return Alert.alert(t('missingFieldTitle'), t('selectJobTitleMessage'));
    if (!mainSkill) return Alert.alert(t('missingFieldTitle'), t('selectMainSkillMessage'));
    // ✅ FIXED: Worker type required ONLY for Mason, not for other skills
    if (mainSkill === 'Mason' && !workerType) return Alert.alert(t('missingFieldTitle'), t('selectWorkerTypeForMasonMessage'));
    if (!price) return Alert.alert(t('missingFieldTitle'), t('enterPriceMessage'));
    if (parseInt(price) < 410) return Alert.alert(t('error'), t('minimumPrice'));
    if (!selectedLocation) return Alert.alert(t('required'), t('selectLocation'));
    // ✅ Image is optional, but location is REQUIRED for accurate matching
    
    // ✅ Time validation: End time must be after start time
    if (endTime <= startTime) {
      return Alert.alert(t('invalidTimeTitle'), t('endTimeAfterStartMessage'));
    }

    // 💰 Calculate required posting fee based on bulk hiring
    const isBulkAllowed = hasPremium;
    const isMultiDayAllowed = hasPremium;
    const workersCount = isBulkAllowed && bulkHiringEnabled ? requiredWorkers : 1;
    const requiredBalance = workersCount * 25;

    if (walletBalance < requiredBalance) {
      return Alert.alert(
        t('insufficientBalanceTitle'),
        `${t('insufficientBalancePostJobMessage')} ₹${requiredBalance}.`,
        [
          {
            text: t('depositNow'),
            onPress: () => router.push("/(tabs)/wallet")
          },
          { text: t('cancel'), style: "cancel" }
        ]
      );
    }

    setIsPostingJob(true); // ✅ Show loading spinner

    // Helper function to format time in 12-hour format with AM/PM
    const formatTime12Hour = (date: Date): string => {
      let hours = date.getHours() % 12 || 12;
      const mins = date.getMinutes().toString().padStart(2, '0');
      const ampm = date.getHours() >= 12 ? 'PM' : 'AM';
      return `${hours}:${mins} ${ampm}`;
    };

    // Format times as HH:MM AM/PM
    const startTimeStr = formatTime12Hour(startTime);
    const endTimeStr = formatTime12Hour(endTime);
    const idempotencyKey = `job:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

    try {
      // STEP 1: Upload image if provided (optional)
      let imageUrl = null;
      if (selectedImage) {
        try {
          console.log("📸 Uploading job image from:", selectedImage);
          const imageFormData = new FormData();
          
          // ✅ Safer: Detect file type to avoid Android content-type mismatches
          const fileType = selectedImage.endsWith(".png") ? "image/png" : "image/jpeg";
          const fileName = selectedImage.endsWith(".png") ? `job-${Date.now()}.png` : `job-${Date.now()}.jpg`;
          
          imageFormData.append("photo", {
            uri: selectedImage,
            name: fileName,
            type: fileType,
          } as any);

          console.log("📤 Posting to:", `${SERVER_URL}/jobs/upload-image`);
          
          const imageRes = await fetch(`${SERVER_URL}/jobs/upload-image`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: imageFormData,
          });

          const imageText = await imageRes.text();
          console.log("📥 Server response:", imageRes.status, imageText);

          if (!imageRes.ok) {
            console.error("❌ Image upload failed with status", imageRes.status);
            return Alert.alert(t('error'), `${t('failedUploadImage')}: ${imageText}`);
          }

          const imageData = JSON.parse(imageText);
          imageUrl = imageData.imageUrl;
          console.log("✅ Image uploaded:", imageUrl);
        } catch (uploadErr) {
          console.error("❌ Image upload error:", uploadErr);
          return Alert.alert(t('error'), `${t('uploadFailed')}: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
        }
      }

      // STEP 2: Post job with image URL (optional) and time fields
      const payload: JobPayload & { imageUrl: string | null; startTime: string; endTime: string } = {
        title,
        description: mainSkill,
        workerType,
        amount: price,
        contractorName,
        lat: selectedLocation.lat,
        lon: selectedLocation.lon,
        date: date.toISOString(),
        imageUrl,
        startTime: startTimeStr,
        endTime: endTimeStr,
        numberOfDays: isMultiDayAllowed ? numberOfDays : 1,
        bulkHiring: isBulkAllowed ? bulkHiringEnabled : false,
        requiredWorkers: isBulkAllowed && bulkHiringEnabled ? requiredWorkers : 1,
        idempotencyKey,
      };

      const res = await fetch(`${SERVER_URL}/jobs/post`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
      let data: any = undefined;
      try { data = raw ? JSON.parse(raw) : undefined; } catch { console.warn('handlePostJob: non-JSON response', raw); }
      if (!res.ok) return Alert.alert(t('error'), data?.message || raw || t('errorPosting'));

      // Alert.alert("Success", `Job posted! Remaining balance: ₹${data.wallet.balance}`);

      // ⭐ Navigate to Waiting Screen
      // Save last posted job _id so Waiting screen can listen for accept events
      try {
        await AsyncStorage.setItem("lastJobId", data.job._id);
      } catch (e) {
        console.warn("Failed to save lastJobId", e);
      }
      
      setWalletBalance(toSafeBalance(data));

      // ✅ Clear all input fields after successful job posting
      setTitle("");
      setMainSkill("");
      setPrice("");
      setWorkerType("");
      setSelectedImage(null);
      setSelectedLocation(null);
      setStartTime(new Date());
      setEndTime(new Date());
      setNumberOfDays(1); // ✅ Reset days
      setPriceError(false);
      
      // ✅ Use replace instead of push to prevent back navigation to post job
      router.replace("/waiting");
    } catch (err) {
      console.error(err);
      Alert.alert(t('error'), t('serverNotResponding'));
    } finally {
      // ✅ Always reset posting state in finally block
      setIsPostingJob(false);
    }
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: '#F4F6F8' }}>
      <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.container}>
        <Text style={styles.header}>{t('postNewJob')}</Text>

        <Text style={styles.walletText}>{t('pocketBalance')}: ₹{Number(walletBalance) || 0}</Text>

        {/* ✅ Show Posting Fee Transparently */}
        <View style={styles.feeDisplay}>
          <Text style={styles.feeLabel}>{t('postingFee')}</Text>
          <Text style={styles.feeAmount}>₹{((hasPremium && bulkHiringEnabled) ? requiredWorkers : 1) * 25}</Text>
          <Text style={styles.feeInfo}>{(hasPremium && bulkHiringEnabled) ? requiredWorkers : 1} {t('workersShort')}</Text>
        </View>

        {/* Job Title Dropdown */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>{t('jobTitle')}</Text>
          <TouchableOpacity style={styles.dropdown} onPress={() => setShowTitleDropdown(!showTitleDropdown)}>
            <Text style={[styles.dropdownText, !title && styles.placeholderText]}>{title ? getJobTitleLabel(title) : t('selectJobTitle')}</Text>
            <Ionicons name={showTitleDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#6B7280" />
          </TouchableOpacity>
          {showTitleDropdown && (
            <View style={styles.dropdownMenu}>
              {JOB_TITLES.map((item) => (
                <TouchableOpacity key={item.value} style={styles.dropdownItem} onPress={() => { setTitle(item.value); setShowTitleDropdown(false); }}>
                  <Text style={styles.dropdownItemText}>{t(item.labelKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Main Skill Dropdown */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>{t('mainSkill')}</Text>
          <TouchableOpacity style={styles.dropdown} onPress={() => setShowSkillDropdown(!showSkillDropdown)}>
            <Text style={[styles.dropdownText, !mainSkill && styles.placeholderText]}>{mainSkill ? getSkillLabel(mainSkill) : t('selectMainSkill')}</Text>
            <Ionicons name={showSkillDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#6B7280" />
          </TouchableOpacity>
          {showSkillDropdown && (
            <View style={styles.dropdownMenu}>
              {MAIN_SKILLS.map((item) => (
                <TouchableOpacity key={item.value} style={styles.dropdownItem} onPress={() => { setMainSkill(item.value); setWorkerType(''); setShowSkillDropdown(false); }}>
                  <Text style={styles.dropdownItemText}>{t(item.labelKey)}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Worker Type Dropdown - Only visible if mainSkill is Mason */}
        {mainSkill === 'Mason' && (
          <View style={styles.dropdownContainer}>
            <Text style={styles.label}>{t('workerType')}</Text>
            <TouchableOpacity style={styles.dropdown} onPress={() => setShowWorkerTypeDropdown(!showWorkerTypeDropdown)}>
              <Text style={[styles.dropdownText, !workerType && styles.placeholderText]}>{workerType ? getWorkerTypeLabel(workerType) : t('selectWorkerType')}</Text>
              <Ionicons name={showWorkerTypeDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#6B7280" />
            </TouchableOpacity>
            {showWorkerTypeDropdown && (
              <View style={styles.dropdownMenu}>
                {MASON_TYPES.map((item) => (
                  <TouchableOpacity key={item.value} style={styles.dropdownItem} onPress={() => { setWorkerType(item.value); setShowWorkerTypeDropdown(false); }}>
                    <Text style={styles.dropdownItemText}>{t(item.labelKey)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Estimated Price with Validation */}
        <View style={styles.inputCard}>
          <Ionicons name="cash-outline" size={22} color="#9CA3AF" />
          <TextInput
            style={[styles.input, priceError && { borderColor: '#ff4444', borderWidth: 2 }]}
            placeholder={t('estimatedPricePlaceholder')}
            placeholderTextColor="#9CA3AF"
            keyboardType="numeric"
            value={price}
            onChangeText={handlePriceChange}
          />
        </View>
        {priceError && <Text style={styles.errorText}>⚠️ {t('minimumPrice')}</Text>}

        {/* Location Selection - Use Current Location Button */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>{t('jobLocation')}</Text>
          <TouchableOpacity
            style={[styles.inputCard, selectedLocation && styles.inputCardSelected]}
            onPress={getCurrentLocation}
            disabled={gettingLocation}
          >
            {gettingLocation ? (
              <ActivityIndicator size="small" color="#6B7280" />
            ) : (
              <Ionicons name="locate-outline" size={22} color={selectedLocation ? '#047857' : '#9CA3AF'} />
            )}
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={[styles.input, selectedLocation ? styles.selectedValueText : styles.placeholderText]}>
                {selectedLocation?.placeName 
                  ? `📍 ${selectedLocation.placeName}`
                  : gettingLocation ? t('gettingLocation') : t('useCurrentLocation')
                }
              </Text>
              {selectedLocation && (
                <Text style={{ fontSize: 11, color: '#059669', marginTop: 3 }}>
                  Lat: {selectedLocation.lat.toFixed(4)} | Lon: {selectedLocation.lon.toFixed(4)}
                </Text>
              )}
            </View>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.addressButton, { marginBottom: 10 }]}
            onPress={openMapPicker}
            disabled={mapLoading}
          >
            {mapLoading ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <>
                <Ionicons name="map-outline" size={18} color="#fff" />
                <Text style={[styles.addressButtonText, { marginLeft: 8 }]}>{t('chooseFromMap')}</Text>
              </>
            )}
          </TouchableOpacity>

        </View>

        {/* Start + End Time in one row */}
        <View style={styles.twoColRow}>
          <View style={styles.twoColItem}>
            <Text style={styles.label}>{t('startTime')}</Text>
            <TouchableOpacity style={styles.inputCard} onPress={() => setShowStartTimePicker(true)}>
              <Ionicons name="time-outline" size={22} color="#9CA3AF" />
              <Text style={styles.input}>
                {formatTimeDisplay(startTime)}
              </Text>
            </TouchableOpacity>
          </View>

          <View style={styles.twoColItem}>
            <Text style={styles.label}>{t('endTime')}</Text>
            <TouchableOpacity style={styles.inputCard} onPress={() => setShowEndTimePicker(true)}>
              <Ionicons name="time-outline" size={22} color="#9CA3AF" />
              <Text style={styles.input}>
                {formatTimeDisplay(endTime)}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
        {showStartTimePicker && (
          <View style={{ backgroundColor: "#fff" }}>
            <DateTimePicker
              value={startTime}
              mode="time"
              display="default"
              onChange={(e, d) => {
                setShowStartTimePicker(false);
                if (d) setStartTime(d);
              }}
            />
          </View>
        )}
        {showEndTimePicker && (
          <View style={{ backgroundColor: "#fff" }}>
            <DateTimePicker
              value={endTime}
              mode="time"
              display="default"
              onChange={(e, d) => {
                setShowEndTimePicker(false);
                if (d) setEndTime(d);
              }}
            />
          </View>
        )}

        {/* Date Picker */}

        {/* ✅ Premium-only controls */}
        {hasPremium && (
          <View style={styles.bulkDurationWrap}>
            <View style={styles.twoColRow}>
              <View style={styles.twoColItem}>
                <Text style={styles.label}>{t('bulkHiring')}</Text>
                <TouchableOpacity
                  style={[styles.bulkHiringToggle, bulkHiringEnabled && styles.bulkHiringToggleActive]}
                  onPress={() => setBulkHiringEnabled(!bulkHiringEnabled)}
                >
                  <View style={[styles.toggleCircle, bulkHiringEnabled && styles.toggleCircleActive]} />
                  <Text style={styles.toggleText}>
                    {bulkHiringEnabled ? t('enabled') : t('disabled')}
                  </Text>
                </TouchableOpacity>
              </View>

              <View style={styles.twoColItem}>
                <Text style={styles.label}>{t('jobDuration')}</Text>
                <TouchableOpacity style={styles.dropdown} onPress={() => setShowDaysDropdown(!showDaysDropdown)}>
                  <Text style={styles.dropdownText}>{numberOfDays} {numberOfDays === 1 ? t('day') : t('days')}</Text>
                  <Ionicons name={showDaysDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#6B7280" />
                </TouchableOpacity>
                {showDaysDropdown && (
                  <View style={styles.dropdownMenu}>
                    {Array.from({ length: 30 }, (_, i) => i + 1).map((day) => (
                      <TouchableOpacity key={day} style={styles.dropdownItem} onPress={() => { setNumberOfDays(day); setShowDaysDropdown(false); }}>
                        <Text style={styles.dropdownItemText}>{day} {day === 1 ? t('day') : t('days')}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            </View>

            {bulkHiringEnabled && (
              <View style={styles.workerCountContainer}>
                <Text style={styles.workerCountLabel}>{t('selectNumberOfWorkers')}</Text>
                <View style={styles.workerCountButtons}>
                  {BULK_HIRING_OPTIONS.map((num) => (
                    <TouchableOpacity
                      key={num}
                      style={[
                        styles.workerCountButton,
                        requiredWorkers === num && styles.workerCountButtonActive
                      ]}
                      onPress={() => setRequiredWorkers(num)}
                    >
                      <Text style={[
                        styles.workerCountButtonText,
                        requiredWorkers === num && styles.workerCountButtonTextActive
                      ]}>
                        {num}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={styles.bulkHiringInfo}>
                  {t('bulkHiringInfoMessage').replace('{count}', String(requiredWorkers))}
                </Text>
              </View>
            )}

            <Text style={{ color: '#6B7280', fontSize: 12, marginTop: 8, paddingHorizontal: 4 }}>
              {t('jobDurationNotice')}
            </Text>
          </View>
        )}

        {/* Date + Image in one row */}
        <View style={styles.twoColRow}>
          <View style={styles.twoColItem}>
            <Text style={styles.label}>{t('date')}</Text>
            <TouchableOpacity style={styles.inputCard} onPress={() => setShowDatePicker(true)}>
              <Ionicons name="calendar-outline" size={22} color="#9CA3AF" />
              <Text style={styles.input}>{date.toDateString()}</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.twoColItem}>
            <Text style={styles.label}>{t('image')}</Text>
            <TouchableOpacity style={[styles.inputCard, selectedImage && styles.inputCardSelectedBlue]} onPress={pickImage}>
              <Ionicons name="image-outline" size={22} color={selectedImage ? '#2563EB' : '#9CA3AF'} />
              <Text style={[styles.input, selectedImage ? styles.selectedBlueText : styles.placeholderText]} numberOfLines={1}>
                {selectedImage ? t('imageSelected') : t('chooseImage')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {selectedImage && (
          <TouchableOpacity
            style={{ marginTop: -6, marginBottom: 12 }}
            onLongPress={() => setShowImagePreviewHold(true)}
            onPressOut={() => setShowImagePreviewHold(false)}
            delayLongPress={180}
          >
            <Text style={{ color: '#93c5fd', fontSize: 12 }}>{t('imagePreviewHint')}</Text>
          </TouchableOpacity>
        )}

        {selectedImage && showImagePreviewHold && (
          <View style={styles.imagePreview}>
            <Image source={{ uri: selectedImage }} style={styles.previewImage} />
          </View>
        )}

        {showDatePicker && (
          <DateTimePicker
            value={date}
            mode="date"
            display="spinner"
            onChange={(event, selectedDate) => {
              try {
                if (event.type === 'dismissed' || (event.type === 'set' && !selectedDate)) {
                  setShowDatePicker(false);
                } else if (selectedDate) {
                  setDate(selectedDate);
                  setShowDatePicker(false);
                }
              } catch (err) {
                console.error('DatePicker error:', err);
                setShowDatePicker(false);
              }
            }}
          />
        )}

        <TouchableOpacity style={styles.button} onPress={handlePostJob} disabled={isPostingJob}>
          {isPostingJob ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.buttonText}>{t('postJob')}</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>

    <Modal
      visible={showMapPicker}
      animationType="slide"
      transparent={false}
      onRequestClose={() => setShowMapPicker(false)}
    >
      <SafeAreaView style={{ flex: 1, backgroundColor: '#0b1d33' }}>
        <View style={styles.mapHeader}>
          <Text style={styles.mapHeaderTitle}>{t('selectJobLocation')}</Text>
          <TouchableOpacity onPress={() => setShowMapPicker(false)}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
        </View>

        <View style={styles.mapContainer}>
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
          <Text style={styles.mapHint}>{t('moveMapHint')}</Text>
          <TouchableOpacity style={styles.confirmMapBtn} onPress={confirmMapLocation}>
            <Text style={styles.confirmMapBtnText}>{t('confirmLocation')}</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 24,
    backgroundColor: "#F4F6F8",
    alignItems: "center",
  },
  container: {
    backgroundColor: "#FFFFFF",
    borderRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 20,
    paddingBottom: 18,
    width: "100%",
    maxWidth: 440,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#E8EDF3",
  },
  header: { fontSize: 22, fontWeight: "700", color: "#111827", marginBottom: 10, textAlign: "center" },
  walletText: { color: "#4B5563", fontWeight: "600", marginBottom: 14, fontSize: 14, textAlign: "center" },
  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#F9FAFB",
    borderRadius: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: "#D8DEE6",
  },
  inputCardSelected: {
    backgroundColor: "#ECFDF5",
    borderColor: "#A7F3D0",
  },
  inputCardSelectedBlue: {
    backgroundColor: "#EFF6FF",
    borderColor: "#BFDBFE",
  },
  input: { flex: 1, marginLeft: 10, color: "#111827", fontSize: 15 },
  placeholderText: { color: "#9CA3AF" },
  selectedValueText: { color: "#047857" },
  selectedBlueText: { color: "#2563EB" },
  textAreaCard: { alignItems: "flex-start" },
  textArea: { height: 100, textAlignVertical: "top" },
  button: { marginTop: 10, backgroundColor: "#17263A", paddingVertical: 15, borderRadius: 18, alignItems: "center" },
  buttonText: { fontSize: 16, color: "#fff", fontWeight: "700" },
  dropdownContainer: { marginBottom: 10 },
  label: { fontSize: 13, fontWeight: '700', color: '#6B7280', marginBottom: 7, letterSpacing: 0.3 },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: '#D8DEE6',
  },
  dropdownText: { flex: 1, color: '#111827', fontSize: 15 },
  dropdownMenu: {
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
    marginTop: 4,
    borderTopColor: '#E5E7EB',
    borderTopWidth: 1,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    overflow: 'hidden',
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderBottomColor: '#F3F4F6',
    borderBottomWidth: 1,
  },
  dropdownItemText: { color: '#111827', fontSize: 15 },
  errorText: { color: '#ff4444', fontWeight: '600', marginBottom: 8, marginTop: -4, fontSize: 12 },
  twoColRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginBottom: 4,
  },
  twoColItem: {
    flex: 1,
    minWidth: 0,
  },
  imagePreview: { alignItems: 'center', marginBottom: 12 },
  previewImage: { width: 150, height: 120, borderRadius: 10, backgroundColor: '#0f1f35' },
  bulkDurationWrap: {
    backgroundColor: '#F9FAFB',
    borderRadius: 18,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#DDE5EE',
  },
  // ✅ Bulk hiring styles
  bulkHiringContainer: {
    backgroundColor: '#F9FAFB',
    borderRadius: 14,
    padding: 15,
    marginBottom: 15,
    borderWidth: 1,
    borderColor: '#DDE5EE',
  },
  bulkHiringHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  bulkHiringLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#17263A',
    marginLeft: 8,
  },
  bulkHiringToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    minHeight: 48,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    marginBottom: 0,
    borderWidth: 2,
    borderColor: '#D8DEE6',
  },
  bulkHiringToggleActive: {
    borderColor: '#17263A',
  },
  toggleCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#CBD5E1',
    marginRight: 10,
  },
  toggleCircleActive: {
    backgroundColor: '#17263A',
  },
  toggleText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '600',
  },
  workerCountContainer: {
    marginTop: 12,
  },
  workerCountLabel: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },
  workerCountButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  workerCountButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    marginHorizontal: 4,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#D8DEE6',
  },
  workerCountButtonActive: {
    backgroundColor: '#17263A',
    borderColor: '#17263A',
  },
  workerCountButtonText: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '600',
  },
  workerCountButtonTextActive: {
    color: '#fff',
  },
  bulkHiringInfo: {
    color: '#4B5563',
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  // ✅ Fee display styles
  feeDisplay: {
    backgroundColor: '#F9FAFB',
    borderRadius: 16,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#DDE5EE',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  feeLabel: {
    color: '#6B7280',
    fontSize: 13,
    fontWeight: '600',
  },
  feeAmount: {
    color: '#047857',
    fontSize: 18,
    fontWeight: '700',
  },
  feeInfo: {
    color: '#4B5563',
    fontSize: 12,
    fontStyle: 'italic',
  },
  addressButton: {
    backgroundColor: '#17263A',
    borderRadius: 14,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addressButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  mapHeader: {
    paddingHorizontal: 16,
    paddingVertical: 12,
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
  mapContainer: {
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
});

