import { io } from "socket.io-client";
import { SERVER_URL } from "./config";
import AsyncStorage from "@react-native-async-storage/async-storage";

// ⚠️ Do NOT create multiple socket instances.
// Create only ONE global instance and export it.
// Use central SERVER_URL from config. This keeps all files pointed to the same backend.
const SOCKET_URL = SERVER_URL;
// const SOCKET_URL = "http://192.168.31.106:3000"; // LAN IP (local testing)
// const SOCKET_URL = "http://localhost:3000"; // For web / iOS

export const socket = io(SOCKET_URL, {
  transports: ["websocket"],
  autoConnect: false,
  reconnection: true,
  reconnectionAttempts: 15,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
});

// ✅ CRITICAL: Re-apply auth token on reconnection
socket.on("disconnect", async () => {
  console.log("🔌 Socket disconnected, will auto-reconnect with auth token");
  // Retrieve token for next reconnection
  let token = await AsyncStorage.getItem("token");

  // If we have a refresh token and regular token might be expired, try refreshing
  const refreshToken = await AsyncStorage.getItem("refreshToken");
  if (refreshToken && token) {
    try {
      // Try to refresh the token proactively
      const config = await import("./config");
      const SERVER_URL = config.SERVER_URL;
      const response = await fetch(`${SERVER_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.accessToken && typeof data.accessToken === "string") {
          token = data.accessToken;
          await AsyncStorage.setItem("token", data.accessToken);
          console.log("🔄 Token refreshed on disconnect");
        }
      }
    } catch (e) {
      const error = e as Error;
      console.log("Could not refresh token on disconnect:", error.message);
      // Continue with old token, will get error on reconnect
    }
  }

  if (token) {
    (socket.auth as any) = { token };
    console.log("🔐 Auth token prepared for reconnection");
  }
});

// Optional listener to track status
socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
});

socket.on("connect_error", (err: Error) => {
  console.log("⚠️ Socket connection error:", err.message);
});

// ✅ Handle token expiry notification from server
socket.on("tokenExpired", async (data: { message: string }) => {
  console.log("⚠️ Server says token expired:", data.message);
  // Client should handle this by logging out or refreshing token
  // This is a signal that the current token is no longer valid
});

export const connectSocket = () => {
  if (!socket.connected) {
    socket.connect();
  }
};

export const disconnectSocket = () => {
  if (socket.connected) {
    socket.disconnect();
  }
};

// ✅ COMPREHENSIVE LOGOUT: Clear all user data and socket state
export const clearAllUserData = async () => {
  try {
    console.log("🗑️ Clearing all user data on logout...");

    // Disconnect socket first
    disconnectSocket();

    // Clear socket auth to prevent stale reconnect
    (socket.auth as any) = null;

    // Clear all AsyncStorage keys
    const keys = await AsyncStorage.getAllKeys();
    await AsyncStorage.multiRemove(keys);

    console.log("✅ All user data cleared successfully");
  } catch (err) {
    const error = err as Error;
    console.error("❌ Error clearing user data:", error);
    throw err;
  }
};
