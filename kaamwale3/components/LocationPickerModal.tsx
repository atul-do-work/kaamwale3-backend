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

// ✅ Ola Maps HTML embedded directly (fixes EAS build issues)
const OLA_MAPS_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ola Maps Picker</title>
    <link rel="stylesheet" href="https://maps.olakrutrim.com/maps-api/v2/styles/default-style.css" />
    <!-- Use official Ola Maps Web SDK (UMD) for v2+ (loaded below with onload handler) -->
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            overflow: hidden;
            height: 100vh;
            background: #f0f0f0;
        }

        #map {
            width: 100%;
            height: 100%;
        }

        .info-panel {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: #fff;
            padding: 20px;
            border-top: 1px solid #ddd;
            box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.1);
            z-index: 100;
        }

        .location-info {
            margin-bottom: 15px;
        }

        .location-info label {
            font-size: 12px;
            color: #999;
            display: block;
            margin-bottom: 5px;
            font-weight: 600;
        }

        .location-info p {
            font-size: 14px;
            color: #333;
            font-weight: 500;
            word-break: break-word;
        }

        .location-coords {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }

        .button-group {
            display: flex;
            gap: 10px;
        }

        button {
            flex: 1;
            padding: 14px;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.2s;
        }

        .confirm-btn {
            background: #1f3a5f;
            color: #fff;
        }

        .confirm-btn:active {
            background: #152844;
        }

        .cancel-btn {
            background: #f0f0f0;
            color: #333;
            border: 1px solid #ddd;
        }

        .cancel-btn:active {
            background: #e8e8e8;
        }

        .search-box {
            position: fixed;
            top: 10px;
            left: 10px;
            right: 10px;
            z-index: 50;
            background: #fff;
            border-radius: 10px;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
            padding: 0;
            overflow: hidden;
        }

        .search-input-wrapper {
            display: flex;
            align-items: center;
            padding: 10px 12px;
            gap: 8px;
        }

        .search-icon {
            font-size: 18px;
            color: #999;
        }

        .search-input {
            flex: 1;
            border: none;
            outline: none;
            font-size: 14px;
            padding: 8px 0;
            font-family: inherit;
        }

        .search-results {
            max-height: 250px;
            overflow-y: auto;
            border-top: 1px solid #eee;
        }

        .search-result-item {
            padding: 12px 12px;
            border-bottom: 1px solid #eee;
            font-size: 13px;
            color: #333;
            cursor: pointer;
            transition: background 0.15s;
        }

        .search-result-item:hover {
            background: #f5f5f5;
        }

        .search-result-item:last-child {
            border-bottom: none;
        }

        .clear-search {
            font-size: 18px;
            color: #999;
            background: none;
            border: none;
            cursor: pointer;
            padding: 0;
            width: 24px;
            height: 24px;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        .clear-search:active {
            color: #666;
        }

        .marker {
            width: 50px;
            height: 60px;
            background: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 60" width="50" height="60"><path d="M25 0C11.2 0 0 11.2 0 25c0 13.8 25 35 25 35s25-21.2 25-35C50 11.2 38.8 0 25 0z" fill="%23d32f2f"/><circle cx="25" cy="24" r="8" fill="%23fff"/></svg>') no-repeat center;
            background-size: contain;
        }

        .loading {
            text-align: center;
            padding: 12px;
            color: #999;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div id="map"><\/div>

    <div class="search-box" id="searchBox">
        <div class="search-input-wrapper">
            <span class="search-icon">🔍<\/span>
            <input 
                type="text" 
                id="searchInput" 
                class="search-input" 
                placeholder="Search place or address..."
            >
                <button class="clear-search" id="clearBtn" style="display: none;">✕<\/button>
                <button id="useCurrentBtn" class="clear-search" title="Use my location" onclick="requestCurrentLocation()">📍<\/button>
        <\/div>
        <div class="search-results" id="searchResults"><\/div>
    <\/div>

    <div class="info-panel">
        <div class="location-info">
            <label>📍 Selected Location<\/label>
            <p id="placeName">-<\/p>
            <div class="location-coords" id="coords">Lat: -, Lon: -<\/div>
        <\/div>
        <div class="button-group">
            <button class="confirm-btn" onclick="confirmLocation()">✓ Confirm Location<\/button>
            <button class="cancel-btn" onclick="cancelSelection()">Cancel<\/button>
        <\/div>
    <\/div>

    <!-- Load official UMD and handle onload/onerror -->
    <script src="https://www.unpkg.com/olamaps-web-sdk@latest/dist/olamaps-web-sdk.umd.js" charset="UTF-8" onload="onOlaMapsLoaded()" onerror="onOlaMapsError()"><\/script>
    <script>
        let map = null;
        let marker = null;
        let selectedLat = 28.6139;
        let selectedLon = 77.2090;
        let selectedPlaceName = '';
        let searchTimeout = null;

        function onOlaMapsLoaded() {
            console.log('OlaMaps script loaded');
            const scriptUrl = (document.currentScript && document.currentScript.src) || '';
            // Post diagnostics to React Native
            window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'map_diagnostics',
                olaMapsPresent: !!window.OlaMaps,
                apiKeyPresent: !!window.OLA_API_KEY,
                apiKeyPreview: (window.OLA_API_KEY || '').toString().slice(0, 6) + '...')
            );
            if (window.OlaMaps) {
                // Delay slightly to ensure DOM is ready
                setTimeout(() => {
                    try { initMap(); } catch (e) { console.error('initMap after load failed', e); window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'map_error', error: e.message || 'initMap error' })); }
                }, 50);
            } else {
                console.error('OlaMaps global not found after script load');
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'map_error', error: 'OlaMaps not available' }));
            }
        }

        function onOlaMapsError() {
            console.error('Failed to load OlaMaps script');
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'map_error', error: 'Failed to load OlaMaps script' }));
            alert('Failed to load map library. Please check network and API configuration.');
        }

        async function initMap() {
            const mapContainer = document.getElementById('map');

            try {
                if (!window.OlaMaps) throw new Error('OlaMaps SDK not found');

                // Initialize OlaMaps instance (v2+ Web SDK)
                const olaMaps = new OlaMaps({ apiKey: window.OLA_API_KEY });

                // Build style URL using vector tiles v1 (recommended by docs)
                const styleUrl = 'https://api.olamaps.io/tiles/vector/v1/styles/default-light-standard/style.json?api_key=' + window.OLA_API_KEY;

                // Call init() to get the map instance
                const myMap = await olaMaps.init({
                    style: styleUrl,
                    container: 'map',
                    center: [selectedLon, selectedLat],
                    zoom: 15,
                });

                map = myMap;

                // Attach click handler if supported
                try {
                    if (map && typeof map.on === 'function') {
                        map.on('click', (event) => {
                            const lng = event.lng || event.lngLat?.lng || (event.lngLat && event.lngLat[0]);
                            const lat = event.lat || event.lngLat?.lat || (event.lngLat && event.lngLat[1]);
                            placeMarker(lat, lng);
                            reverseGeocode(lat, lng);
                        });
                    }
                } catch (e) {
                    console.warn('Click handler attach failed:', e);
                }

                // Try to add marker using SDK's Marker if available, otherwise use fallback
                try {
                    addMarker(selectedLat, selectedLon);
                } catch (e) {
                    console.warn('addMarker failed:', e);
                }

                updateLocationInfo();

                // Send success message to React Native
                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'map_loaded' }));
            } catch (err) {
                console.error('Map init error:', err);
                console.error('OLA_API_KEY exists:', !!window.OLA_API_KEY);
                console.error('OlaMaps exists:', !!window.OlaMaps);
                alert('Failed to initialize map. Please check API key and network.');
                window.ReactNativeWebView.postMessage(JSON.stringify({
                    type: 'map_error',
                    error: err.message || 'Unknown error'
                }));
            }
        }

        function placeMarker(lat, lon) {
            selectedLat = lat;
            selectedLon = lon;
            
            if (marker) {
                marker.remove();
            }
            
            addMarker(lat, lon);
            
            if (map) {
                map.flyTo({
                    center: [lon, lat],
                    zoom: 15,
                });
            }
        }

        function addMarker(lat, lon) {
            if (!map) return;
            const el = document.createElement('div');
            el.className = 'marker';

            try {
                if (window.OlaMaps && typeof window.OlaMaps.Marker === 'function') {
                    // Recommended approach per Ola Maps v2 docs
                    marker = new OlaMaps.Marker({ element: el, draggable: true })
                        .setLngLat([lon, lat])
                        .addTo(map);
                } else if (map && map.addLayer) {
                    // Fallback: try SDK-agnostic approach (may not support interactivity)
                    marker = { _el: el };
                    el.style.position = 'absolute';
                    map.getContainer && map.getContainer().appendChild && map.getContainer().appendChild(el);
                } else {
                    console.warn('No Marker API available on OlaMaps instance');
                }

                if (marker && typeof marker.on === 'function') {
                    marker.on('dragend', () => {
                        const lngLat = marker.getLngLat();
                        // normalize return value
                        const latVal = (lngLat && (lngLat.lat || lngLat[1])) || lat;
                        const lonVal = (lngLat && (lngLat.lng || lngLat[0])) || lon;
                        selectedLat = latVal;
                        selectedLon = lonVal;
                        reverseGeocode(selectedLat, selectedLon);
                    });
                }
            } catch (e) {
                console.error('Error creating marker:', e);
            }
        }

        function reverseGeocode(lat, lon) {
            const backendUrl = window.BACKEND_URL || 'http://localhost:3000';
            fetch(backendUrl + '/ola/reverse-geocode?lat=' + lat + '&lon=' + lon)
                .then(r => r.json())
                .then(data => {
                    if (data.results && data.results.length > 0) {
                        selectedPlaceName = data.results[0].formatted_address || '';
                    } else {
                        selectedPlaceName = lat.toFixed(4) + ', ' + lon.toFixed(4);
                    }
                    updateLocationInfo();
                })
                .catch(err => {
                    console.error('Reverse geocode error:', err);
                    selectedPlaceName = lat.toFixed(4) + ', ' + lon.toFixed(4);
                    updateLocationInfo();
                });
        }

        function searchPlaces(query) {
            if (!query.trim()) {
                document.getElementById('searchResults').innerHTML = '';
                return;
            }

            document.getElementById('searchResults').innerHTML = '<div class="loading">Searching...<\/div>';

            const backendUrl = window.BACKEND_URL || 'http://localhost:3000';
            fetch(backendUrl + '/ola/places?input=' + encodeURIComponent(query))
                .then(r => r.json())
                .then(data => {
                    displaySearchResults(data.predictions || []);
                })
                .catch(err => {
                    console.error('Search error:', err);
                    document.getElementById('searchResults').innerHTML = '<div class="loading">Search failed<\/div>';
                });
        }

        function displaySearchResults(predictions) {
            const resultsDiv = document.getElementById('searchResults');
            
            if (predictions.length === 0) {
                resultsDiv.innerHTML = '<div class="loading">No results found<\/div>';
                return;
            }

            resultsDiv.innerHTML = predictions.map((place, idx) => 
                '<div class="search-result-item" onclick="selectSearchResult(' + idx + ')">' +
                (place.display_address || 'Unknown') +
                '<\/div>'
            ).join('');

            window.currentPredictions = predictions;
        }

        function selectSearchResult(idx) {
            const place = window.currentPredictions[idx];
            if (place.geometry && place.geometry.lat && place.geometry.lng) {
                placeMarker(place.geometry.lat, place.geometry.lng);
                selectedPlaceName = place.display_address || '';
                updateLocationInfo();
                
                document.getElementById('searchInput').value = '';
                document.getElementById('searchResults').innerHTML = '';
                document.getElementById('clearBtn').style.display = 'none';
            }
        }

        function updateLocationInfo() {
            document.getElementById('placeName').textContent = selectedPlaceName || '-';
            document.getElementById('coords').textContent = 
                'Lat: ' + selectedLat.toFixed(4) + ' | Lon: ' + selectedLon.toFixed(4);
        }

        function confirmLocation() {
            if (!selectedPlaceName) {
                alert('Please select a location');
                return;
            }

            window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'location_selected',
                lat: selectedLat,
                lon: selectedLon,
                placeName: selectedPlaceName,
            }));
        }

        function cancelSelection() {
            window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'cancelled',
            }));
        }

        // Request current location from React Native (native side will call device geolocation)
        function requestCurrentLocation() {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'request_current_location' }));
        }

        document.getElementById('searchInput').addEventListener('input', (e) => {
            const query = e.target.value;
            
            if (query.trim()) {
                document.getElementById('clearBtn').style.display = 'flex';
            } else {
                document.getElementById('clearBtn').style.display = 'none';
            }

            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => {
                searchPlaces(query);
            }, 300);
        });

        document.getElementById('clearBtn').addEventListener('click', () => {
            document.getElementById('searchInput').value = '';
            document.getElementById('searchResults').innerHTML = '';
            document.getElementById('clearBtn').style.display = 'none';
        });

        // Don't auto-init on DOMContentLoaded; init after script successfully loads
        // Keep a fallback in case the script was cached and loaded earlier
        window.addEventListener('DOMContentLoaded', () => {
            if (window.OlaMaps) {
                try { initMap(); } catch (e) { console.error('initMap on DOMContentLoaded failed', e); }
            }
        });
    <\/script>
