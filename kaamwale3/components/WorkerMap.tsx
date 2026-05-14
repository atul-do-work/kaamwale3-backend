import React, { useEffect, useState, useRef } from "react";
import { View, Animated, Easing, StyleProp, ViewStyle } from "react-native";
import {
  MapView,
  Camera,
  PointAnnotation,
} from '@maplibre/maplibre-react-native';
import * as Location from "expo-location";
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
  const pulseAnim = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    // Start pulse animation
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.out(Easing.ease),
          useNativeDriver: false,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 1200,
          easing: Easing.in(Easing.ease),
          useNativeDriver: false,
        }),
      ])
    ).start();

    // Get current location
    (async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        console.log("⚠️ Location permission not granted");
        return;
      }

      let currentLocation = await Location.getCurrentPositionAsync({});
      if (mountedRef.current) {
        setLocation({
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
        });
        console.log(`📍 [WorkerMap] Location found: ${currentLocation.coords.latitude}, ${currentLocation.coords.longitude}`);
      }
    })();

    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ✅ Pass MapLibre-compatible style URL directly to MapView
  // MapLibre handles style loading internally, eliminating compatibility warnings
  return (
    <View style={styles.mapContainer}>
      {location && (
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
            <View
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: "#2196F3",
                justifyContent: "center",
                alignItems: "center",
                borderWidth: 3,
                borderColor: "#fff",
              }}
            />
          </PointAnnotation>
        </MapView>
      )}

      {/* 🔭 Center Pulse Animation */}
      <View style={styles.centerMarkerWrapper}>
        <Animated.View
          style={[
            styles.pulseRing,
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
      </View>
    </View>
  );
}
