import React, { useEffect, useState } from "react";
import { View, Text, TouchableOpacity, Animated, Easing, StyleProp, ViewStyle, StyleSheet } from "react-native";
import {
  MapView,
  Camera,
  PointAnnotation,
} from '@maplibre/maplibre-react-native';
import { locationPermissionHandler } from '../services/locationPermissionHandler';
import styles from "../styles/WorkerMapStyles";

// ✅ MapTiler MapLibre-compatible styles (fewer compatibility warnings)
// For production, set MAPTILER_API_KEY environment variable
const MAPTILER_API_KEY = "rmEy5CtIKMlSfVx4fckr"; 
// ✅ Use bright-v2 (MapLibre-compatible) instead of streets-v4
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v2/style.json?key=${MAPTILER_API_KEY}`;

type Props = {
  style?: StyleProp<ViewStyle>;
};

export default function WorkerMap({ style }: Props) {
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const pulseAnim = useState(() => new Animated.Value(0))[0];

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 1200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    let isActive = true;
    animation.start();

    const fetchLocation = async () => {
      setLocationLoading(true);
      setLocationError(null);
      try {
        const result = await locationPermissionHandler.getLocation();
        if (!isActive) return;

        if (!result.success || !result.location) {
          setLocationError('Location unavailable. Please allow location permission and try again.');
          return;
        }

        setLocation({
          latitude: result.location.latitude,
          longitude: result.location.longitude,
        });
        console.log(`📍 [WorkerMap] Location found: ${result.location.latitude}, ${result.location.longitude}`);
      } catch (error) {
        if (!isActive) return;
        setLocationError('Unable to retrieve current location. Please try again.');
        console.error('WorkerMap location error:', error);
      } finally {
        if (isActive) setLocationLoading(false);
      }
    };

    fetchLocation();

    return () => {
      isActive = false;
      animation.stop();
    };
  }, [pulseAnim]);

  // ✅ Pass MapLibre-compatible style URL directly to MapView
  // MapLibre handles style loading internally, eliminating compatibility warnings
  const renderMap = () => {
    if (location) {
      return (
        <MapView
          style={[styles.map, style]}
          mapStyle={MAP_STYLE_URL}
          logoEnabled={false}
          attributionEnabled={false}
        >
          <Camera
            centerCoordinate={[location.longitude, location.latitude]}
            zoomLevel={14}
            animationDuration={500}
          />

          <PointAnnotation
            id="worker-location"
            coordinate={[location.longitude, location.latitude]}
          >
            <View style={localStyles.markerWrapper}>
              <Animated.View
                style={[
                  localStyles.pulseRing,
                  {
                    transform: [
                      {
                        scale: pulseAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1, 2.5],
                        }),
                      },
                    ],
                    opacity: pulseAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.8, 0],
                    }),
                  },
                ]}
              />
              <View style={localStyles.markerDot} />
            </View>
          </PointAnnotation>
        </MapView>
      );
    }

    return (
      <View style={[localStyles.mapPlaceholder, style]}> 
        <Text style={localStyles.placeholderText}>
          {locationLoading ? 'Getting current location...' : locationError || 'Location unavailable.'}
        </Text>
        {!locationLoading && (
          <TouchableOpacity style={localStyles.retryButton} onPress={() => {
            setLocationLoading(true);
            setLocationError(null);
            locationPermissionHandler.getLocation().then((result) => {
              if (result.success && result.location) {
                setLocation({
                  latitude: result.location.latitude,
                  longitude: result.location.longitude,
                });
                setLocationError(null);
              } else {
                setLocationError('Location unavailable. Please allow permission and try again.');
              }
            }).catch((err) => {
              console.error('WorkerMap retry error:', err);
              setLocationError('Unable to retrieve location. Please try again.');
            }).finally(() => setLocationLoading(false));
          }}>
            <Text style={localStyles.retryButtonText}>Retry</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  };

  return (
    <View style={styles.mapContainer}>
      {renderMap()}
    </View>
  );
}

const localStyles = StyleSheet.create({
  markerWrapper: {
    width: 60,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(103, 58, 183, 0.3)',
  },
  markerDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#2196F3',
    borderWidth: 3,
    borderColor: '#fff',
  },
  mapPlaceholder: {
    width: '100%',
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: '#f3f4f6',
  },
  placeholderText: {
    color: '#4b5563',
    textAlign: 'center',
    marginBottom: 12,
    fontSize: 15,
  },
  retryButton: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    backgroundColor: '#17263A',
    borderRadius: 12,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
});
