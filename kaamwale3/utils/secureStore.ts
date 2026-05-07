import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

export const secureSet = async (key: string, value: string) => {
  try {
    await SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.ALWAYS_THIS_DEVICE_ONLY });
  } catch (e) {
    console.warn('SecureStore.setItemAsync failed', e);
    throw e;
  }
};

export const secureGet = async (key: string) => {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (e) {
    console.warn('SecureStore.getItemAsync failed', e);
    return null;
  }
};

export const secureDelete = async (key: string) => {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (e) {
    console.warn('SecureStore.deleteItemAsync failed', e);
  }
};

// ACCESS TOKEN / REFRESH TOKEN helpers
export const getAuthAccessToken = async () => {
  const secureToken = await secureGet('accessToken');
  if (secureToken) return secureToken;

  const legacyToken = (await AsyncStorage.getItem('accessToken')) || (await AsyncStorage.getItem('token'));
  if (legacyToken) {
    try {
      await secureSet('accessToken', legacyToken);
      await AsyncStorage.removeItem('accessToken');
      await AsyncStorage.removeItem('token');
      console.log('Migrated legacy auth token to SecureStore');
    } catch (err) {
      console.warn('Failed migrating legacy auth token to SecureStore', err);
    }
  }
  return legacyToken;
};

export const setAuthAccessToken = async (token: string | null) => {
  // Only save if token is a non-empty string
  if (token && typeof token === 'string' && token.trim()) {
    await secureSet('accessToken', token.trim());
  } else if (!token) {
    // Only delete if explicitly null/undefined
    await secureDelete('accessToken');
  }
  // Always clean up legacy storage
  await AsyncStorage.removeItem('accessToken');
  await AsyncStorage.removeItem('token');
};

export const getRefreshToken = async () => {
  const secureToken = await secureGet('refreshToken');
  if (secureToken) return secureToken;

  const legacyToken = await AsyncStorage.getItem('refreshToken');
  if (legacyToken) {
    try {
      await secureSet('refreshToken', legacyToken);
      await AsyncStorage.removeItem('refreshToken');
      console.log('Migrated legacy refresh token to SecureStore');
    } catch (err) {
      console.warn('Failed migrating legacy refresh token to SecureStore', err);
    }
  }
  return legacyToken;
};

export const setRefreshToken = async (token: string | null) => {
  // Only save if token is a non-empty string
  if (token && typeof token === 'string' && token.trim()) {
    await secureSet('refreshToken', token.trim());
  } else if (!token) {
    // Only delete if explicitly null/undefined
    await secureDelete('refreshToken');
  }
  // Always clean up legacy storage
  await AsyncStorage.removeItem('refreshToken');
};

export const clearAuthTokens = async () => {
  await secureDelete('accessToken');
  await secureDelete('refreshToken');
  await AsyncStorage.removeItem('accessToken');
  await AsyncStorage.removeItem('token');
  await AsyncStorage.removeItem('refreshToken');
};

export default { secureSet, secureGet, secureDelete, getAuthAccessToken, setAuthAccessToken, getRefreshToken, setRefreshToken, clearAuthTokens };
