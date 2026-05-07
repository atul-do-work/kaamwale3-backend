import { getAuthAccessToken, setAuthAccessToken, getRefreshToken, setRefreshToken, clearAuthTokens } from './secureStore';

/**
 * Centralized auth token utilities for the app.
 * Use these instead of direct AsyncStorage or SecureStore calls for auth tokens.
 */
export const authToken = {
  /**
   * Get the current access token (from secure storage, with legacy migration).
   */
  getAccessToken: getAuthAccessToken,

  /**
   * Set the access token (to secure storage, clearing legacy).
   */
  setAccessToken: setAuthAccessToken,

  /**
   * Get the refresh token (from secure storage, with legacy migration).
   */
  getRefreshToken: getRefreshToken,

  /**
   * Set the refresh token (to secure storage, clearing legacy).
   */
  setRefreshToken: setRefreshToken,

  /**
   * Clear all auth tokens from both secure and legacy storage.
   */
  clearTokens: clearAuthTokens,
};

export default authToken;