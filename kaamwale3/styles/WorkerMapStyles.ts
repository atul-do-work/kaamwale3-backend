import { StyleSheet } from 'react-native';

export default StyleSheet.create({
  mapContainer: {
    width: '100%',
    height: 350, // Adjust depending on your layout
    position: 'relative',
  },
  map: {
    width: '100%',
    height: '100%',
  },
  centerMarkerWrapper: {
    position: 'absolute',
    top: '50%',
    left: '60%',
    transform: [{ translateX: -25 }, { translateY: -25 }],
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  pulseRing: {
    position: 'absolute',
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: 'rgba(103, 58, 183, 0.3)', // soft purple
  },
  centerDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#610e9c', // deep purple
  },
});
