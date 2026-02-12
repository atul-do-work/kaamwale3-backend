import { io } from "socket.io-client";
import { SERVER_URL } from "./config";

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

// Keep an in-memory token reference (set by AuthProvider or components)
let currentToken: string | null = null;

export const setSocketAuth = (token: string | null) => {
  currentToken = token;
  (socket.auth as any) = token ? { token } : null;
};

// ✅ CRITICAL: Re-apply auth token on reconnection
socket.on("disconnect", () => {
  console.log("🔌 Socket disconnected, will auto-reconnect with auth token");
  // Use the in-memory token set via `setSocketAuth`.
  if (currentToken) {
    (socket.auth as any) = { token: currentToken };
    console.log("🔐 Auth token prepared for reconnection (in-memory)");
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
    // Disconnect socket and clear its auth state. Storage clearing is handled by AuthProvider.
    disconnectSocket();
    (socket.auth as any) = null;
    currentToken = null;
    console.log("✅ Socket state cleared (storage clearing handled elsewhere)");
  } catch (err) {
    const error = err as Error;
    console.error("❌ Error clearing user data:", error);
    throw err;
  }
};
