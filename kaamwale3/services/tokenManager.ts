import { SERVER_URL } from '../utils/config';
import { getAuthAccessToken, setAuthAccessToken, getRefreshToken, clearAuthTokens } from '../utils/secureStore';

interface TokenResult {
  success: boolean;
  accessToken?: string;
  refreshToken?: string;
  error?: string;
}

class TokenManager {
  private refreshPromise: Promise<TokenResult> | null = null;
  private circuitBreakerOpen = false;
  private lastFailureTime = 0;
  private failureCount = 0;
  private readonly CIRCUIT_BREAKER_TIMEOUT = 30000; // 30 seconds
  private readonly MAX_FAILURES = 3;

  async refreshAccessToken(): Promise<TokenResult> {
    // ✅ Circuit breaker pattern to prevent infinite loops
    if (this.circuitBreakerOpen) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.CIRCUIT_BREAKER_TIMEOUT) {
        console.warn('🔄 Circuit breaker open, skipping token refresh');
        return { success: false, error: 'Circuit breaker open' };
      }
      // Reset circuit breaker after timeout
      this.circuitBreakerOpen = false;
      this.failureCount = 0;
    }

    // ✅ Prevent concurrent refresh requests
    if (this.refreshPromise) {
      console.log('🔄 Using existing refresh promise');
      return this.refreshPromise;
    }

    this.refreshPromise = this.performRefresh();

    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async performRefresh(): Promise<TokenResult> {
    try {
      const refreshToken = await getRefreshToken();
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      console.log('🔄 Refreshing access token...');

      const response = await fetch(`${SERVER_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        throw new Error(`Refresh failed: ${response.status}`);
      }

      const data = await response.json();

      if (data.success && data.accessToken) {
        // ✅ Store new tokens
        await setAuthAccessToken(data.accessToken);
        if (data.refreshToken) {
          await setRefreshToken(data.refreshToken);
        }

        // ✅ Reset circuit breaker on success
        this.failureCount = 0;
        this.circuitBreakerOpen = false;

        console.log('✅ Token refreshed successfully');
        return {
          success: true,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
        };
      } else {
        throw new Error(data.message || 'Refresh failed');
      }

    } catch (error) {
      console.error('❌ Token refresh error:', error);

      // ✅ Circuit breaker logic
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.MAX_FAILURES) {
        this.circuitBreakerOpen = true;
        console.warn('🔌 Circuit breaker opened due to repeated failures');
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  async getValidAccessToken(): Promise<string | null> {
    const storedToken = await getAuthAccessToken();
    if (!storedToken) {
      return null;
    }

    // ✅ Basic token validation (you might want to decode JWT and check expiry)
    // For now, assume token is valid if it exists
    return storedToken;
  }

  async clearTokens(): Promise<void> {
    await clearAuthTokens();
    this.circuitBreakerOpen = false;
    this.failureCount = 0;
  }
}

export const tokenManager = new TokenManager();