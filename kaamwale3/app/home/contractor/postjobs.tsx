import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert, Image, ActivityIndicator, SafeAreaView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { socket } from "../../../utils/socket";
import { SERVER_URL } from "../../../utils/config";
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from "expo-router";  // ⭐ ADDED

interface JobPayload {
  title: string;
  description: string;
  workerType: string;
  amount: string;
  contractorName: string;
  lat: number;
  lon: number;
  date: string;
  bulkHiring?: boolean;
  requiredWorkers?: number;
}

const JOB_TITLES = ['Construction', 'Renovation', 'Other'];
const MAIN_SKILLS = ['Labour', 'Mason', 'Engineer', 'ITI/Technician'];
const MASON_TYPES = ['Tile Mason', 'Stone Mason', 'Cement Mason', 'Composite Mason', 'Bar Bender'];
const BULK_HIRING_OPTIONS = [1, 2, 3, 5, 10];

export default function PostJobScreen() {
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
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const previousUserPhoneRef = useRef<string | null>(null); // ✅ Track previous user to detect changes
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [selectedLocation, setSelectedLocation] = useState<{ lat: number; lon: number; placeName?: string } | null>(null);
  const [showTitleDropdown, setShowTitleDropdown] = useState(false);
  const [showSkillDropdown, setShowSkillDropdown] = useState(false);
  const [showWorkerTypeDropdown, setShowWorkerTypeDropdown] = useState(false);
  const [priceError, setPriceError] = useState(false);
  const [hasPremium, setHasPremium] = useState(false); // ✅ Premium check
  const [bulkHiringEnabled, setBulkHiringEnabled] = useState(false); // ✅ Bulk hiring toggle
  const [requiredWorkers, setRequiredWorkers] = useState(1); // ✅ Number of workers needed
  const [gettingLocation, setGettingLocation] = useState(false); // ✅ Loading state for current location

  // SERVER_URL is loaded from central config
  const router = useRouter();   // ⭐ ADDED

  // ✅ Check for user changes when screen comes into focus (no dependency on currentUserPhone to avoid stale closures)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const userStr = await AsyncStorage.getItem("user");
          const userPhone = userStr ? JSON.parse(userStr).phone : null;
          
          // If user changed, reset wallet state
          if (userPhone && userPhone !== previousUserPhoneRef.current) {
            console.log(`👤 Postjobs: Contractor changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting wallet`);
            previousUserPhoneRef.current = userPhone;
            setCurrentUserPhone(userPhone);
            setWalletBalance(0);
            setHasPremium(false);
          } else if (!userPhone && previousUserPhoneRef.current !== null) {
            // User logged out
            console.log(`👤 Postjobs: User logged out, resetting wallet`);
            previousUserPhoneRef.current = null;
            setCurrentUserPhone(null);
            setWalletBalance(0);
            setHasPremium(false);
          }

          if (userStr) {
            const user = JSON.parse(userStr);
            if (user?.name) setContractorName(user.name);
            
            // ✅ Check if user has active premium
            if (user?.premiumPlan && user.premiumPlan.type) {
              const expiryDate = new Date(user.premiumPlan.expiryDate);
              const now = new Date();
              if (expiryDate > now) {
                setHasPremium(true);
              } else {
                setHasPremium(false);
              }
            } else {
              setHasPremium(false);
            }
          }
        } catch (err) {
          console.error("Failed to check user in postjobs", err);
        }
      })();
    }, [])
  );

  // Load user & token from AsyncStorage and detect user changes
  useEffect(() => {
    (async () => {
      try {
        const userStr = await AsyncStorage.getItem("user");
        const storedToken = await AsyncStorage.getItem("token");
        
        const userPhone = userStr ? JSON.parse(userStr).phone : null;
        
        // If user changed, reset wallet state
        if (userPhone && userPhone !== currentUserPhone) {
          console.log(`👤 Contractor changed from ${currentUserPhone} to ${userPhone}, resetting wallet`);
          setCurrentUserPhone(userPhone);
          setWalletBalance(0);
        }

        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setContractorName(user.name);
        }

        if (storedToken) setToken(storedToken);
      } catch (err) {
        console.error("Failed to load user/token", err);
      }
    })();
  }, []);

  // Fetch wallet balance
  const fetchWallet = async () => {
    if (!token) return;
    try {
      const res = await fetch(`${SERVER_URL}/wallet`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const raw = await res.text();
      let data: any = undefined;
      try { data = raw ? JSON.parse(raw) : undefined; } catch { console.warn('fetchWallet: non-JSON response', raw); }
      if (res.ok && data && data.success) setWalletBalance(data.wallet.balance);
    } catch (err) {
      console.error("Failed to fetch wallet", err);
    }
  };

  // Fetch wallet whenever screen is focused
  useFocusEffect(
    React.useCallback(() => {
      if (token) fetchWallet();
    }, [token])
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
      Alert.alert('Permission Denied', 'Image library permission required');
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
    try {
      setGettingLocation(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Denied', 'Location permission is required to use current location');
        setGettingLocation(false);
        return;
      }
      const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      setSelectedLocation({
        lat: location.coords.latitude,
        lon: location.coords.longitude,
        placeName: `${location.coords.latitude.toFixed(4)}, ${location.coords.longitude.toFixed(4)}`,
      });
      Alert.alert('Success', 'Current location set');
    } catch (err) {
      Alert.alert('Error', (err as Error).message || 'Failed to get location');
    } finally {
      setGettingLocation(false);
    }
  };

  // Setup socket connection - use global socket
  useEffect(() => {
    if (!token) return;

    socket.on("walletUpdated", (newBalance: number) => {
      console.log("Wallet updated via socket:", newBalance);
      setWalletBalance(newBalance);
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
    if (!title) return Alert.alert("Missing", "Please select a job title");
    if (!mainSkill) return Alert.alert("Missing", "Please select main skill");
    // ✅ FIXED: Worker type required ONLY for Mason, not for other skills
    if (mainSkill === 'Mason' && !workerType) return Alert.alert("Missing", "Please select worker type for Mason");
    if (!price) return Alert.alert("Missing", "Please enter price");
    if (parseInt(price) < 410) return Alert.alert("Price Error", "Minimum price must be ₹410 or above");
    if (!selectedLocation) return Alert.alert("Missing", "Please select location - required for worker matching");
    // ✅ Image is optional, but location is REQUIRED for accurate matching

    if (walletBalance < 25)
      return Alert.alert("Insufficient Balance", "Minimum balance ₹25 required to post a job");

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

    try {
      // STEP 1: Upload image if provided (optional)
      let imageUrl = null;
      if (selectedImage) {
        try {
          console.log("📸 Uploading job image from:", selectedImage);
          const imageFormData = new FormData();
          
          imageFormData.append("photo", {
            uri: selectedImage,
            name: `job-${Date.now()}.jpg`,
            type: "image/jpeg",
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
            return Alert.alert("Error", `Failed to upload image: ${imageText}`);
          }

          const imageData = JSON.parse(imageText);
          imageUrl = imageData.imageUrl;
          console.log("✅ Image uploaded:", imageUrl);
        } catch (uploadErr) {
          console.error("❌ Image upload error:", uploadErr);
          return Alert.alert("Error", `Upload failed: ${uploadErr instanceof Error ? uploadErr.message : String(uploadErr)}`);
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
        bulkHiring: bulkHiringEnabled, // ✅ Include bulk hiring flag
        requiredWorkers: bulkHiringEnabled ? requiredWorkers : 1, // ✅ Include required workers count
      };

      const res = await fetch(`${SERVER_URL}/jobs/post`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      const raw = await res.text();
      let data: any = undefined;
      try { data = raw ? JSON.parse(raw) : undefined; } catch { console.warn('handlePostJob: non-JSON response', raw); }
      if (!res.ok) return Alert.alert("Error", data?.message || raw || "Failed to post job");

      // Alert.alert("Success", `Job posted! Remaining balance: ₹${data.wallet.balance}`);

      // ⭐ Navigate to Waiting Screen
      // Save last posted job _id so Waiting screen can listen for accept events
      try {
        await AsyncStorage.setItem("lastJobId", data.job._id);
      } catch (e) {
        console.warn("Failed to save lastJobId", e);
      }
      router.push("/waiting");

      setWalletBalance(data.wallet.balance);

      setTitle("");
      setMainSkill("");
      setPrice("");
      setWorkerType("");
      setSelectedImage(null);
      setSelectedLocation(null);
      setStartTime(new Date());
      setEndTime(new Date());
      setPriceError(false);

    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Server not responding"); 
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#f3f3f3' }}>
      <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.container}>
        <Text style={styles.header}>Post a New Job</Text>

        <Text style={styles.walletText}>Wallet Balance: ₹{walletBalance}</Text>

        {/* Job Title Dropdown */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>Job Title</Text>
          <TouchableOpacity style={styles.dropdown} onPress={() => setShowTitleDropdown(!showTitleDropdown)}>
            <Text style={[styles.dropdownText, !title && { color: '#aaa' }]}>{title || 'Select Job Title'}</Text>
            <Ionicons name={showTitleDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
          </TouchableOpacity>
          {showTitleDropdown && (
            <View style={styles.dropdownMenu}>
              {JOB_TITLES.map((item) => (
                <TouchableOpacity key={item} style={styles.dropdownItem} onPress={() => { setTitle(item); setShowTitleDropdown(false); }}>
                  <Text style={styles.dropdownItemText}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Main Skill Dropdown */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>Main Skill</Text>
          <TouchableOpacity style={styles.dropdown} onPress={() => setShowSkillDropdown(!showSkillDropdown)}>
            <Text style={[styles.dropdownText, !mainSkill && { color: '#aaa' }]}>{mainSkill || 'Select Main Skill'}</Text>
            <Ionicons name={showSkillDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
          </TouchableOpacity>
          {showSkillDropdown && (
            <View style={styles.dropdownMenu}>
              {MAIN_SKILLS.map((item) => (
                <TouchableOpacity key={item} style={styles.dropdownItem} onPress={() => { setMainSkill(item); setWorkerType(''); setShowSkillDropdown(false); }}>
                  <Text style={styles.dropdownItemText}>{item}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {/* Worker Type Dropdown - Only visible if mainSkill is Mason */}
        {mainSkill === 'Mason' && (
          <View style={styles.dropdownContainer}>
            <Text style={styles.label}>Worker Type</Text>
            <TouchableOpacity style={styles.dropdown} onPress={() => setShowWorkerTypeDropdown(!showWorkerTypeDropdown)}>
              <Text style={[styles.dropdownText, !workerType && { color: '#aaa' }]}>{workerType || 'Select Worker Type'}</Text>
              <Ionicons name={showWorkerTypeDropdown ? 'chevron-up' : 'chevron-down'} size={20} color="#fff" />
            </TouchableOpacity>
            {showWorkerTypeDropdown && (
              <View style={styles.dropdownMenu}>
                {MASON_TYPES.map((item) => (
                  <TouchableOpacity key={item} style={styles.dropdownItem} onPress={() => { setWorkerType(item); setShowWorkerTypeDropdown(false); }}>
                    <Text style={styles.dropdownItemText}>{item}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        {/* Estimated Price with Validation */}
        <View style={styles.inputCard}>
          <Ionicons name="cash-outline" size={22} color="#bcbec7ff" />
          <TextInput
            style={[styles.input, priceError && { borderColor: '#ff4444', borderWidth: 2 }]}
            placeholder="Estimated Price (Min: ₹410)"
            placeholderTextColor="#aaa"
            keyboardType="numeric"
            value={price}
            onChangeText={handlePriceChange}
          />
        </View>
        {priceError && <Text style={styles.errorText}>⚠️ Minimum price must be ₹410</Text>}

        {/* Location Selection - Use Current Location Button */}
        <View style={styles.dropdownContainer}>
          <Text style={styles.label}>Job Location</Text>
          <TouchableOpacity
            style={[styles.inputCard, { backgroundColor: selectedLocation ? '#1a5c3a' : '#162b49ff' }]}
            onPress={getCurrentLocation}
            disabled={gettingLocation}
          >
            {gettingLocation ? (
              <ActivityIndicator size="small" color="#bcbec7ff" />
            ) : (
              <Ionicons name="locate-outline" size={22} color={selectedLocation ? '#4ade80' : '#bcbec7ff'} />
            )}
            <View style={{ flex: 1, marginLeft: 10 }}>
              <Text style={[styles.input, { color: selectedLocation ? '#4ade80' : '#aaa' }]}>
                {selectedLocation?.placeName 
                  ? `📍 ${selectedLocation.placeName}`
                  : gettingLocation ? 'Getting location...' : 'Use Current Location'
                }
              </Text>
              {selectedLocation && (
                <Text style={{ fontSize: 11, color: '#7ed5a9', marginTop: 3 }}>
                  Lat: {selectedLocation.lat.toFixed(4)} | Lon: {selectedLocation.lon.toFixed(4)}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        </View>

        {/* Image Upload */}
        <TouchableOpacity style={[styles.inputCard, { backgroundColor: selectedImage ? '#1a4c6d' : '#162b49ff' }]} onPress={pickImage}>
          <Ionicons name="image-outline" size={22} color={selectedImage ? '#3b82f6' : '#bcbec7ff'} />
          <Text style={[styles.input, { color: selectedImage ? '#3b82f6' : '#aaa' }]}>
            {selectedImage ? '📷 Image Selected' : 'Choose Image'}
          </Text>
        </TouchableOpacity>

        {selectedImage && (
          <View style={styles.imagePreview}>
            <Image source={{ uri: selectedImage }} style={styles.previewImage} />
          </View>
        )}

        {/* Start Time Picker */}
        <View style={{ marginBottom: 15 }}>
          <Text style={styles.label}>Start Time</Text>
          <TouchableOpacity style={styles.inputCard} onPress={() => setShowStartTimePicker(true)}>
            <Ionicons name="time-outline" size={22} color="#bcbec7ff" />
            <Text style={[styles.input, { color: "#fff" }]}>
              {startTime.getHours().toString().padStart(2, '0')}:{startTime.getMinutes().toString().padStart(2, '0')}
            </Text>
          </TouchableOpacity>
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
        </View>

        {/* End Time Picker */}
        <View style={{ marginBottom: 15 }}>
          <Text style={styles.label}>End Time</Text>
          <TouchableOpacity style={styles.inputCard} onPress={() => setShowEndTimePicker(true)}>
            <Ionicons name="time-outline" size={22} color="#bcbec7ff" />
            <Text style={[styles.input, { color: "#fff" }]}>
              {endTime.getHours().toString().padStart(2, '0')}:{endTime.getMinutes().toString().padStart(2, '0')}
            </Text>
          </TouchableOpacity>
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
        </View>

        {/* Date Picker */}

        {/* ✅ Bulk Hiring Option - Only for Premium Users */}
        {hasPremium && (
          <View style={styles.bulkHiringContainer}>
            <View style={styles.bulkHiringHeader}>
              <Ionicons name="people-outline" size={22} color="#667eea" />
              <Text style={styles.bulkHiringLabel}>Bulk Hiring</Text>
            </View>
            
            <TouchableOpacity 
              style={[styles.bulkHiringToggle, bulkHiringEnabled && styles.bulkHiringToggleActive]}
              onPress={() => setBulkHiringEnabled(!bulkHiringEnabled)}
            >
              <View style={[styles.toggleCircle, bulkHiringEnabled && styles.toggleCircleActive]} />
              <Text style={styles.toggleText}>
                {bulkHiringEnabled ? 'Enabled' : 'Disabled'}
              </Text>
            </TouchableOpacity>
            
            {bulkHiringEnabled && (
              <View style={styles.workerCountContainer}>
                <Text style={styles.workerCountLabel}>Select Number of Workers</Text>
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
                  This job will be offered to {requiredWorkers} nearby workers simultaneously
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Date Picker - Fixed */}
        <TouchableOpacity style={styles.inputCard} onPress={() => setShowDatePicker(true)}>
          <Ionicons name="calendar-outline" size={22} color="#bcbec7ff" />
          <Text style={[styles.input, { color: "#fff" }]}>{date.toDateString()}</Text>
        </TouchableOpacity>

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

        <TouchableOpacity style={styles.button} onPress={handlePostJob}>
          <Text style={styles.buttonText}>Post Job</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, padding: 20, backgroundColor: "#f3f3f3", alignItems: "center" },
  container: { backgroundColor: "#1f3a5f", borderRadius: 20, padding: 20, width: "100%", maxWidth: 400, marginBottom: 30 },
  header: { fontSize: 22, fontWeight: "700", color: "#fff", marginBottom: 20, textAlign: "center" },
  walletText: { color: "#fff", fontWeight: "700", marginBottom: 10 },
  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#162b49ff",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 15,
  },
  input: { flex: 1, marginLeft: 10, color: "#fff", fontSize: 16 },
  textAreaCard: { alignItems: "flex-start" },
  textArea: { height: 100, textAlignVertical: "top" },
  button: { marginTop: 10, backgroundColor: "#172c4aff", paddingVertical: 14, borderRadius: 14, alignItems: "center" },
  buttonText: { fontSize: 18, color: "#fff", fontWeight: "600" },
  dropdownContainer: { marginBottom: 15 },
  label: { fontSize: 14, fontWeight: '600', color: '#fff', marginBottom: 5 },
  dropdown: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#162b49ff',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  dropdownText: { flex: 1, color: '#fff', fontSize: 16 },
  dropdownMenu: {
    backgroundColor: '#0f1f35',
    borderBottomLeftRadius: 14,
    borderBottomRightRadius: 14,
    marginTop: -1,
    borderTopColor: '#1a3a5f',
    borderTopWidth: 1,
  },
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomColor: '#1a3a5f',
    borderBottomWidth: 1,
  },
  dropdownItemText: { color: '#fff', fontSize: 16 },
  errorText: { color: '#ff4444', fontWeight: '600', marginBottom: 10, marginTop: -10 },
  imagePreview: { alignItems: 'center', marginBottom: 15 },
  previewImage: { width: 150, height: 120, borderRadius: 10, backgroundColor: '#0f1f35' },
  // ✅ Bulk hiring styles
  bulkHiringContainer: {
    backgroundColor: '#0f1f35',
    borderRadius: 14,
    padding: 15,
    marginBottom: 15,
    borderLeftWidth: 4,
    borderLeftColor: '#667eea',
  },
  bulkHiringHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  bulkHiringLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#667eea',
    marginLeft: 8,
  },
  bulkHiringToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#162b49ff',
    borderRadius: 10,
    marginBottom: 12,
    borderWidth: 2,
    borderColor: '#334466',
  },
  bulkHiringToggleActive: {
    borderColor: '#667eea',
  },
  toggleCircle: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#334466',
    marginRight: 10,
  },
  toggleCircleActive: {
    backgroundColor: '#667eea',
  },
  toggleText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  workerCountContainer: {
    marginTop: 12,
  },
  workerCountLabel: {
    color: '#aaa',
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 10,
  },
  workerCountButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  workerCountButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    backgroundColor: '#162b49ff',
    borderRadius: 10,
    marginHorizontal: 4,
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#334466',
  },
  workerCountButtonActive: {
    backgroundColor: '#667eea',
    borderColor: '#667eea',
  },
  workerCountButtonText: {
    color: '#aaa',
    fontSize: 14,
    fontWeight: '600',
  },
  workerCountButtonTextActive: {
    color: '#fff',
  },
  bulkHiringInfo: {
    color: '#667eea',
    fontSize: 12,
    fontStyle: 'italic',
    textAlign: 'center',
  },
});
