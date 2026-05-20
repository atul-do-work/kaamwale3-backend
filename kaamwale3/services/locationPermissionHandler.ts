import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface LocationResult {
  success: boolean;
  location?: {
    latitude: number;
    longitude: number;
  };
  error?: string;
}

class LocationPermissionHandler {
  private permissionCache: { granted: boolean; timestamp: number } | null = null;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private retryCount = 0;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAYS = [1000, 2000, 5000]; // Progressive backoff

  async getLocation(): Promise<LocationResult> {
    try {
      // ✅ Check cached permission
      const cached = await this.getCachedPermission();
      if (cached && !cached.granted) {
        return { success: false, error: 'Location permission denied' };
      }

      // ✅ Request permission if not cached or expired
      if (!cached || (Date.now() - cached.timestamp) > this.CACHE_TTL) {
        const permissionResult = await this.requestPermission();
        if (!permissionResult.granted) {
          return { success: false, error: 'Location permission denied' };
        }
        // Cache the permission
        await this.cachePermission(true);
      }

      console.log('📍 Getting current location...');

      // ✅ Get location with timeout and retries
      const locationResult = await this.getLocationWithRetry();

      if (locationResult) {
        console.log('✅ Location obtained successfully');
        return {
          success: true,
          location: {
            latitude: locationResult.coords.latitude,
            longitude: locationResult.coords.longitude,
          },
        };
      } else {
        throw new Error('Failed to get location');
      }

    } catch (error) {
      console.error('❌ Location error:', error);

      // ✅ Reset retry count on persistent failures
      this.retryCount = 0;

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown location error',
      };
    }
  }

  private async requestPermission(): Promise<Location.LocationPermissionResponse> {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();

      if (status !== 'granted') {
        console.warn('⚠️ Location permission not granted:', status);
        await this.cachePermission(false);
        throw new Error('Location permission denied');
      }

      console.log('✅ Location permission granted');
      return {
        status: Location.PermissionStatus.GRANTED,
        granted: true,
        canAskAgain: true,
        expires: 'never' as any
      };
    } catch (error) {
      console.error('❌ Permission request error:', error);
      throw error;
    }
  }

  private async getLocationWithRetry(): Promise<Location.LocationObject | null> {
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        this.retryCount = 0; // Reset on success
        return location;
      } catch (error) {
        console.warn(`📍 Location attempt ${attempt + 1} failed:`, error);

        if (attempt < this.MAX_RETRIES) {
          // Wait before retry with progressive backoff
          const delay = this.RETRY_DELAYS[attempt] || 5000;
          console.log(`⏳ Retrying location in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return null;
  }

  private async getCachedPermission(): Promise<{ granted: boolean; timestamp: number } | null> {
    if (this.permissionCache && ((Date.now() - this.permissionCache.timestamp) < this.CACHE_TTL)) {
      return this.permissionCache;
    }

    try {
      const cached = await AsyncStorage.getItem('locationPermission');
      if (cached) {
        const parsed = JSON.parse(cached);
        // Check if cache is still valid
        if ((Date.now() - parsed.timestamp) < this.CACHE_TTL) {
          this.permissionCache = parsed;
          return parsed;
        }
      }
    } catch (error) {
      console.error('❌ Error reading location permission cache:', error);
    }
    return null;
  }

  private async cachePermission(granted: boolean): Promise<void> {
    try {
      const cacheData = {
        granted,
        timestamp: Date.now(),
      };
      this.permissionCache = cacheData;
      await AsyncStorage.setItem('locationPermission', JSON.stringify(cacheData));
    } catch (error) {
      console.error('❌ Error caching location permission:', error);
    }
  }

  async clearPermissionCache(): Promise<void> {
    await AsyncStorage.removeItem('locationPermission');
    this.permissionCache = null;
  }

  async hasPermission(): Promise<boolean> {
    const cached = await this.getCachedPermission();
    if (cached) {
      return cached.granted;
    }

    try {
      const { status } = await Location.getForegroundPermissionsAsync();
      return status === 'granted';
    } catch {
      return false;
    }
  }
}

export const locationPermissionHandler = new LocationPermissionHandler();