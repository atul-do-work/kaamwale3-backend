import React, { useState, useEffect, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Location from 'expo-location';
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
}

export default function PostJobScreen() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [workerType, setWorkerType] = useState('');
  const [price, setPrice] = useState('');
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [contractorName, setContractorName] = useState('Contractor');
  const [token, setToken] = useState<string | null>(null);
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const previousUserPhoneRef = useRef<string | null>(null); // ✅ Track previous user to detect changes

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
          } else if (!userPhone && previousUserPhoneRef.current !== null) {
            // User logged out
            console.log(`👤 Postjobs: User logged out, resetting wallet`);
            previousUserPhoneRef.current = null;
            setCurrentUserPhone(null);
            setWalletBalance(0);
          }

          if (userStr) {
            const user = JSON.parse(userStr);
            if (user?.name) setContractorName(user.name);
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
    if (!title) return Alert.alert("Missing", "Please enter a job title");
    if (!description) return Alert.alert("Missing", "Please enter job description");
    if (!workerType) return Alert.alert("Missing", "Please enter worker type");
    if (!price) return Alert.alert("Missing", "Please enter price");

    if (walletBalance < 25)
      return Alert.alert("Insufficient Balance", "Minimum balance ₹25 required to post a job");

    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted")
      return Alert.alert("Permission Denied", "Location permission is required.");

    const loc = await Location.getCurrentPositionAsync({});

    const payload: JobPayload = {
      title,
      description,
      workerType,
      amount: price,
      contractorName,
      lat: loc.coords.latitude,
      lon: loc.coords.longitude,
      date: date.toISOString(),
    };

    try {
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
      setDescription("");
      setPrice("");
      setWorkerType("");

    } catch (err) {
      console.error(err);
      Alert.alert("Error", "Server not responding"); 
    }
  };

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={styles.container}>
        <Text style={styles.header}>Post a New Job</Text>

        <Text style={styles.walletText}>Wallet Balance: ₹{walletBalance}</Text>

        <View style={styles.inputCard}>
          <Ionicons name="briefcase-outline" size={22} color="#bcbec7ff" />
          <TextInput
            style={styles.input}
            placeholder="Job Title"
            placeholderTextColor="#aaa"
            value={title}
            onChangeText={setTitle}
          />
        </View>

        <View style={[styles.inputCard, styles.textAreaCard]}>
          <Ionicons name="document-text-outline" size={22} color="#bcbec7ff" />
          <TextInput
            style={[styles.input, styles.textArea]}
            placeholder="Job Description"
            placeholderTextColor="#aaa"
            value={description}
            onChangeText={setDescription}
            multiline
          />
        </View>

        <View style={styles.inputCard}>
          <Ionicons name="people-outline" size={22} color="#bcbec7ff" />
          <TextInput
            style={styles.input}
            placeholder="Worker Type (e.g., Plumber, Electrician)"
            placeholderTextColor="#aaa"
            value={workerType}
            onChangeText={setWorkerType}
          />
        </View>

        <View style={styles.inputCard}>
          <Ionicons name="cash-outline" size={22} color="#bcbec7ff" />
          <TextInput
            style={styles.input}
            placeholder="Estimated Price"
            placeholderTextColor="#aaa"
            keyboardType="numeric"
            value={price}
            onChangeText={setPrice}
          />
        </View>

        <TouchableOpacity style={styles.inputCard} onPress={() => setShowDatePicker(true)}>
          <Ionicons name="calendar-outline" size={22} color="#bcbec7ff" />
          <Text style={[styles.input, { color: "#fff" }]}>{date.toLocaleString()}</Text>
        </TouchableOpacity>

        {showDatePicker && (
          <View style={{ backgroundColor: "#fff" }}>
            <DateTimePicker
              value={date}
              mode="datetime"
              display="default"
              onChange={(e, d) => {
                setShowDatePicker(false);
                if (d) setDate(d);
              }}
            />
          </View>
        )}

        <TouchableOpacity style={styles.button} onPress={handlePostJob}>
          <Text style={styles.buttonText}>Post Job</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, padding: 20, backgroundColor: "#f3f3f3", alignItems: "center", justifyContent: "center" }, // ✅ Vertically & horizontally centered
  container: { backgroundColor: "#1f3a5f", borderRadius: 20, padding: 20, width: "100%", maxWidth: 400 }, // ✅ Max width for centering
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
});
