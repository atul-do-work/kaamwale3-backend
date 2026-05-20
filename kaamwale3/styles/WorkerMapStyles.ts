import { StyleSheet } from 'react-native';

export default StyleSheet.create({
  mapContainer: {
    width: '100%',
    height: 300,
    position: 'relative',
    backgroundColor: '#f5f5f5',
    overflow: 'hidden',
    marginHorizontal: 12,
    borderRadius: 12,
  },
  map: {
    width: '100%',
    height: '100%',
  },
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
