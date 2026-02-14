import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  Image,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
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
  skills: string[];
  profilePhoto?: string;
}

interface ViewWorkersModalProps {
  visible: boolean;
  onClose: () => void;
  onRequestWorker?: (worker: Worker) => void;
}

export default function ViewWorkersModal({
  visible,
  onClose,
  onRequestWorker,
}: ViewWorkersModalProps) {
  const { accessToken } = useAuth();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedDistance, setSelectedDistance] = useState<number | null>(null); // null = All
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);

  // Fetch user location and nearby workers
  useEffect(() => {
    if (visible) {
      fetchNearbyWorkers();
    }
  }, [visible, selectedDistance]);

  const fetchNearbyWorkers = async () => {
    try {
      setLoading(true);

      // Get current location
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.warn('Location permission denied');
        setLoading(false);
        return;
      }

      const location = await Location.getCurrentPositionAsync({});
      const { latitude: lat, longitude: lon } = location.coords;
      setUserLocation({ lat, lon });

      // Fetch nearby workers
      const maxMeters = selectedDistance ? selectedDistance * 1000 : 70000; // Convert km to meters, default 70km
      const query = `?lat=${lat}&lon=${lon}&max=${maxMeters}`;

      const response = await fetch(`${SERVER_URL}/workers/nearby${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = await response.json();
      if (data.success) {
        setWorkers(data.workers || []);
      }
    } catch (err) {
      console.error('Error fetching nearby workers:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleRequestWorker = (worker: Worker) => {
    if (onRequestWorker) {
      onRequestWorker(worker);
    }
  };

  const distanceFilters = [
    { label: 'All', value: null },
  ];

  const filteredWorkers = workers; // ✅ Show all workers - no filtering

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <SafeAreaView style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <MaterialIcons name="close" size={28} color="#333" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Nearby Workers</Text>
          <View style={{ width: 28 }} /> {/* Spacer for alignment */}
        </View>

        {/* Distance Filter Buttons - REMOVED */}
        {/* All workers within 70km are shown by default */}

        {/* Workers List */}
        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#667eea" />
            <Text style={styles.loadingText}>Finding nearby workers...</Text>
          </View>
        ) : filteredWorkers.length === 0 ? (
          <View style={styles.centerContainer}>
            <MaterialIcons name="people-outline" size={60} color="#ccc" />
            <Text style={styles.emptyText}>No workers found nearby</Text>
          </View>
        ) : (
          <ScrollView style={styles.workersListContainer}>
            {filteredWorkers.map((worker, index) => (
              <View key={`${worker.phone}-${index}`} style={styles.workerCard}>
                {/* Profile Photo */}
                <Image
                  source={
                    worker.profilePhoto
                      ? { uri: worker.profilePhoto }
                      : require('../assets/oip2.jpg')
                  }
                  style={styles.profilePhoto}
                />

                {/* Worker Info */}
                <View style={styles.workerInfo}>
                  <Text style={styles.workerName}>{worker.name || 'Unknown'}</Text>
                  <Text style={styles.workerSkill}>{worker.mainSkill || 'Multi-skilled'}</Text>
                  <View style={styles.ratingRow}>
                    <MaterialIcons name="star" size={14} color="#FFB800" />
                    <Text style={styles.ratingText}>{worker.rating || 0}/5</Text>
                    <Text style={styles.distanceText}>• {worker.distanceKm} km away</Text>
                  </View>
                  <Text style={styles.wageText}>
                    Expected: <Text style={styles.wageBold}>{worker.expectedWage}</Text>
                  </Text>
                </View>

                {/* Action Button */}
                <TouchableOpacity
                  style={styles.requestButton}
                  onPress={() => handleRequestWorker(worker)}
                >
                  <MaterialIcons name="person-add" size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            ))}
            {/* Bottom spacing */}
            <View style={{ height: 20 }} />
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8f9fa',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#333',
  },
  filterContainer: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  filterButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginHorizontal: 4,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#ddd',
    backgroundColor: '#fff',
  },
  filterButtonActive: {
    borderColor: '#667eea',
    backgroundColor: '#667eea',
  },
  filterButtonText: {
    fontSize: 13,
    color: '#666',
    fontWeight: '500',
  },
  filterButtonTextActive: {
    color: '#fff',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#999',
  },
  emptyText: {
    marginTop: 12,
    fontSize: 16,
    color: '#999',
    fontWeight: '500',
  },
  workersListContainer: {
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  workerCard: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 4,
    elevation: 2,
    alignItems: 'center',
  },
  profilePhoto: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#e0e0e0',
    marginRight: 12,
  },
  workerInfo: {
    flex: 1,
  },
  workerName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  workerSkill: {
    fontSize: 12,
    color: '#666',
    marginTop: 2,
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  ratingText: {
    fontSize: 12,
    color: '#666',
    marginLeft: 4,
  },
  distanceText: {
    fontSize: 12,
    color: '#999',
    marginLeft: 4,
  },
  wageText: {
    fontSize: 12,
    color: '#666',
    marginTop: 6,
  },
  wageBold: {
    fontWeight: '600',
    color: '#333',
  },
  requestButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#667eea',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
});
