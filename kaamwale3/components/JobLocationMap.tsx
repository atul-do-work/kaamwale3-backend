import React, { useEffect, useState } from 'react';
import { View, Text, Modal, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import MapLibreGL from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';

const MAP_STYLE = 'https://demotiles.maplibre.org/style.json';

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
  
  // ✅ Modal state for alerts
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<"success" | "error" | "info">("success");
  
  const showModal = (type: "success" | "error" | "info", title: string, message: string) => {
    setModalType(type);
    setModalTitle(title);
    setModalMessage(message);
    setModalVisible(true);
  };

  useEffect(() => {
    if (!visible) return;

    (async () => {
      try {
        setLoading(true);

        // Get current location
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          showModal('error', 'Permission Denied', 'Location permission is required to show the map');
          return;
        }

        const loc = await Location.getCurrentPositionAsync({});
        const currentLoc = {
          latitude: loc.coords.latitude,
          longitude: loc.coords.longitude,
        };
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
          if (currentAddress?.[0]) {
            const { name, city } = currentAddress[0];
            setCurrentLocationName(name && city ? `${name}, ${city}` : name || 'Your Location');
          }

          const jobAddress = await Location.reverseGeocodeAsync({ latitude: jobLat, longitude: jobLon });
          if (jobAddress?.[0]) {
            const { name, city } = jobAddress[0];
            setJobLocationName(name && city ? `${name}, ${city}` : name || 'Job Location');
          }
        } catch (err) {
          console.log('Could not reverse geocode location names');
        }

        setLoading(false);
      } catch (err) {
        console.error('Error getting location:', err);
        showModal('error', 'Error', 'Could not get current location');
        setLoading(false);
      }
    })();
  }, [visible]);

  const handleOpenMapbox = () => {
    if (!currentLocation) return;

    // Open in Google Maps
    const url = `https://www.google.com/maps/dir/?api=1&origin=${currentLocation.latitude},${currentLocation.longitude}&destination=${jobLat},${jobLon}`;
    Linking.openURL(url).catch(() => {
      showModal('error', 'Error', 'Could not open Maps');
    });
  };

  if (!currentLocation && visible) {
    return (
      <Modal visible={visible} transparent animationType="slide">
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <View style={{ backgroundColor: '#fff', padding: 20, borderRadius: 12, width: '80%' }}>
            <ActivityIndicator size="large" color="#667eea" />
            <Text style={{ marginTop: 12, textAlign: 'center', color: '#333' }}>Loading location...</Text>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        {/* Header */}
        <View style={{ 
          paddingTop: 40, 
          paddingBottom: 12, 
          paddingHorizontal: 16, 
          backgroundColor: '#1b1b2f',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff', flex: 1 }}>
            {jobTitle}
          </Text>
          <TouchableOpacity onPress={onClose}>
            <MaterialIcons name="close" size={28} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Map */}
        {currentLocation && (
          <MapLibreGL.MapView
            style={{ flex: 1 }}
          >
            <MapLibreGL.Camera
              centerCoordinate={[
                (currentLocation.longitude + jobLon) / 2,
                (currentLocation.latitude + jobLat) / 2,
              ]}
              zoomLevel={13}
              animationDuration={500}
            />

            {/* Worker Location Marker */}
            <MapLibreGL.PointAnnotation
              id="worker-location"
              coordinate={[currentLocation.longitude, currentLocation.latitude]}
            >
              <View style={{ 
                width: 40, 
                height: 40, 
                borderRadius: 20, 
                backgroundColor: '#2196F3',
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: 3,
                borderColor: '#fff'
              }} />
            </MapLibreGL.PointAnnotation>

            {/* Job Location Marker */}
            <MapLibreGL.PointAnnotation
              id="job-location"
              coordinate={[jobLon, jobLat]}
            >
              <View style={{ 
                width: 40, 
                height: 40, 
                borderRadius: 20, 
                backgroundColor: '#FF6B6B',
                justifyContent: 'center',
                alignItems: 'center',
                borderWidth: 3,
                borderColor: '#fff'
              }} />
            </MapLibreGL.PointAnnotation>

            {/* Route Line */}
            <MapLibreGL.ShapeSource
              id="route-source"
              shape={{
                type: 'Feature',
                properties: {},
                geometry: {
                  type: 'LineString',
                  coordinates: [
                    [currentLocation.longitude, currentLocation.latitude],
                    [jobLon, jobLat],
                  ],
                },
              }}
            >
              <MapLibreGL.LineLayer
                id="route-line"
                style={{
                  lineColor: '#667eea',
                  lineWidth: 3,
                  lineOpacity: 0.7,
                }}
              />
            </MapLibreGL.ShapeSource>
          </MapLibreGL.MapView>
        )}

        {/* Bottom Info Card */}
        <View style={{ 
          backgroundColor: '#1b1b2f', 
          padding: 16,
          borderTopLeftRadius: 12,
          borderTopRightRadius: 12
        }}>
          {/* Distance Info */}
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <MaterialIcons name="straighten" size={24} color="#667eea" />
            <View style={{ marginLeft: 12, flex: 1 }}>
              <Text style={{ color: '#aaa', fontSize: 12 }}>Distance</Text>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
                {distance.toFixed(2)} km
              </Text>
            </View>
          </View>

          {/* Location Info */}
          <View style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <MaterialIcons name="my-location" size={20} color="#2196F3" />
              <Text style={{ color: '#2196F3', marginLeft: 8, fontWeight: '600' }}>Your Location</Text>
            </View>
            <Text style={{ color: '#ccc', fontSize: 13, marginLeft: 28 }}>
              {currentLocationName}
            </Text>
          </View>

          <View style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <MaterialIcons name="location-on" size={20} color="#FF6B6B" />
              <Text style={{ color: '#FF6B6B', marginLeft: 8, fontWeight: '600' }}>Job Location</Text>
            </View>
            <Text style={{ color: '#ccc', fontSize: 13, marginLeft: 28 }}>
              {jobLocationName}
            </Text>
          </View>

          {/* Open Maps Button */}
          <TouchableOpacity 
            onPress={handleOpenMapbox}
            style={{ 
              backgroundColor: '#667eea',
              paddingVertical: 14,
              borderRadius: 10,
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <MaterialIcons name="directions" size={20} color="#fff" />
            <Text style={{ color: '#fff', fontWeight: '700', marginLeft: 8, fontSize: 16 }}>
              Get Directions
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* ✅ Custom Alert Modal */}
      <Modal
        transparent={true}
        animationType="fade"
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            {/* Modal Header with Icon */}
            <View style={[
              styles.modalHeader,
              {
                backgroundColor: modalType === "success" ? "#10B98120" : modalType === "error" ? "#EF444420" : "#3B82F620",
              }
            ]}>
              <View style={[
                styles.modalIconBg,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}>
                <MaterialIcons
                  name={
                    modalType === "success" ? "check-circle" :
                    modalType === "error" ? "error" :
                    "info"
                  }
                  size={32}
                  color="#fff"
                />
              </View>
            </View>

            {/* Modal Content */}
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>{modalTitle}</Text>
              <Text style={styles.modalMessage}>{modalMessage}</Text>
            </View>

            {/* Modal Footer - OK Button */}
            <TouchableOpacity
              style={[
                styles.modalButton,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </Modal>
  );
}

const styles = StyleSheet.create({
  // ✅ Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },

  modalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 320,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },

  modalHeader: {
    paddingVertical: 24,
    alignItems: "center",
  },

  modalIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },

  modalContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: "center",
  },

  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 8,
    textAlign: "center",
  },

  modalMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },

  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },

  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
