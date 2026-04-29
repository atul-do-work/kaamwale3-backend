import { socket } from '../utils/socket';
import { tokenManager } from './tokenManager';

interface SocketResult {
  success: boolean;
  error?: string;
}

class SocketConnectionManager {
  private connectionPromise: Promise<SocketResult> | null = null;
  private lastUserId: string | null = null;

  async ensureConnected(userId: string): Promise<SocketResult> {
    // ✅ Prevent concurrent connection attempts
    if (this.connectionPromise) {
      console.log('🔌 Using existing connection promise');
      return this.connectionPromise;
    }

    // ✅ If already connected and same user, return success
    if (socket.connected && this.lastUserId === userId) {
      console.log('🔌 Socket already connected for user:', userId);
      return { success: true };
    }

    // ✅ Handle user switching - disconnect first
    if (socket.connected && this.lastUserId && this.lastUserId !== userId) {
      console.log('🔌 Disconnecting previous user connection');
      socket.disconnect();
      this.lastUserId = null;
    }

    this.connectionPromise = this.performConnection(userId);

    try {
      const result = await this.connectionPromise;
      return result;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async performConnection(userId: string): Promise<SocketResult> {
    try {
      console.log('🔌 Connecting socket for user:', userId);

      // ✅ Get fresh token before connecting
      const tokenResult = await tokenManager.refreshAccessToken();
      if (!tokenResult.success || !tokenResult.accessToken) {
        throw new Error('Failed to get valid token for socket connection');
      }

      // ✅ Set auth token on socket
      socket.auth = { token: tokenResult.accessToken };

      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('🔌 Socket connection timeout');
          resolve({ success: false, error: 'Connection timeout' });
        }, 10000); // 10 second timeout

        const onConnect = () => {
          clearTimeout(timeout);
          console.log('✅ Socket connected successfully');
          this.lastUserId = userId;
          socket.off('connect', onConnect);
          socket.off('connect_error', onConnectError);
          resolve({ success: true });
        };

        const onConnectError = (error: any) => {
          clearTimeout(timeout);
          console.error('❌ Socket connection error:', error);
          socket.off('connect', onConnect);
          socket.off('connect_error', onConnectError);
          resolve({ success: false, error: error.message || 'Connection failed' });
        };

        socket.once('connect', onConnect);
        socket.once('connect_error', onConnectError);

        // ✅ Initiate connection
        socket.connect();
      });

    } catch (error) {
      console.error('❌ Socket connection setup error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  disconnect(): void {
    if (socket.connected) {
      console.log('🔌 Disconnecting socket');
      socket.disconnect();
    }
    this.lastUserId = null;
    this.connectionPromise = null;
  }

  isConnected(): boolean {
    return socket.connected;
  }

  getCurrentUserId(): string | null {
    return this.lastUserId;
  }
}

export const socketConnectionManager = new SocketConnectionManager();