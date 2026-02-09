import React, { useState, useRef, useEffect } from 'react';
import { View, Modal, TouchableOpacity, Text, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import { SERVER_URL } from '../utils/config';

interface LocationResult {
  lat: number;
  lon: number;
  placeName: string;
  isManual: boolean;
}

interface LocationPickerModalProps {
  visible: boolean;
  onConfirm: (location: LocationResult) => void;
  onClose: () => void;
  initialLat?: number;
  initialLon?: number;
}

// ✅ Ola Maps HTML embedded directly (v1 SDK - stable for WebView)
const OLA_MAPS_HTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ola Maps Picker</title>
    <style>
        html, body, #map {
            height: 100%;
            margin: 0;
            padding: 0;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
    </style>
</head>
<body>
    <div id="map"></div>
    <script>
        function send(type, p) {
            window.ReactNativeWebView.postMessage(JSON.stringify(Object.assign({type}, p || {})));
        }

        function loadSdk() {
            if (!window.OLA_API_KEY || window.OLA_API_KEY === 'missing') {
                send('map_error', {error: 'API key missing'});
                return;
            }
            const s = document.createElement('script');
            s.src = 'https://maps.olakrutrim.com/v1/sdk.js?key=' + window.OLA_API_KEY;
            s.onload = initMap;
            s.onerror = () => {
                send('map_error', {error: 'Failed to load Ola Maps v1 SDK'});
            };
            document.head.appendChild(s);
        }

        let map, marker;
        let selectedLat = 28.6139;
        let selectedLon = 77.2090;

        function initMap() {
            if (!window.OlaMaps) {
                send('map_error', {error: 'OlaMaps not available'});
                return;
            }
            try {
                map = new OlaMaps.Map(document.getElementById('map'), {
                    center: {lat: selectedLat, lng: selectedLon},
                    zoom: 15
                });
                marker = new OlaMaps.Marker({
                    position: {lat: selectedLat, lng: selectedLon},
                    map: map,
                    draggable: true
                });
                if (map.addListener) {
                    map.addListener('click', (e) => {
                        if (marker && marker.setPosition) {
                            marker.setPosition(e.latLng);
                        }
                        reverseGeocode(e.latLng.lat, e.latLng.lng);
                        send('location_selected', {
                            lat: e.latLng.lat,
                            lon: e.latLng.lng,
                            placeName: 'Selected location'
                        });
                    });
                }
                if (marker && marker.addListener) {
                    marker.addListener('dragend', () => {
                        const pos = marker.getPosition();
                        if (pos) {
                            reverseGeocode(pos.lat, pos.lng);
                        }
                    });
                }
                send('map_loaded');
            } catch (err) {
                send('map_error', {error: err.message || 'Map init failed'});
            }
        }

        function reverseGeocode(lat, lon) {
            const backendUrl = window.BACKEND_URL || 'http://localhost:3000';
            fetch(backendUrl + '/ola/reverse-geocode?lat=' + lat + '&lon=' + lon)
                .then(r => r.json())
                .then(data => {
                    if (data.results && data.results[0]) {
                        send('location_updated', {
                            lat: lat,
                            lon: lon,
                            placeName: data.results[0].formatted_address || ''
                        });
                    }
                })
                .catch(e => console.error('Reverse geocode error:', e));
        }

        window.addEventListener('DOMContentLoaded', loadSdk);
    </script>
</body>
</html>`;

export default function LocationPickerModal({
  visible,
  onConfirm,
  onClose,
  initialLat = 28.6139,
  initialLon = 77.2090,
}: LocationPickerModalProps) {
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const webViewRef = useRef<WebView>(null);

  // Fetch API key from backend
  useEffect(() => {
    const fetchApiKey = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/ola/api-key`);
        const data = await response.json();
        if (data.success && data.apiKey) {
          setApiKey(data.apiKey);
          setApiKeyError(null);
        } else {
          setApiKeyError(data.message || 'Failed to get API key');
        }
      } catch (err) {
        setApiKeyError((err as Error).message || 'Network error');
      }
    };
    fetchApiKey();
  }, []);

  // Handle messages from WebView
  const handleWebViewMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === 'map_loaded') {
        setLoading(false);
      } else if (data.type === 'map_error') {
        Alert.alert('Map Error', data.error || 'Unknown map error');
        setLoading(false);
      } else if (data.type === 'location_selected') {
        onConfirm({
          lat: data.lat,
          lon: data.lon,
          placeName: data.placeName,
          isManual: true,
        });
        onClose();
      } else if (data.type === 'cancelled') {
        onClose();
      }
    } catch (err) {
      console.error('WebView message parse error:', err);
    }
  };

  // Inject API key and backend URL into WebView
  const injectedJavaScript = `
    window.OLA_API_KEY = '${apiKey || "missing"}';
    window.BACKEND_URL = '${SERVER_URL}';
    true;
  `;

  if (apiKeyError) {
    return (
      <Modal visible={visible} transparent={true} animationType="slide">
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View style={{ backgroundColor: '#fff', padding: 20, borderRadius: 10, width: '80%' }}>
            <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 10 }}>Error</Text>
            <Text style={{ fontSize: 14, color: '#666', marginBottom: 20 }}>{apiKeyError}</Text>
            <TouchableOpacity
              onPress={onClose}
              style={{ backgroundColor: '#1f3a5f', padding: 12, borderRadius: 8, alignItems: 'center' }}
            >
              <Text style={{ color: '#fff', fontWeight: 'bold' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} transparent={true} animationType="slide">
      <View style={{ flex: 1, backgroundColor: '#fff' }}>
        {/* Header with close button */}
        <View
          style={{
            paddingTop: 12,
            paddingBottom: 12,
            paddingHorizontal: 16,
            backgroundColor: '#fff',
            borderBottomWidth: 1,
            borderBottomColor: '#eee',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: '600' }}>Select Location</Text>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="close" size={24} color="#333" />
          </TouchableOpacity>
        </View>

        {/* Loading spinner overlay */}
        {loading && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
              backgroundColor: 'rgba(255,255,255,0.9)',
              zIndex: 100,
            }}
          >
            <ActivityIndicator size="large" color="#1f3a5f" />
            <Text style={{ marginTop: 12, fontSize: 14, color: '#666' }}>Loading map...</Text>
          </View>
        )}

        {/* WebView with embedded Ola Maps v1 SDK */}
        {apiKey && (
          <WebView
            ref={webViewRef}
            source={{ html: OLA_MAPS_HTML }}
            style={{ flex: 1 }}
            onMessage={handleWebViewMessage}
            injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            startInLoadingState={true}
            onLoadStart={() => {
              console.log('WebView HTML loaded, waiting for map initialization...');
            }}
            onError={(err) => {
              console.error('WebView error:', err.nativeEvent);
              Alert.alert('Error', 'Failed to load map: ' + (err.nativeEvent.description || 'Unknown error'));
            }}
            scrollEnabled={false}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>
    </Modal>
  );
}
