import React, { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import {
  MapView,
  Camera,
  PointAnnotation,
  ShapeSource,
  LineLayer,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';

// ✅ MapTiler MapLibre-compatible styles (same as WorkerMap)
const MAPTILER_API_KEY = "rmEy5CtIKMlSfVx4fckr"; 
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`;

// Distance calculation using Haversine formula
function getDistanceFromLatLonInKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's radius in kilometers
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

// ✅ Dynamic zoom based on distance (Uber/Ola style)
function getZoomLevel(distance: number): number {
  if (distance < 1) return 16;
  if (distance < 5) return 14;
  if (distance < 15) return 12;
  if (distance < 30) return 11;
  return 9;
}

interface JobLocationMapProps {
  visible: boolean;
  onClose: () => void;
  jobTitle: string;
  jobLat: number;
  jobLon: number;
  contractorName: string;
}

export default function JobLocationMap({
  visible,
  onClose,
  jobTitle,
  jobLat,
  jobLon,
  contractorName,
}: JobLocationMapProps) {
  const [currentLocation, setCurrentLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [distance, setDistance] = useState<number>(0);
  const [jobLocationName, setJobLocationName] = useState<string>('Job Location');
  const [currentLocationName, setCurrentLocationName] = useState<string>('Your Location');
  const mountedRef = useRef<boolean>(true);

  // ✅ Calculate estimated travel time (assuming 30km/h avg speed)
  const estimatedMinutes = distance > 0 ? Math.ceil((distance / 30) * 60) : 0;

  useEffect(() => {
    // ✅ FIX: Reset mountedRef when effect runs (fixes re-mount bug)
    mountedRef.current = true;

    if (!visible) return;

    (async () => {
      try {
        setLoading(true);

        // Get current location
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setLoading(false);
          return;
        }

        const loc = await Location.getCurrentPositionAsync({});
        const currentLoc = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
        
        if (mountedRef.current) {
          setCurrentLocation(currentLoc);

          // Calculate distance
          const dist = getDistanceFromLatLonInKm(
            currentLoc.latitude,
            currentLoc.longitude,
            jobLat,
            jobLon
          );
          setDistance(dist);

          // Get location names
          try {
            const currentAddress = await Location.reverseGeocodeAsync(currentLoc);
            if (currentAddress[0]) {
              const addr = currentAddress[0];
              setCurrentLocationName(
                `${addr.name || addr.street || ''}, ${addr.city || addr.region || ''}`.trim() || 'Your Location'
              );
            }
          } catch (e) {
            console.log('Error getting current address:', e);
          }

          try {
            const jobAddress = await Location.reverseGeocodeAsync({ latitude: jobLat, longitude: jobLon });
            if (jobAddress[0]) {
              const addr = jobAddress[0];
              setJobLocationName(
                `${addr.name || addr.street || ''}, ${addr.city || addr.region || ''}`.trim() || 'Job Location'
              );
            }
          } catch (e) {
            console.log('Error getting job address:', e);
          }

          setLoading(false);
        }
      } catch (error) {
        console.error('Error in JobLocationMap:', error);
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, [visible, jobLat, jobLon]);

  // Calculate center point between job and current location
  const centerLat = currentLocation ? (currentLocation.latitude + jobLat) / 2 : jobLat;
  const centerLon = currentLocation ? (currentLocation.longitude + jobLon) / 2 : jobLon;

  // ✅ Open in Google Maps (safer version with null check + official API format)
  const openInGoogleMaps = () => {
    if (!currentLocation) {
      console.warn('Current location not available');
      return;
    }

    const url = `https://www.google.com/maps/dir/?api=1&origin=${currentLocation.latitude},${currentLocation.longitude}&destination=${jobLat},${jobLon}&travelmode=driving`;
    Linking.openURL(url).catch(err => console.error('Error opening Google Maps:', err));
  };

  if (!visible) return null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent={true}
    >
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>{jobTitle}</Text>
        <TouchableOpacity onPress={onClose} style={styles.closeButton}>
          <MaterialIcons name="close" size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Map Container */}
      <View style={styles.mapContainer}>
        {loading ? (
          <View style={styles.loaderContainer}>
            <ActivityIndicator size="large" color="#2196F3" />
          </View>
        ) : currentLocation ? (
          <MapView
            style={styles.map}
            mapStyle={MAP_STYLE_URL}
            logoEnabled={false}
            attributionEnabled={false}
          >
            <Camera
              centerCoordinate={[centerLon, centerLat]}
              zoomLevel={getZoomLevel(distance)}
              animationDuration={500}
            />

            {/* ✅ Route Line (connects both markers) */}
            {currentLocation && (
              <ShapeSource
                id="route"
                shape={{
                  type: 'Feature',
                  geometry: {
                    type: 'LineString',
                    coordinates: [
                      [currentLocation.longitude, currentLocation.latitude],
                      [jobLon, jobLat],
                    ],
                  },
                  properties: {},
                }}
              >
                <LineLayer
                  id="route-line"
                  style={{
                    lineColor: '#2196F3',
                    lineWidth: 4,
                    lineOpacity: 0.7,
                    lineDasharray: [2, 2],
                  }}
                />
              </ShapeSource>
            )}

            {/* Current Location Marker */}
            <PointAnnotation
              id="current-location"
              coordinate={[currentLocation.longitude, currentLocation.latitude]}
            >
              <View style={styles.currentLocationMarker}>
                <MaterialIcons name="my-location" size={20} color="#fff" />
              </View>
            </PointAnnotation>

            {/* Job Location Marker */}
            <PointAnnotation
              id="job-location"
              coordinate={[jobLon, jobLat]}
            >
              <View style={styles.jobLocationMarker}>
                <MaterialIcons name="location-on" size={24} color="#fff" />
              </View>
            </PointAnnotation>
          </MapView>
        ) : (
          <View style={styles.loaderContainer}>
            <Text style={styles.errorText}>Unable to load map</Text>
          </View>
        )}
      </View>

      {/* Info Footer */}
      <View style={styles.infoSection}>
        <View style={styles.infoItem}>
          <MaterialIcons name="location-on" size={20} color="#2196F3" />
          <View style={styles.infoTextContainer}>
            <Text style={styles.label}>Distance</Text>
            <Text style={styles.value}>{distance.toFixed(2)} km</Text>
          </View>
        </View>

        {/* ✅ Estimated Travel Time */}
        <View style={styles.infoItem}>
          <MaterialIcons name="schedule" size={20} color="#f59e0b" />
          <View style={styles.infoTextContainer}>
            <Text style={styles.label}>Estimated Time</Text>
            <Text style={styles.value}>{estimatedMinutes} mins</Text>
          </View>
        </View>

        <View style={styles.infoItem}>
          <MaterialIcons name="my-location" size={20} color="#10b981" />
          <View style={styles.infoTextContainer}>
            <Text style={styles.label}>Your Location</Text>
            <Text style={styles.value}>{currentLocationName}</Text>
          </View>
        </View>

        <View style={styles.infoItem}>
          <MaterialIcons name="work-outline" size={20} color="#f59e0b" />
          <View style={styles.infoTextContainer}>
            <Text style={styles.label}>Job Location</Text>
            <Text style={styles.value}>{jobLocationName}</Text>
          </View>
        </View>

        {/* Google Maps Button */}
        <TouchableOpacity style={styles.googleMapsButton} onPress={openInGoogleMaps}>
          <MaterialIcons name="map" size={20} color="#fff" />
          <Text style={styles.googleMapsButtonText}>Open in Google Maps</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1a1a1a',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#2a2a2a',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#fff',
  },
  closeButton: {
    padding: 8,
  },
  mapContainer: {
    flex: 1,
    backgroundColor: '#e0e0e0',
  },
  map: {
    flex: 1,
  },
  loaderContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorText: {
    color: '#ff6b6b',
    fontSize: 16,
    fontWeight: '500',
  },
  currentLocationMarker: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#2196F3',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  jobLocationMarker: {
    width: 45,
    height: 45,
    borderRadius: 22.5,
    backgroundColor: '#f59e0b',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#fff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  infoSection: {
    backgroundColor: '#2a2a2a',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#3a3a3a',
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  infoTextContainer: {
    marginLeft: 12,
    flex: 1,
  },
  label: {
    fontSize: 12,
    color: '#999',
    marginBottom: 2,
  },
  value: {
    fontSize: 14,
    color: '#fff',
    fontWeight: '500',
  },
  googleMapsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2196F3',
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 12,
  },
  googleMapsButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 8,
  },
});
