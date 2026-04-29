import React, { useEffect, useState, useCallback, useRef } from "react";
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
import { SafeAreaView } from "react-native-safe-area-context";

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
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const isFetchingRef = useRef(false);
  const lastFetchRef = useRef<number>(0);
  const [markingAllRead, setMarkingAllRead] = useState(false);
  const [jobRequestModalVisible, setJobRequestModalVisible] = useState(false);
  const [currentJobRequest, setCurrentJobRequest] = useState<any>(null);

  // Fetch notifications with lock + pagination
  const fetchNotifications = useCallback(async (pageToLoad = 1, append = false) => {
    if (isFetchingRef.current) return;
    // throttle frequent refetches when switching tabs
    if (pageToLoad === 1 && Date.now() - lastFetchRef.current < 5000) {
      return;
    }
    isFetchingRef.current = true;
    if (pageToLoad === 1) setLoading(true);
    try {
      if (!accessToken) {
        // don't show repeated alerts for auth missing
        console.warn('No auth token for notifications');
        return;
      }

      const limit = 20;
      const skip = (pageToLoad - 1) * limit;
      const queryParams = new URLSearchParams({
        unreadOnly: filter === "unread" ? "true" : "false",
        limit: String(limit),
        skip: String(skip),
      });

      const res = await api.get(`/notifications?${queryParams}`);
      const data = res.data;

      if (data.success) {
        const next = data.notifications || [];
        setNotifications((prev) => {
          if (append) {
            const ids = new Set(prev.map((n) => n._id));
            const dedupedAppend = next.filter((n: Notification) => !ids.has(n._id));
            const merged = [...prev, ...dedupedAppend];
            return merged;
          }
          return next;
        });
        setUnreadCount(data.unreadCount || 0);
        setHasMore((next.length || 0) >= limit);
        setPage(pageToLoad);
        lastFetchRef.current = Date.now();
        console.log(`📬 Loaded ${next.length} notifications (page ${pageToLoad})`);
      } else {
        console.warn('Failed to load notifications', data.message);
      }
    } catch (error) {
      console.error("Fetch notifications error:", error);
      // set inline error instead of alert spam
      // reuse existing Alert for critical failures elsewhere
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken, filter]);

  // Load on focus only (covers initial mount and when returning to screen)
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setPage(1);
      setHasMore(true);
      fetchNotifications(1, false);
    }, [fetchNotifications])
  );

  // Mark notification as read
  const handleMarkAsRead = useCallback(async (notificationId: string) => {
    try {
      if (!accessToken) return;

      const res = await api.put(`/notifications/${notificationId}/read`);
      const data = res.data;

      if (data.success) {
        // Update local state optimistically
        setNotifications((prevNotifications) =>
          prevNotifications.map((notif) =>
            notif._id === notificationId
              ? { ...notif, isRead: true }
              : notif
          )
        );
        // update unread count locally to avoid waiting for full refetch
        setUnreadCount((c) => Math.max(0, c - 1));
        notificationCacheManager.invalidate();
        console.log(`✅ Marked notification ${notificationId} as read`);
        // schedule a background refresh to fully sync state
        fetchNotifications(1, false);
      }
    } catch (error) {
      console.error("Mark as read error:", error);
    }
  }, [accessToken, fetchNotifications]);

  // Mark all as read
  const handleMarkAllAsRead = async () => {
    try {
      if (!accessToken) return;

      Alert.alert(
        t('markAllAsReadTitle' as any) || "Mark All as Read?",
        t('markAllAsReadConfirm' as any) || "Are you sure?",
        [
          { text: t('cancel'), style: "cancel" },
          {
            text: t('yes'),
            onPress: async () => {
              // Disable action while processing and optimistically mark items
              setMarkingAllRead(true);
              setNotifications((prevNotifications) =>
                prevNotifications.map((notif) => ({ ...notif, isRead: true }))
              );
              notificationCacheManager.invalidate();
              try {
                const res = await api.put(`/notifications/read-all`);
                const data = res.data;

                if (data.success) {
                  // refresh to ensure accurate counts
                  await fetchNotifications(1, false);
                  Alert.alert(t('success' as any), t('allNotificationsMarkedAsRead' as any));
                  console.log("✅ All notifications marked as read");
                }
              } catch (apiError) {
                console.error("Mark all as read API error:", apiError);
              } finally {
                setMarkingAllRead(false);
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
  const getNotificationIcon = useCallback((type: string) => {
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
  }, []);

  // Handle notification click - mark as read only, no navigation
  const handleNotificationPress = useCallback((notification: Notification) => {
    if (notification.type === 'job_request') {
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
      if (!notification.isRead) {
        handleMarkAsRead(notification._id);
      }
    }
  }, [handleMarkAsRead]);

  // ✅ Render notification item with useCallback for performance
  const renderNotificationItem = useCallback(({ item }: { item: Notification }) => {
    const { icon, color } = getNotificationIcon(item.type);
    const dt = formatNotificationDate(item.createdAt);
    const formattedDate = dt.date;
    const formattedTime = dt.time;

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
  }, [getNotificationIcon, handleNotificationPress]);

  // Format notification date robustly
  function formatNotificationDate(raw: string) {
    if (!raw) return { date: '-', time: '-' };
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      return {
        date: parsed.toLocaleDateString(),
        time: parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
    }

    // Fallback: try DD/MM/YYYY patterns
    const m = String(raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]) - 1;
      const year = Number(m[3]);
      let hour = Number(m[4] || 0);
      const minute = Number(m[5] || 0);
      const mer = (m[7] || '').toUpperCase();
      if (mer === 'PM' && hour < 12) hour += 12;
      if (mer === 'AM' && hour === 12) hour = 0;
      const d = new Date(year, month, day, hour, minute);
      if (!Number.isNaN(d.getTime())) {
        return { date: d.toLocaleDateString(), time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
      }
    }

    return { date: raw, time: '' };
  }

  if (loading) {
    // Simple skeleton placeholders while loading
    return (
      <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
        <LinearGradient colors={["#1a2f4d", "#1a2f4d"]} style={styles.header}>
          <View style={styles.headerTop}>
            <TouchableOpacity style={styles.backBtn} />
            <Text style={styles.headerTitle}>{t('notifications')}</Text>
            <View style={{ width: 40 }} />
          </View>
        </LinearGradient>
        <View style={styles.contentArea}>
          <View style={{ padding: 12 }}>
          {[...Array(6)].map((_, i) => (
            <View key={i} style={styles.skeletonItem} />
          ))}
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
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
      <View style={styles.contentArea}>
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
            keyExtractor={(item, index) => item._id || index.toString()}
            initialNumToRender={10}
            windowSize={5}
            removeClippedSubviews
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={async () => {
                  setRefreshing(true);
                  await fetchNotifications(1, false);
                  setRefreshing(false);
                }}
                colors={["#667eea"]}
              />
            }
            onEndReachedThreshold={0.6}
            onEndReached={() => {
              if (!loading && hasMore && !isFetchingRef.current) fetchNotifications(page + 1, true);
            }}
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
              ? (t('allCaughtUpNoUnread' as any))
              : (t('noNotificationsYet' as any))}
          </Text>
          <TouchableOpacity
            onPress={async () => {
              setLoading(true);
              await fetchNotifications(1, false);
            }}
            style={{ marginTop: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#EEF2FF', borderRadius: 8 }}
          >
            <Text style={{ color: '#334155', fontWeight: '600' }}>{t('retry' as any) || 'Retry'}</Text>
          </TouchableOpacity>
        </View>
      )}
      </View>
      
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
          await fetchNotifications(1, false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#1a2f4d",
  },
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  contentArea: {
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
    paddingTop: 12,
    paddingBottom: 10,
    paddingHorizontal: 14,
  },
  headerTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  backBtn: {
    paddingVertical: 6,
    paddingRight: 8,
    paddingLeft: 0,
  },
  headerTitle: {
    fontSize: 21,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    textAlign: "center",
  },
  headerRight: {
    width: 32,
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
    gap: 6,
  },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  filterTabActive: {
    backgroundColor: "#fff",
  },
  filterText: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontWeight: "600",
  },
  filterTextActive: {
    color: "#667eea",
  },
  listContainer: {
    flex: 1,
    paddingHorizontal: 12,
    paddingTop: 10,
  },
  markAllBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
    marginBottom: 10,
    gap: 8,
  },
  markAllText: {
    color: "#1a2f4d",
    fontSize: 13,
    fontWeight: "600",
  },
  notificationItem: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    alignItems: "flex-start",
    gap: 10,
    borderLeftWidth: 3,
    borderLeftColor: "transparent",
  },
  notificationItemUnread: {
    backgroundColor: "#F9FAFB",
    borderLeftColor: "#667eea",
  },
  iconBg: {
    width: 38,
    height: 38,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  notificationContent: {
    flex: 1,
    paddingTop: 1,
  },
  notificationTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 2,
  },
  notificationBody: {
    fontSize: 12,
    color: "#6B7280",
    marginBottom: 4,
    lineHeight: 17,
  },
  notificationTime: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  unreadBadge: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#667eea",
    marginTop: 4,
  },
  skeletonItem: {
    height: 64,
    backgroundColor: '#EEE',
    borderRadius: 10,
    marginBottom: 8,
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
