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
import { socket } from '../utils/socket';
import { useAuth } from '../context/AuthContext';
import { SERVER_URL } from '../utils/config';
import JobRequestModal from './JobRequestModal';

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
  const [selectedSkill, setSelectedSkill] = useState<string>('All Skills');
  const [selectedWageRange, setSelectedWageRange] = useState<string>('All Wages');
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false);
  const [wageDropdownOpen, setWageDropdownOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [jobRequestPanelVisible, setJobRequestPanelVisible] = useState(false);
  const [selectedWorker, setSelectedWorker] = useState<Worker | null>(null);
  const [pendingRequests, setPendingRequests] = useState<{ [phone: string]: { requestId: string; timestamp: Date } }>({});

  useEffect(() => {
    if (!visible) return;

    const initializeLocation = async () => {
      if (authUser?.location?.coordinates) {
        const [lon, lat] = authUser.location.coordinates;
        setUserLocation({ lat, lon });
        return;
      }

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          console.warn('Location permission denied');
          return;
        }

        const location = await Location.getCurrentPositionAsync({});
        const { latitude: lat, longitude: lon } = location.coords;
        setUserLocation({ lat, lon });
      } catch (err) {
        console.error('Error getting location:', err);
      }
    };

    initializeLocation();
  }, [visible, authUser]);

  useEffect(() => {
    if (!visible) {
      setSelectedSkill('All Skills');
      setSelectedWageRange('All Wages');
      setWorkers([]);
      setPage(1);
      setHasMore(true);
      setLoadingMore(false);
      setJobRequestPanelVisible(false);
      setSelectedWorker(null);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const handleJobRequestResponse = (data: any) => {
      if (!data) return;
      const workerPhone = String(data.workerPhone || '').trim();
      if (!workerPhone) return;

      setPendingRequests((prev) => {
        if (!prev[workerPhone]) return prev;
        const next = { ...prev };
        delete next[workerPhone];
        return next;
      });
    };

    socket.on('jobRequestResponse', handleJobRequestResponse);

    return () => {
      socket.off('jobRequestResponse', handleJobRequestResponse);
    };
  }, [visible]);

  useEffect(() => {
    if (!visible || !userLocation) return;

    setPage(1);
    setWorkers([]);
    setHasMore(true);

    const debounceTimer = setTimeout(() => {
      fetchNearbyWorkers(1);
    }, 500);

    return () => clearTimeout(debounceTimer);
  }, [visible, selectedSkill, selectedWageRange, userLocation]);

  const fetchNearbyWorkers = async (pageNum: number = page) => {
    if (!userLocation) return;

    try {
      if (pageNum === 1) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }

      let query = `?lat=${userLocation.lat}&lon=${userLocation.lon}&max=70000&page=${pageNum}&limit=20`;

      if (selectedSkill !== 'All Skills') {
        query += `&skill=${encodeURIComponent(selectedSkill)}`;
      }

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

      const response = await fetch(`${SERVER_URL}/workers/nearby${query}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const data = await response.json();
      if (data.success) {
        const newWorkers = data.workers || [];
        setWorkers(pageNum === 1 ? newWorkers : (prev) => [...prev, ...newWorkers]);
        setHasMore(newWorkers.length === 20);
      }
    } catch (err) {
      console.error('Error fetching nearby workers:', err);
    } finally {
      if (pageNum === 1) {
        setLoading(false);
      } else {
        setLoadingMore(false);
      }
    }
  };

  const handleRequestWorker = (worker: Worker) => {
    setSelectedWorker(worker);
    setJobRequestPanelVisible(true);
    if (onRequestWorker) onRequestWorker(worker);
  };

  const closeJobRequestPanel = () => {
    setJobRequestPanelVisible(false);
    setSelectedWorker(null);
  };

  const handleRequestSent = (workerPhone: string, requestId: string) => {
    setPendingRequests((prev) => ({
      ...prev,
      [workerPhone]: { requestId, timestamp: new Date() },
    }));
  };

  const getUniqueSkills = (): string[] => {
    const skillSet = new Set<string>();
    skillSet.add('All Skills');
    workers.forEach((worker) => {
      if (worker.mainSkill) skillSet.add(worker.mainSkill);
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
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.headerIconButton}>
            <MaterialIcons name="close" size={22} color="#111827" />
          </TouchableOpacity>
          <View style={styles.headerTextWrap}>
            <Text style={styles.headerTitle}>Nearby Workers</Text>
            <Text style={styles.headerSubtitle}>Browse and request workers near your location</Text>
          </View>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.filtersShell}>
          <View style={styles.filterSection}>
            <Text style={styles.filterLabel}>Skill</Text>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => {
                setSkillDropdownOpen(!skillDropdownOpen);
                setWageDropdownOpen(false);
              }}
            >
              <Text style={styles.dropdownButtonText} numberOfLines={1}>{selectedSkill}</Text>
              <MaterialIcons name={skillDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#4B5563" />
            </TouchableOpacity>

            {skillDropdownOpen && (
              <View style={styles.dropdownMenu}>
                <ScrollView style={styles.dropdownScroll} nestedScrollEnabled={true}>
                  {getUniqueSkills().map((skill) => (
                    <TouchableOpacity
                      key={skill}
                      style={[styles.dropdownItem, selectedSkill === skill && styles.dropdownItemActive]}
                      onPress={() => {
                        setSelectedSkill(skill);
                        setSkillDropdownOpen(false);
                      }}
                    >
                      <Text style={[styles.dropdownItemText, selectedSkill === skill && styles.dropdownItemTextActive]}>
                        {skill}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              </View>
            )}
          </View>

          <View style={styles.filterSection}>
            <Text style={styles.filterLabel}>Wage</Text>
            <TouchableOpacity
              style={styles.dropdownButton}
              onPress={() => {
                setWageDropdownOpen(!wageDropdownOpen);
                setSkillDropdownOpen(false);
              }}
            >
              <Text style={styles.dropdownButtonText} numberOfLines={1}>{selectedWageRange}</Text>
              <MaterialIcons name={wageDropdownOpen ? 'expand-less' : 'expand-more'} size={20} color="#4B5563" />
            </TouchableOpacity>

            {wageDropdownOpen && (
              <View style={styles.dropdownMenu}>
                {wageRanges.map((range) => (
                  <TouchableOpacity
                    key={range}
                    style={[styles.dropdownItem, selectedWageRange === range && styles.dropdownItemActive]}
                    onPress={() => {
                      setSelectedWageRange(range);
                      setWageDropdownOpen(false);
                    }}
                  >
                    <Text style={[styles.dropdownItemText, selectedWageRange === range && styles.dropdownItemTextActive]}>
                      {range}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        </View>

        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#17263A" />
            <Text style={styles.loadingText}>Finding nearby workers...</Text>
          </View>
        ) : workers.length === 0 ? (
          <View style={styles.centerContainer}>
            <View style={styles.emptyIconWrap}>
              <MaterialIcons name="people-outline" size={36} color="#9CA3AF" />
            </View>
            <Text style={styles.emptyTitle}>No workers found</Text>
            <Text style={styles.emptyText}>Try a different skill or wage filter.</Text>
          </View>
        ) : (
          <FlatList
            data={workers}
            keyExtractor={(item, index) => `${item.phone}-${index}`}
            refreshing={loading}
            onRefresh={() => fetchNearbyWorkers(1)}
            renderItem={({ item: worker }) => (
              <View style={styles.workerCard}>
                <View style={styles.workerTopRow}>
                  <View style={styles.workerIdentity}>
                    <View style={styles.photoContainer}>
                      <Image
                        source={worker.profilePhoto ? { uri: worker.profilePhoto } : require('../assets/oip2.jpg')}
                        style={styles.profilePhoto}
                      />
                      {worker.isAvailable && (
                        <View style={styles.onlineIndicator}>
                          <View style={styles.onlineDot} />
                        </View>
                      )}
                    </View>

                    <View style={styles.workerInfo}>
                      <View style={styles.nameRow}>
                        <Text style={styles.workerName}>{worker.name || 'Unknown'}</Text>
                        {worker.isAvailable && <Text style={styles.onlineLabel}>Online</Text>}
                      </View>
                      <Text style={styles.workerSkill}>{worker.mainSkill || 'Multi-skilled'}</Text>
                    </View>
                  </View>

                  {pendingRequests[worker.phone] ? (
                    <View style={styles.requestSentContainer}>
                      <MaterialIcons name="check-circle" size={16} color="#059669" />
                      <Text style={styles.requestSentText}>Sent</Text>
                    </View>
                  ) : (
                    <TouchableOpacity style={styles.requestButton} onPress={() => handleRequestWorker(worker)}>
                      <MaterialIcons name="person-add" size={18} color="#fff" />
                      <Text style={styles.requestButtonText}>Request</Text>
                    </TouchableOpacity>
                  )}
                </View>

                <View style={styles.metaRow}>
                  <View style={styles.metaChip}>
                    <MaterialIcons name="star" size={14} color="#F59E0B" />
                    <Text style={styles.metaChipText}>{worker.rating?.toFixed(1) || 0}/5</Text>
                    {worker.totalReviews !== undefined && worker.totalReviews > 0 && (
                      <Text style={styles.metaMutedText}>({worker.totalReviews})</Text>
                    )}
                  </View>
                  <View style={styles.metaChip}>
                    <MaterialIcons name="near-me" size={14} color="#2563EB" />
                    <Text style={styles.metaChipText}>{worker.distanceKm} km</Text>
                  </View>
                  <View style={styles.metaChip}>
                    <MaterialIcons name="payments" size={14} color="#059669" />
                    <Text style={styles.metaChipText}>{worker.expectedWage}</Text>
                  </View>
                </View>
              </View>
            )}
            contentContainerStyle={styles.flatListContainer}
            onEndReached={() => {
              if (hasMore && !loadingMore && !loading) {
                setPage((prev) => {
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
                  <ActivityIndicator size="small" color="#17263A" />
                  <Text style={styles.loadMoreText}>Loading more workers...</Text>
                </View>
              ) : null
            }
          />
        )}
      </SafeAreaView>

      {jobRequestPanelVisible && selectedWorker ? (
        <JobRequestModal
          visible={true}
          renderAsPanel={true}
          onClose={closeJobRequestPanel}
          worker={selectedWorker}
          onRequestSent={(workerPhone, requestId) => {
            handleRequestSent(workerPhone, requestId);
            closeJobRequestPanel();
          }}
        />
      ) : null}
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F4F6F8',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#ECEFF3',
  },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextWrap: {
    flex: 1,
    marginLeft: 12,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  headerSubtitle: {
    marginTop: 2,
    fontSize: 12,
    color: '#6B7280',
  },
  headerSpacer: {
    width: 40,
  },
  filtersShell: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 8,
  },
  filterSection: {
    flex: 1,
    zIndex: 10,
  },
  filterLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#6B7280',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  dropdownButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  dropdownButtonText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1F2937',
    flex: 1,
  },
  dropdownMenu: {
    position: 'absolute',
    top: 66,
    left: 0,
    right: 0,
    backgroundColor: '#fff',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#E5E7EB',
    shadowColor: '#0F172A',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
    zIndex: 1000,
    maxHeight: 220,
    overflow: 'hidden',
  },
  dropdownScroll: {
    maxHeight: 220,
  },
  dropdownItem: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  dropdownItemActive: {
    backgroundColor: '#EEF2FF',
  },
  dropdownItemText: {
    fontSize: 13,
    color: '#1F2937',
  },
  dropdownItemTextActive: {
    color: '#4338CA',
    fontWeight: '700',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6B7280',
  },
  emptyIconWrap: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  emptyTitle: {
    marginTop: 16,
    fontSize: 17,
    fontWeight: '700',
    color: '#111827',
  },
  emptyText: {
    marginTop: 6,
    fontSize: 13,
    color: '#6B7280',
    textAlign: 'center',
  },
  flatListContainer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 24,
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
    color: '#6B7280',
  },
  workerCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 22,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#EAECEF',
  },
  workerTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  workerIdentity: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  photoContainer: {
    position: 'relative',
    marginRight: 12,
  },
  profilePhoto: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: '#E5E7EB',
  },
  onlineIndicator: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: '#fff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  onlineDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: '#10B981',
  },
  workerInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  workerName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#111827',
  },
  onlineLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#10B981',
    marginLeft: 6,
  },
  workerSkill: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 4,
  },
  requestButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#17263A',
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 19,
  },
  requestButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 6,
  },
  requestSentContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#ECFDF5',
    paddingHorizontal: 12,
    height: 38,
    borderRadius: 19,
    borderWidth: 1,
    borderColor: '#A7F3D0',
  },
  requestSentText: {
    fontSize: 12,
    color: '#059669',
    fontWeight: '700',
    marginLeft: 6,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
  },
  metaChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F8FAFC',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  metaChipText: {
    marginLeft: 5,
    fontSize: 12,
    fontWeight: '600',
    color: '#1F2937',
  },
  metaMutedText: {
    marginLeft: 4,
    fontSize: 11,
    color: '#6B7280',
  },
});