<\/body>
<\/html>`;

export default function LocationPickerModal({
  visible,
  onConfirm,
  onClose,
  initialLat = 28.6139,
  initialLon = 77.2090,
}: LocationPickerModalProps) {
  const webViewRef = useRef<WebView>(null);
  const [loading, setLoading] = useState(true);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // ✅ Fetch API key from backend when modal opens
  useEffect(() => {
    if (!visible) return;

    const fetchApiKey = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/ola/api-key`);
        const data = await response.json();
        
        if (data.success && data.apiKey) {
          setApiKey(data.apiKey);
          setApiError(null);
          console.log('✅ API key fetched from backend');
        } else {
          setApiError('Failed to fetch API key from server');
          console.error('❌ API key fetch failed:', data.message);
        }
      } catch (err) {
        setApiError('Could not connect to server for API key');
        console.error('❌ API key fetch error:', err);
      }
    };

    fetchApiKey();
  }, [visible]);

  // Handle messages from WebView
    const handleWebViewMessage = async (event: any) => {
        try {
            const data = JSON.parse(event.nativeEvent.data);

            if (data.type === 'location_selected') {
                onConfirm({
                    lat: data.lat,
                    lon: data.lon,
                    placeName: data.placeName,
                    isManual: true,
                });
                onClose();
            } else if (data.type === 'cancelled') {
                onClose();
            } else if (data.type === 'map_error') {
                // ✅ Enhanced error reporting
                console.error('Map initialization failed:', data.error);
                Alert.alert(
                    'Map Error',
                    `Failed to load map: ${data.error}\n\nPlease verify your API key configuration.`,
                    [{ text: 'Retry', onPress: () => {/* Will retry on next modal open */} }, { text: 'Cancel', onPress: onClose }]
                );
            } else if (data.type === 'map_loaded') {
                // ✅ Map loaded successfully
                console.log('Map initialized successfully');
                setLoading(false);
            } else if (data.type === 'request_current_location') {
                // React Native should obtain device location and send it back into WebView
                try {
                    const { status } = await Location.requestForegroundPermissionsAsync();
                    if (status !== 'granted') {
                        Alert.alert('Permission Denied', 'Location permission required');
                        return;
                    }
                    const loc = await Location.getCurrentPositionAsync({});
                    const lat = loc.coords.latitude;
                    const lon = loc.coords.longitude;

                    // Inject JS to move marker and perform reverse geocode inside WebView
                    const js = `placeMarker(${lat}, ${lon}); reverseGeocode(${lat}, ${lon}); true;`;
                    webViewRef.current?.injectJavaScript(js);
                } catch (err) {
                    console.error('Failed to get current location:', err);
                    Alert.alert('Error', 'Failed to get current location');
                }
            }
        } catch (err) {
            console.error('WebView message parse error:', err);
        }
    };

  // Inject initial data into WebView
  const injectedJavaScript = `
    window.OLA_API_KEY = '${apiKey || 'missing'}';
    window.BACKEND_URL = '${SERVER_URL}';
    console.log('Injected OLA_API_KEY');
    true;
  `;

  // Show error if API key couldn't be fetched
  if (visible && apiError) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#f3f3f3' }}>
          <View style={{ backgroundColor: '#1f3a5f', paddingTop: 40, paddingHorizontal: 15, paddingBottom: 15 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff' }}>📍 Select Location</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 20 }}>
            <Text style={{ fontSize: 16, fontWeight: '600', color: '#d32f2f', textAlign: 'center', marginBottom: 16 }}>
              ⚠️ Map Configuration Error
            </Text>
            <Text style={{ fontSize: 14, color: '#666', textAlign: 'center', lineHeight: 20 }}>
              {apiError}
            </Text>
            <TouchableOpacity 
              style={{ marginTop: 24, paddingHorizontal: 32, paddingVertical: 12, backgroundColor: '#1f3a5f', borderRadius: 8 }}
              onPress={onClose}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  // ✅ Don't render the map if API key is not loaded
  if (visible && !apiKey) {
    return (
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={{ flex: 1, backgroundColor: '#f3f3f3' }}>
          <View style={{ backgroundColor: '#1f3a5f', paddingTop: 40, paddingHorizontal: 15, paddingBottom: 15 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff' }}>📍 Select Location</Text>
              <TouchableOpacity onPress={onClose}>
                <Ionicons name="close" size={28} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#1f3a5f" />
            <Text style={{ marginTop: 12, color: '#999', fontSize: 14 }}>Initializing map...</Text>
          </View>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#f3f3f3' }}>
        {/* Header */}
        <View style={{ backgroundColor: '#1f3a5f', paddingTop: 40, paddingHorizontal: 15, paddingBottom: 15 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: '#fff' }}>📍 Select Location</Text>
            <TouchableOpacity onPress={onClose}>
              <Ionicons name="close" size={28} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        {/* WebView with Ola Maps */}
        {loading && (
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <ActivityIndicator size="large" color="#1f3a5f" />
            <Text style={{ marginTop: 12, color: '#999', fontSize: 14 }}>Loading map...</Text>
          </View>
        )}

                <WebView
          ref={webViewRef}
          source={{ html: OLA_MAPS_HTML }}
          style={{ flex: 1, display: loading ? 'none' : 'flex' }}
          onMessage={handleWebViewMessage}
                    injectedJavaScriptBeforeContentLoaded={injectedJavaScript}
          javaScriptEnabled
          domStorageEnabled
          startInLoadingState
          onLoadEnd={() => {
              // ✅ Don't automatically set loading to false - wait for map_loaded message
              console.log('WebView HTML loaded, waiting for map initialization...');
          }}
          onError={(err) => {
            console.error('WebView error:', err.nativeEvent);
            Alert.alert('Error', 'Failed to load map: ' + (err.nativeEvent.description || 'Unknown error'));
          }}
          scrollEnabled={false}
          showsVerticalScrollIndicator={false}
        />
      </View>
    </Modal>
  );
}
