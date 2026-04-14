import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

const DEVICE_ID_STORAGE_KEY = 'DEVICE_ID';

export async function getOrGenerateDeviceId(): Promise<string> {
  try {
    const existingId = await AsyncStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (existingId) {
      return existingId;
    }

    const newId = uuidv4();
    await AsyncStorage.setItem(DEVICE_ID_STORAGE_KEY, newId);
    return newId;
  } catch (error) {
    console.warn('Failed to generate device ID, using fallback UUID:', error);
    return uuidv4();
  }
}

export function getAppVersion(): string {
  const manifest = Constants.manifest as any;
  const version =
    (Constants.expoConfig?.version as string) ||
    manifest?.version ||
    manifest?.releaseId ||
    Constants.nativeAppVersion ||
    '1.0.0';

  return version;
}

export function generateTermsHashFallback(termsText: string): string {
  let hash = 5381;
  for (let i = 0; i < termsText.length; i += 1) {
    hash = (hash * 33) ^ termsText.charCodeAt(i);
  }
  return String(hash >>> 0);
}
