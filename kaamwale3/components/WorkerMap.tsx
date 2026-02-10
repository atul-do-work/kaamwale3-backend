import React, { useEffect, useState, useRef } from "react";
import { View, Animated, Easing, StyleProp, ViewStyle } from "react-native";
import {
  MapView,
  Camera,
  PointAnnotation,
} from '@maplibre/maplibre-react-native';
import * as Location from "expo-location";
import styles from "../styles/WorkerMapStyles";
import { API_BASE } from "../utils/config";

// NOTE:
// The original MapTiler style is commented out below. We're replacing it
// with an Ola Maps Vector Tiles style fetched using the backend endpoint
// `/ola/api-key`. MapLibre can consume a style.json URL from Ola Maps.

// const MAP_STYLE =
//   "https://api.maptiler.com/maps/streets-v4/style.json?key=rmEy5CtIKMlSfVx4fckr";

type Props = {
  style?: StyleProp<ViewStyle>;
};

export default function WorkerMap({ style }: Props) {
  const [location, setLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [olaStyleUrl, setOlaStyleUrl] = useState<string | null>(null);
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

    // Fetch Ola Maps API key from backend and build style URL
    (async () => {
      try {
        console.log(`🗺️  [WorkerMap] Fetching Ola API key from: ${API_BASE}/ola/api-key`);
        
        const resp = await fetch(`${API_BASE}/ola/api-key`);
        if (!resp.ok) {
          console.error(`❌ [WorkerMap] Failed to fetch Ola API key from backend: HTTP ${resp.status}`);
          console.log('📍 [WorkerMap] Falling back to fallback style');
          return;
        }
        
        const data = await resp.json();
        console.log(`📡 [WorkerMap] Backend response:`, data);
        
        if (data && data.apiKey) {
          const apiKey = data.apiKey;
          console.log(`🔑 [WorkerMap] Got API key: ${apiKey.substring(0, 10)}...`);
          
          const styleUrl = `https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json?api_key=${apiKey}`;
          console.log(`🎨 [WorkerMap] Built style URL:`, styleUrl);
          
          setOlaStyleUrl(styleUrl);
          console.log('✅ [WorkerMap] Using Ola Maps style URL');
        } else {
          console.warn('❌ [WorkerMap] Ola API key not present in response', data);
          console.log('📍 [WorkerMap] Falling back to fallback style');
        }
      } catch (e) {
        console.error('❌ [WorkerMap] Error fetching Ola API key:', e);
        console.log('📍 [WorkerMap] Falling back to fallback style');
      }
    })();
    
    // Set a fallback style in case Ola fails (uses a simple OSM-based style)
    setTimeout(() => {
      if (!olaStyleUrl) {
        console.log('⏱️  [WorkerMap] Ola style not loaded after 5s, using cached fallback');
        // Use a simple MapLibre style that doesn't require external APIs
        const fallbackStyle = {
          version: 8,
          name: "Fallback Style",
          sources: {
            "raster-tiles": {
              type: "raster",
              url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
              tileSize: 256
            }
          },
          layers: [
            {
              id: "raster-layer",
              type: "raster",
              source: "raster-tiles",
              minzoom: 0,
              maxzoom: 18
            }
          ]
        };
        setOlaStyleUrl(JSON.stringify(fallbackStyle));
        console.log('✅ [WorkerMap] Using fallback OpenStreetMap raster style');
      }
    }, 5000);
  }, []);

  // Use Ola style if available; otherwise fallback will load after 5s
  // olaStyleUrl can be either a URL string or a JSON style object string
  const mapStyleToUse = olaStyleUrl ? (
    // If it's a URL (starts with http), use as-is; if it's JSON, parse it
    olaStyleUrl.startsWith('{') 
      ? JSON.parse(olaStyleUrl) 
      : olaStyleUrl
  ) : undefined;

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
