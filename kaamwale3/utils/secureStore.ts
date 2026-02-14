import * as SecureStore from 'expo-secure-store';

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

export default { secureSet, secureGet, secureDelete };
