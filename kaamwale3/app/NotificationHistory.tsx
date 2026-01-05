import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  FlatList,
  RefreshControl,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useFocusEffect } from "expo-router";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { SERVER_URL } from "../utils/config";

interface Notification {
  _id: string;
  recipientPhone: string;
  type: string;
  title: string;
  body: string;
  jobId?: string;
  isRead: boolean;
  readAt?: string;
  createdAt: string;
  deepLink?: string;
}

export default function NotificationHistoryScreen(): React.ReactElement {
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      const storedToken = await AsyncStorage.getItem("token");
      if (!storedToken) {
        Alert.alert("Error", "No authentication token found");
        return;
      }

      setToken(storedToken);

      const queryParams = new URLSearchParams({
        unreadOnly: filter === "unread" ? "true" : "false",
        limit: "100",
        skip: "0",
      });

      const response = await fetch(
        `${SERVER_URL}/notifications?${queryParams}`,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${storedToken}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json();

      if (data.success) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
        console.log(`📬 Loaded ${data.notifications.length} notifications`);
      } else {
        Alert.alert("Error", data.message || "Failed to load notifications");
      }
    } catch (error) {
      console.error("Fetch notifications error:", error);
      Alert.alert("Error", "Failed to load notifications");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [filter]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchNotifications();
  }, [filter]);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      fetchNotifications();
    }, [fetchNotifications])
  );

  // Mark notification as read
  const handleMarkAsRead = async (notificationId: string) => {
    try {
      if (!token) return;

      const response = await fetch(
        `${SERVER_URL}/notifications/${notificationId}/read`,
        {
          method: "PUT",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );

      const data = await response.json();

      if (data.success) {
        // Update local state
        setNotifications((prevNotifications) =>
          prevNotifications.map((notif) =>
            notif._id === notificationId
              ? { ...notif, isRead: true }
              : notif
          )
        );
        setUnreadCount(Math.max(0, unreadCount - 1));
        console.log(`✅ Marked notification ${notificationId} as read`);
      }
    } catch (error) {
      console.error("Mark as read error:", error);
    }
  };

  // Mark all as read
  const handleMarkAllAsRead = async () => {
    try {
      if (!token) return;

      Alert.alert("Mark All as Read?", "Are you sure?", [
        { text: "Cancel", style: "cancel" },
        {
          text: "Yes",
          onPress: async () => {
            const response = await fetch(`${SERVER_URL}/notifications/read-all`, {
              method: "PUT",
              headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
              },
            });

            const data = await response.json();

            if (data.success) {
              // Update local state
              setNotifications((prevNotifications) =>
                prevNotifications.map((notif) => ({
                  ...notif,
                  isRead: true,
                }))
              );
              setUnreadCount(0);
              Alert.alert("Success", "All notifications marked as read");
              console.log("✅ All notifications marked as read");
            }
          },
        },
      ]);
    } catch (error) {
      console.error("Mark all as read error:", error);
    }
  };

  // Get icon and color based on notification type
  const getNotificationIcon = (type: string) => {
    const iconMap: Record<string, { icon: string; color: string }> = {
      job_offer: { icon: "work", color: "#3B82F6" },
      job_accepted: { icon: "check-circle", color: "#10B981" },
      payment_sent: { icon: "payment", color: "#8B5CF6" },
      rating_received: { icon: "star", color: "#F59E0B" },
      support_response: { icon: "support-agent", color: "#EC4899" },
      document_verified: { icon: "verified-user", color: "#10B981" },
      document_rejected: { icon: "cancel", color: "#EF4444" },
      account_restricted: { icon: "lock", color: "#F97316" },
      refund_processed: { icon: "money-off", color: "#8B5CF6" },
      job_completed: { icon: "task-alt", color: "#10B981" },
      job_cancelled: { icon: "close-circle", color: "#EF4444" },
      review_reminder: { icon: "feedback", color: "#3B82F6" },
      default: { icon: "notifications", color: "#1a2f4d" },
    };

    return iconMap[type] || iconMap.default;
  };

  // Handle notification click (navigate to related screen if deepLink exists)
  const handleNotificationPress = (notification: Notification) => {
    if (!notification.isRead) {
      handleMarkAsRead(notification._id);
    }

    if (notification.deepLink) {
      // Navigate using the deeplink if available
      try {
        router.push(notification.deepLink as any);
      } catch (error) {
        console.log("Navigation to deeplink not available", error);
      }
    }
  };

  // Render notification item
  const renderNotificationItem = ({ item }: { item: Notification }) => {
    const { icon, color } = getNotificationIcon(item.type);
    const formattedDate = new Date(item.createdAt).toLocaleDateString("en-IN");
    const formattedTime = new Date(item.createdAt).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      <TouchableOpacity
        style={[
          styles.notificationItem,
          !item.isRead && styles.notificationItemUnread,
        ]}
        onPress={() => handleNotificationPress(item)}
      >
        <View style={[styles.iconBg, { backgroundColor: color + "20" }]}>
          <MaterialIcons name={icon as any} size={24} color={color} />
        </View>

        <View style={styles.notificationContent}>
          <Text style={styles.notificationTitle}>{item.title}</Text>
          <Text style={styles.notificationBody} numberOfLines={2}>
            {item.body}
          </Text>
          <Text style={styles.notificationTime}>
            {formattedDate} at {formattedTime}
          </Text>
        </View>

        {!item.isRead && <View style={styles.unreadBadge} />}
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#1a2f4d" />
        <Text style={styles.loadingText}>Loading notifications...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#1a2f4d", "#1a2f4d"]} style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Notifications</Text>
          <View style={styles.headerRight}>
            {unreadCount > 0 && (
              <View style={styles.badgeCircle}>
                <Text style={styles.badgeText}>
                  {unreadCount > 99 ? "99+" : unreadCount}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* Filter Tabs */}
        <View style={styles.filterContainer}>
          <TouchableOpacity
            style={[
              styles.filterTab,
              filter === "all" && styles.filterTabActive,
            ]}
            onPress={() => setFilter("all")}
          >
            <Text
              style={[
                styles.filterText,
                filter === "all" && styles.filterTextActive,
              ]}
            >
              All
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[
              styles.filterTab,
              filter === "unread" && styles.filterTabActive,
            ]}
            onPress={() => setFilter("unread")}
          >
            <Text
              style={[
                styles.filterText,
                filter === "unread" && styles.filterTextActive,
              ]}
            >
              Unread ({unreadCount})
            </Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Notifications List */}
      {notifications.length > 0 ? (
        <View style={styles.listContainer}>
          {/* Mark All as Read Button */}
          {unreadCount > 0 && (
            <TouchableOpacity
              style={styles.markAllBtn}
              onPress={handleMarkAllAsRead}
            >
              <Ionicons name="checkmark-done" size={18} color="#1a2f4d" />
              <Text style={styles.markAllText}>Mark all as read</Text>
            </TouchableOpacity>
          )}

          <FlatList
            data={notifications}
            renderItem={renderNotificationItem}
            keyExtractor={(item) => item._id}
            scrollEnabled={false}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => {
                  setRefreshing(true);
                  fetchNotifications();
                }}
                colors={["#667eea"]}
              />
            }
          />
        </View>
      ) : (
        <View style={styles.emptyContainer}>
          <MaterialIcons
            name="notifications-none"
            size={80}
            color="#D1D5DB"
          />
          <Text style={styles.emptyTitle}>No Notifications</Text>
          <Text style={styles.emptyText}>
            {filter === "unread"
              ? "You're all caught up! No unread notifications."
              : "You don't have any notifications yet."}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F8F9FA",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: "#666",
  },
  header: {
    paddingTop: 40,
    paddingBottom: 20,
    paddingHorizontal: 16,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  backBtn: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    textAlign: "center",
  },
  headerRight: {
    width: 40,
    alignItems: "flex-end",
  },
  badgeCircle: {
    backgroundColor: "#FF6B6B",
    borderRadius: 12,
    minWidth: 24,
    height: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  badgeText: {
    color: "#fff",
    fontSize: 12,
    fontWeight: "700",
  },
  filterContainer: {
    flexDirection: "row",
    gap: 8,
  },
  filterTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  filterTabActive: {
    backgroundColor: "#fff",
  },
  filterText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 14,
    fontWeight: "600",
  },
  filterTextActive: {
    color: "#667eea",
  },
  listContainer: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 12,
  },
  markAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
    marginBottom: 12,
    gap: 8,
  },
  markAllText: {
    color: "#1a2f4d",
    fontSize: 14,
    fontWeight: "600",
  },
  notificationItem: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    alignItems: "flex-start",
    gap: 12,
    borderLeftWidth: 4,
    borderLeftColor: "transparent",
  },
  notificationItemUnread: {
    backgroundColor: "#F9FAFB",
    borderLeftColor: "#667eea",
  },
  iconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  notificationContent: {
    flex: 1,
  },
  notificationTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 4,
  },
  notificationBody: {
    fontSize: 14,
    color: "#6B7280",
    marginBottom: 6,
    lineHeight: 20,
  },
  notificationTime: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  unreadBadge: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#667eea",
    marginTop: 2,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1F2937",
    marginTop: 16,
  },
  emptyText: {
    fontSize: 14,
    color: "#9CA3AF",
    marginTop: 8,
    textAlign: "center",
  },
});
