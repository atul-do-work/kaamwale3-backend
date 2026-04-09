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
import { useAuth } from "../context/AuthContext";
import { useLanguage } from "../context/LanguageContext";
import { useNotificationBadge } from "../hooks/useNotificationBadge"; // ✅ BUG #6: Real-time notification badge
import { notificationCacheManager } from "../utils/notificationCacheManager"; // ✅ BUG #6: Cache invalidation
import api from "../utils/api";
import JobRequestNotificationModal from "../components/JobRequestNotificationModal";

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
  metadata?: any;
}

export default function NotificationHistoryScreen(): React.ReactElement {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [jobRequestModalVisible, setJobRequestModalVisible] = useState(false);
  const [currentJobRequest, setCurrentJobRequest] = useState<any>(null);

  // Fetch notifications
  const fetchNotifications = useCallback(async () => {
    try {
      if (!accessToken) {
        Alert.alert(t('error'), t('noAuthTokenFound'));
        return;
      }

      const queryParams = new URLSearchParams({
        unreadOnly: filter === "unread" ? "true" : "false",
        limit: "100",
        skip: "0",
      });

      const res = await api.get(`/notifications?${queryParams}`);
      const data = res.data;

      if (data.success) {
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
        console.log(`📬 Loaded ${data.notifications.length} notifications`);
      } else {
        Alert.alert(t('error'), data.message || t('failedToLoadNotifications'));
      }
    } catch (error) {
      console.error("Fetch notifications error:", error);
      Alert.alert(t('error'), t('failedToLoadNotifications'));
    } finally {
      setLoading(false);
    }
  }, [accessToken, filter]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchNotifications();
  }, [fetchNotifications]);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      fetchNotifications();
    }, [fetchNotifications])
  );

  // Mark notification as read
  const handleMarkAsRead = async (notificationId: string) => {
    try {
      if (!accessToken) return;

      const res = await api.put(`/notifications/${notificationId}/read`);
      const data = res.data;

      if (data.success) {
        // Update local state
        setNotifications((prevNotifications) =>
          prevNotifications.map((notif) =>
            notif._id === notificationId
              ? { ...notif, isRead: true }
              : notif
          )
        );
        // ✅ Use functional update to avoid stale state
        setUnreadCount(prev => Math.max(0, prev - 1));
        notificationCacheManager.invalidate(); // ✅ BUG #6: Invalidate cache after read
        console.log(`✅ Marked notification ${notificationId} as read`);
      }
    } catch (error) {
      console.error("Mark as read error:", error);
    }
  };

  // Mark all as read
  const handleMarkAllAsRead = async () => {
    try {
      if (!accessToken) return;

      Alert.alert(
        t('markAllAsReadTitle') || "Mark All as Read?",
        t('markAllAsReadConfirm') || "Are you sure?",
        [
          { text: t('cancel'), style: "cancel" },
          {
            text: t('yes'),
            onPress: async () => {
              // ✅ Optimistic update - update UI immediately
              setNotifications((prevNotifications) =>
                prevNotifications.map((notif) => ({
                  ...notif,
                  isRead: true,
                }))
              );
              setUnreadCount(0);
              notificationCacheManager.invalidate(); // ✅ BUG #6: Invalidate cache
              
              // Then call API asynchronously
              try {
                const res = await api.put(`/notifications/read-all`);
                const data = res.data;

                if (data.success) {
                  Alert.alert(t('success'), t('allNotificationsMarkedAsRead'));
                  console.log("✅ All notifications marked as read");
                }
              } catch (apiError) {
                console.error("Mark all as read API error:", apiError);
                // If API fails, we already updated UI optimistically
              }
            },
          },
        ]
      );
    } catch (error) {
      console.error("Mark all as read error:", error);
    }
  };

  // Get icon and color based on notification type
  const getNotificationIcon = (type: string) => {
    const iconMap: Record<string, { icon: string; color: string }> = {
      job_offer: { icon: "work", color: "#3B82F6" },
      job_request: { icon: "person-add", color: "#667eea" },
      job_request_accepted: { icon: "check-circle", color: "#10B981" },
      job_request_declined: { icon: "cancel", color: "#EF4444" },
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
      ops_alert: { icon: "warning", color: "#DC2626" },
      default: { icon: "notifications", color: "#1a2f4d" },
    };

    return iconMap[type] || iconMap.default;
  };

  // Handle notification click - mark as read only, no navigation
  const handleNotificationPress = (notification: Notification) => {
    if (notification.type === 'job_request') {
      // Show job request modal for job requests
      const jobRequestData = {
        requestId: notification.metadata?.requestId,
        contractorPhone: notification.metadata?.contractorPhone,
        contractorName: notification.metadata?.contractorName,
        date: notification.metadata?.date,
        startTime: notification.metadata?.startTime,
        endTime: notification.metadata?.endTime,
        location: notification.metadata?.location,
        message: notification.metadata?.message,
        timestamp: notification.createdAt,
      };
      setCurrentJobRequest(jobRequestData);
      setJobRequestModalVisible(true);
    } else {
      // For other notifications, just mark as read
      if (!notification.isRead) {
        handleMarkAsRead(notification._id);
      }
    }
  };

  // ✅ Render notification item with useCallback for performance
  const renderNotificationItem = useCallback(({ item }: { item: Notification }) => {
    const { icon, color } = getNotificationIcon(item.type);
    const formattedDate = new Date(item.createdAt).toLocaleDateString();
    const formattedTime = new Date(item.createdAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });

    return (
      // ✅ NOW CLICKABLE: Wrap in TouchableOpacity
      <TouchableOpacity
        onPress={() => handleNotificationPress(item)}
        activeOpacity={0.8}
        style={[
          styles.notificationItem,
          !item.isRead && styles.notificationItemUnread,
        ]}
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
  }, []);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#1a2f4d" />
        <Text style={styles.loadingText}>{t('loadingNotifications')}</Text>
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
          <Text style={styles.headerTitle}>{t('notifications')}</Text>
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
              {t('all')}
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
              {t('unread')} ({unreadCount})
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
              <Text style={styles.markAllText}>{t('markAllAsRead')}</Text>
            </TouchableOpacity>
          )}

          <FlatList
            data={notifications}
            renderItem={renderNotificationItem}
            keyExtractor={(item) => item._id}
            initialNumToRender={10}
            windowSize={5}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  await fetchNotifications();
                  setRefreshing(false);
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
          <Text style={styles.emptyTitle}>{t('noNotifications')}</Text>
          <Text style={styles.emptyText}>
            {filter === "unread"
              ? t('allCaughtUpNoUnread')
              : t('noNotificationsYet')}
          </Text>
        </View>
      )}
      
      {/* Job Request Notification Modal */}
      <JobRequestNotificationModal
        visible={jobRequestModalVisible}
        onClose={() => {
          setJobRequestModalVisible(false);
          setCurrentJobRequest(null);
        }}
        jobRequest={currentJobRequest}
        onResponse={async (accepted, requestId) => {
          console.log(`Job request ${accepted ? 'accepted' : 'declined'}: ${requestId}`);
          // Refresh notifications after response
          await fetchNotifications();
        }}
      />
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
