import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  FlatList,
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
  totalReviews?: number; // ✅ Number of ratings received
  skills: string[];
  profilePhoto?: string;
  isAvailable?: boolean; // ✅ Online status
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
  const { accessToken, user: authUser } = useAuth();
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  
  // ✅ Filter states
  const [selectedSkill, setSelectedSkill] = useState<string>('All Skills');
  const [selectedWageRange, setSelectedWageRange] = useState<string>('All Wages');
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false);
  const [wageDropdownOpen, setWageDropdownOpen] = useState(false);
  
  // ✅ Phase 3: Pagination states
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // ✅ STEP 1: Get location ONCE when modal opens (not on every filter change)
  useEffect(() => {
    if (!visible) return;

    const initializeLocation = async () => {
      // ✅ Priority 1: Use user's stored location from login
      if (authUser?.location?.coordinates) {
        const [lon, lat] = authUser.location.coordinates;
        setUserLocation({ lat, lon });
        console.log(`📍 Using stored user location from login: [${lon}, ${lat}]`);
        return;
      }

      // ✅ Priority 2: Request GPS location as fallback
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          console.warn('Location permission denied');
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        const { latitude: lat, longitude: lon } = location.coords;
        setUserLocation({ lat, lon });
        console.log(`📍 Using current GPS location: [${lon}, ${lat}]`);
      } catch (err) {
        console.error('Error getting location:', err);
      }
    };

    initializeLocation();
  }, [visible, authUser]);  // Only runs when modal opens or authUser changes

  // ✅ PHASE 2: Reset filters when modal closes
  useEffect(() => {
    if (!visible) {
      setSelectedSkill('All Skills');
      setSelectedWageRange('All Wages');
      setWorkers([]);
      setPage(1);
      setHasMore(true);
      setLoadingMore(false);
    }
  }, [visible]);

  // ✅ STEP 2: Fetch workers ONLY when filters change (debounced)
  // Location is already set, so just send filters
  // Reset page to 1 when filters change
  useEffect(() => {
    if (!visible || !userLocation) return;

    setPage(1);
    setWorkers([]);
    setHasMore(true);

    const debounceTimer = setTimeout(() => {
      fetchNearbyWorkers(1);
    }, 500);  // Wait 500ms after last filter change

    return () => clearTimeout(debounceTimer);
  }, [visible, selectedSkill, selectedWageRange, userLocation]);

  const fetchNearbyWorkers = async (pageNum: number = page) => {
    if (!userLocation) return;

    try {
      // ✅ Set appropriate loading state
      if (pageNum === 1) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      // ✅ Build query with ALREADY-SET location and pagination
      let query = `?lat=${userLocation.lat}&lon=${userLocation.lon}&max=70000&page=${pageNum}&limit=20`;
      
      // Add skill filter if not "All Skills"
      if (selectedSkill !== 'All Skills') {
        query += `&skill=${encodeURIComponent(selectedSkill)}`;
      }
      
      // Add wage range filter if not "All Wages"
      if (selectedWageRange !== 'All Wages') {
        const wageRangeMap: { [key: string]: [number, number] } = {
          '100-300': [100, 300],
          '300-500': [300, 500],
          '500-1000': [500, 1000],
          '1000+': [1000, 999999],
        };
        const [wageMin, wageMax] = wageRangeMap[selectedWageRange] || [];
        if (wageMin) query += `&wageMin=${wageMin}`;
        if (wageMax && wageMax !== 999999) query += `&wageMax=${wageMax}`;
      }

      console.log(`🔍 Fetching workers page ${pageNum} with query: ${query}`);
      const response = await fetch(`${SERVER_URL}/workers/nearby${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = await response.json();
      if (data.success) {
        const newWorkers = data.workers || [];
        // Append if loading more pages, replace if first page
        setWorkers(pageNum === 1 ? newWorkers : prev => [...prev, ...newWorkers]);
        // Check if there are more results
        setHasMore(newWorkers.length === 20);
      }
    } catch (err) {
      console.error('Error fetching nearby workers:', err);
    } finally {
      // ✅ Reset appropriate loading state
      if (pageNum === 1) {
        setLoading(false);
      } else {
        setLoadingMore(false);
      }
    }
  };

  const handleRequestWorker = (worker: Worker) => {
    if (onRequestWorker) {
      onRequestWorker(worker);
    }
  };

  // ✅ Get unique skills from fetched workers (for dropdown options)
  const getUniqueSkills = (): string[] => {
    const skillSet = new Set<string>();
    skillSet.add('All Skills');
    workers.forEach((worker) => {
      if (worker.mainSkill) {
        skillSet.add(worker.mainSkill);
      }
      if (worker.skills && Array.isArray(worker.skills)) {
        worker.skills.forEach((skill) => skillSet.add(skill));
      }
    });
    return Array.from(skillSet).sort();
  };

  const wageRanges = ['All Wages', '100-300', '300-500', '500-1000', '1000+'];

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose}>
            <MaterialIcons name="close" size={28} color="#333" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Nearby Workers</Text>
          <View style={{ width: 28 }} /> {/* Spacer for alignment */}
        </View>

        {/* ✅ Filters Section */}
        <View style={styles.filtersContainer}>
          {/* Skill Filter */}
          <View style={styles.filterSection}>
            <Text style={styles.filterLabel}>Skill</Text>
            <TouchableOpacity 
              style={styles.dropdownButton}
              onPress={() => {
                setSkillDropdownOpen(!skillDropdownOpen);
                setWageDropdownOpen(false);
              }}
            >
              <Text style={styles.dropdownButtonText}>{selectedSkill}</Text>
              <MaterialIcons name={skillDropdownOpen ? "expand-less" : "expand-more"} size={20} color="#667eea" />
            </TouchableOpacity>
            
            {/* Skill Dropdown */}
            {skillDropdownOpen && (
              <View style={styles.dropdownMenu}>
                <ScrollView style={styles.dropdownScroll} nestedScrollEnabled={true}>
                  {getUniqueSkills().map((skill) => (
                    <TouchableOpacity
                      key={skill}
                      style={[
                        styles.dropdownItem,
                        selectedSkill === skill && styles.dropdownItemActive,
                      ]}
                      onPress={() => {
                        setSelectedSkill(skill);
                        setSkillDropdownOpen(false);
                      }}
                    >
                      <Text style={[
                        styles.dropdownItemText,
                        selectedSkill === skill && styles.dropdownItemTextActive,
                      ]}>
                        {skill}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>

          {/* Wage Filter */}
          <View style={styles.filterSection}>
            <Text style={styles.filterLabel}>Wage Range</Text>
            <TouchableOpacity 
              style={styles.dropdownButton}
              onPress={() => {
                setWageDropdownOpen(!wageDropdownOpen);
                setSkillDropdownOpen(false);
              }}
            >
              <Text style={styles.dropdownButtonText}>{selectedWageRange}</Text>
              <MaterialIcons name={wageDropdownOpen ? "expand-less" : "expand-more"} size={20} color="#667eea" />
            </TouchableOpacity>

            {/* Wage Dropdown */}
            {wageDropdownOpen && (
              <View style={styles.dropdownMenu}>
                {wageRanges.map((range) => (
                  <TouchableOpacity
                    key={range}
                    style={[
                      styles.dropdownItem,
                      selectedWageRange === range && styles.dropdownItemActive,
                    ]}
                    onPress={() => {
                      setSelectedWageRange(range);
                      setWageDropdownOpen(false);
                    }}
                  >
                    <Text style={[
                      styles.dropdownItemText,
                      selectedWageRange === range && styles.dropdownItemTextActive,
                    ]}>
                      {range}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* Workers List */}
        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#667eea" />
            <Text style={styles.loadingText}>Finding nearby workers...</Text>
          </View>
        ) : workers.length === 0 ? (
          <View style={styles.centerContainer}>
            <MaterialIcons name="people-outline" size={60} color="#ccc" />
            <Text style={styles.emptyText}>No workers match your filters</Text>
          </View>
        ) : (
          <FlatList
            data={workers}
            keyExtractor={(item, index) => `${item.phone}-${index}`}
            refreshing={loading}
            onRefresh={() => fetchNearbyWorkers(1)}
            renderItem={({ item: worker }) => (
              <View style={styles.workerCard}>
                {/* Profile Photo Container */}
                <View style={styles.photoContainer}>
                  <Image
                    source={
                      worker.profilePhoto
                        ? { uri: worker.profilePhoto }
                        : require('../assets/oip2.jpg')
                    }
                    style={styles.profilePhoto}
                  />
                  {/* ✅ Online Indicator */}
                  {worker.isAvailable && (
                    <View style={styles.onlineIndicator}>
                      <View style={styles.onlineDot} />
                    </View>
                  )}
                </View>

                {/* Worker Info */}
                <View style={styles.workerInfo}>
                  <View style={styles.nameRow}>
                    <Text style={styles.workerName}>{worker.name || 'Unknown'}</Text>
                    {worker.isAvailable && <Text style={styles.onlineLabel}>Online</Text>}
                  </View>
                  <Text style={styles.workerSkill}>{worker.mainSkill || 'Multi-skilled'}</Text>
                  <View style={styles.ratingRow}>
                    <MaterialIcons name="star" size={14} color="#FFB800" />
                    <Text style={styles.ratingText}>{worker.rating?.toFixed(1) || 0}/5</Text>
                    <Text style={styles.distanceText}>• {worker.distanceKm} km</Text>
                    {worker.totalReviews !== undefined && worker.totalReviews > 0 && (
                      <Text style={styles.reviewText}>({worker.totalReviews})</Text>
                    )}
                  </View>
                  <Text style={styles.wageText}>
                    Wage: <Text style={styles.wageBold}>{worker.expectedWage}</Text>
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
            )}
            contentContainerStyle={styles.flatListContainer}
            onEndReached={() => {
              if (hasMore && !loadingMore && !loading) {
                setPage(prev => {
                  const nextPage = prev + 1;
                  fetchNearbyWorkers(nextPage);
                  return nextPage;
                });
              }
            }}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              loadingMore ? (
                <View style={styles.loadMoreContainer}>
                  <ActivityIndicator size="small" color="#667eea" />
                  <Text style={styles.loadMoreText}>Loading more workers...</Text>
                </View>
              ) : null
            }
          />
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
  
  // ✅ Filter Styles
  filtersContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
    gap: 10,
  },
  
  filterSection: {
    flex: 1,
  },
  
  filterLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#666',
    marginBottom: 4,
  },
  
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#f5f5f5',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
  },
  
  dropdownButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#333',
    flex: 1,
  },
  
  dropdownMenu: {
    position: 'absolute',
    top: 62,
    left: 12,
    right: 12,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e0e0e0',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    zIndex: 1000,
    maxHeight: 200,
  },
  
  dropdownScroll: {
    maxHeight: 200,
  },
  
  dropdownItem: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f5f5f5',
  },
  
  dropdownItemActive: {
    backgroundColor: '#667eea20',
  },
  
  dropdownItemText: {
    fontSize: 13,
    color: '#333',
  },
  
  dropdownItemTextActive: {
    color: '#667eea',
    fontWeight: '600',
  },
  
  photoContainer: {
    position: 'relative',
    marginRight: 12,
  },
  
  onlineIndicator: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  
  onlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#10B981',
  },
  
  onlineLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: '#10B981',
    marginLeft: 4,
  },
  
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
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
  flatListContainer: {
    paddingHorizontal: 0,
    paddingTop: 10,
    paddingBottom: 20,
  },
  loadMoreContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
  },
  loadMoreText: {
    fontSize: 12,
    color: '#999',
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
    alignItems: 'flex-start',
  },
  profilePhoto: {
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#e0e0e0',
  },
  workerInfo: {
    flex: 1,
    marginLeft: 12,
  },
  workerName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
  workerSkill: {
    fontSize: 12,
    color: '#666',
    marginTop: 3,
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
  reviewText: {
    fontSize: 11,
    color: '#999',
    marginLeft: 2,
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
