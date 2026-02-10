import React, { useEffect, useState, useRef } from "react";
import { View, Animated, Easing, StyleProp, ViewStyle } from "react-native";
import {
  MapView,
  Camera,
  PointAnnotation,
} from '@maplibre/maplibre-react-native';
import * as Location from "expo-location";
import styles from "../styles/WorkerMapStyles";

// MapTiler style - using free/demo key
// For production, set MAPTILER_API_KEY environment variable
const MAPTILER_API_KEY = "rmEy5CtIKMlSfVx4fckr"; // Free demo key
const MAP_STYLE_URL = `https://api.maptiler.com/maps/streets-v4/style.json?key=${MAPTILER_API_KEY}`;

type Props = {
  style?: StyleProp<ViewStyle>;
};

export default function WorkerMap({ style }: Props) {
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  // store parsed style object (or URL string) directly to avoid JSON parse/string edge cases
  const [mapStyle, setMapStyle] = useState<any>(null);
  const fallbackTimerRef = useRef<any>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef<boolean>(true);
  const pulseAnim = useRef(new Animated.Value(0)).current;

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
        console.log("Permission denied");
        return;
      }

      let currentLocation = await Location.getCurrentPositionAsync({});
      setLocation({
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
      });
    })();

    // Fetch MapTiler style directly (no backend proxy needed)
    (async () => {
      try {
        console.log(`🗺️  [WorkerMap] Fetching MapTiler style from: ${MAP_STYLE_URL}`);
        abortControllerRef.current = new AbortController();
        const resp = await fetch(MAP_STYLE_URL, { signal: abortControllerRef.current.signal });
        if (!resp.ok) {
          console.error(`❌ [WorkerMap] Failed to fetch MapTiler style: HTTP ${resp.status}`);
          return;
        }

        const style = await resp.json();
        console.log(`📡 [WorkerMap] Received MapTiler style successfully`);

        // store the parsed style object directly
        if (mountedRef.current) {
          setMapStyle(style);
          // clear fallback timer if style arrives before fallback
          if (fallbackTimerRef.current) {
            clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
          }
        }
      } catch (e: any) {
        if (e.name === 'AbortError') {
          console.log('❌ [WorkerMap] Style fetch aborted');
        } else {
          console.error('❌ [WorkerMap] Error fetching MapTiler style:', e);
        }
      }
    })();
    
    // Set a fallback style in case MapTiler fails (uses simple OSM raster tiles)
    fallbackTimerRef.current = setTimeout(() => {
      // only set fallback if no style is set yet
      if (!mapStyle) {
        console.log('⏱️  [WorkerMap] MapTiler style not loaded after 5s, using OSM fallback');
        const fallbackStyle = {
          version: 8,
          name: "OpenStreetMap Fallback",
          sources: {
            osm: {
              type: "raster",
              tiles: [
                "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
              ],
              tileSize: 256
            }
          },
          layers: [
            {
              id: "osm",
              type: "raster",
              source: "osm"
            }
          ]
        };
        if (mountedRef.current) setMapStyle(fallbackStyle);
        console.log('✅ [WorkerMap] Using OSM raster fallback style');
      }
    }, 5000);

    return () => {
      // cleanup: abort fetch and clear fallback timer
      mountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (fallbackTimerRef.current) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, []);

  // mapStyle is stored directly as an object (or URL string) to avoid parse/string edge cases
  const mapStyleToUse = mapStyle || undefined;

  return (
    <View style={styles.mapContainer}>
      {location && (
        <MapView
          style={[styles.map, style]}
          mapStyle={mapStyleToUse}
          logoEnabled={false}
          attributionEnabled={false}
        >
          <Camera
            centerCoordinate={[location.longitude, location.latitude]}
            zoomLevel={15}
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
