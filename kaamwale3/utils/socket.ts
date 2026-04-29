import { io } from "socket.io-client";
import { SERVER_URL } from "./config";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { secureGet } from "./secureStore";

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

const refreshAuthToken = async () => {
  let authToken = (await AsyncStorage.getItem("accessToken")) || (await AsyncStorage.getItem("token"));
  const refreshToken = (await secureGet("refreshToken")) || (await AsyncStorage.getItem("refreshToken"));

  if (refreshToken) {
    try {
      const response = await fetch(`${SERVER_URL}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.accessToken && typeof data.accessToken === "string") {
          authToken = data.accessToken;
          await AsyncStorage.setItem("accessToken", data.accessToken);
          console.log("🔄 Token refreshed successfully");
        }
      }
    } catch (e) {
      const error = e as Error;
      console.log("Could not refresh token:", error.message);
    }
  }

  return authToken;
};

const ensureSocketAuth = async () => {
  const authToken = await refreshAuthToken();
  if (authToken) {
    (socket.auth as any) = { token: authToken };
    console.log("🔐 Socket auth token applied");
  }
};

// ✅ CRITICAL: Re-apply auth token on reconnection
socket.on("disconnect", async () => {
  console.log("🔌 Socket disconnected, will auto-reconnect with auth token");
  await ensureSocketAuth();
});

socket.on("reconnect_attempt", async () => {
  console.log("🔄 Socket reconnect attempt, refreshing auth token if needed");
  await ensureSocketAuth();
});

// Optional listener to track status
socket.on("connect", () => {
  console.log("✅ Socket connected:", socket.id);
});

socket.on("connect_error", async (err: Error) => {
  console.log("⚠️ Socket connection error:", err.message);
  await ensureSocketAuth();
});

// ✅ Handle token expiry notification from server
socket.on("tokenExpired", async (data: { message: string }) => {
  console.log("⚠️ Server says token expired:", data.message);
  await ensureSocketAuth();
  if (!socket.connected) {
    socket.connect();
  }
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
