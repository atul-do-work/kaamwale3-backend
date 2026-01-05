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

interface ActivityLog {
  _id: string;
  phone: string;
  action: string;
  description: string;
  status: string;
  jobId?: string;
  metadata?: Record<string, any>;
  timestamp: string;
  location?: {
    type: string;
    coordinates: number[];
  };
}

const ACTION_ICONS: Record<string, { icon: string; color: string }> = {
  user_registered: { icon: "person-add", color: "#10B981" },
  user_login: { icon: "login", color: "#3B82F6" },
  job_posted: { icon: "work", color: "#8B5CF6" },
  job_accepted: { icon: "check-circle", color: "#10B981" },
  job_completed: { icon: "task-alt", color: "#10B981" },
  payment_sent: { icon: "payment", color: "#F59E0B" },
  rating_given: { icon: "star", color: "#F59E0B" },
  support_ticket_created: { icon: "support-agent", color: "#EC4899" },
  job_cancelled: { icon: "close-circle", color: "#EF4444" },
  document_uploaded: { icon: "document-scanner", color: "#6366F1" },
  wallet_topup: { icon: "account-balance-wallet", color: "#8B5CF6" },
  profile_updated: { icon: "edit", color: "#3B82F6" },
  location_updated: { icon: "location-on", color: "#F59E0B" },
  worker_registered: { icon: "person", color: "#10B981" },
  refund_processed: { icon: "money-off", color: "#8B5CF6" },
};

export default function ActivityHistoryScreen(): React.ReactElement {
  const router = useRouter();
  const [activities, setActivities] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<string>("all");

  // Fetch activity history
  const fetchActivityHistory = useCallback(async () => {
    try {
      const storedToken = await AsyncStorage.getItem("token");
      if (!storedToken) {
        Alert.alert("Error", "No authentication token found");
        return;
      }

      setToken(storedToken);

      const queryParams = new URLSearchParams({
        limit: "100",
        skip: "0",
      });

      const response = await fetch(
        `${SERVER_URL}/activity/history?${queryParams}`,
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
        setActivities(data.activities || []);
        console.log(`📊 Loaded ${data.activities.length} activity logs`);
      } else {
        Alert.alert("Error", data.message || "Failed to load activity history");
      }
    } catch (error) {
      console.error("Fetch activity history error:", error);
      Alert.alert("Error", "Failed to load activity history");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchActivityHistory();
  }, []);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      fetchActivityHistory();
    }, [fetchActivityHistory])
  );

  // Get unique action types for filter
  const getActionTypes = () => {
    const types = new Set(activities.map((a) => a.action));
    return Array.from(types).sort();
  };

  // Filter activities
  const filteredActivities =
    selectedFilter === "all"
      ? activities
      : activities.filter((a) => a.action === selectedFilter);

  // Get icon and color for action
  const getActionIconAndColor = (action: string) => {
    return (
      ACTION_ICONS[action] || {
        icon: "info",
        color: "#6B7280",
      }
    );
  };

  // Format action label
  const formatActionLabel = (action: string) => {
    return action
      .split("_")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  };

  // Render activity item
  const renderActivityItem = ({ item }: { item: ActivityLog }) => {
    const { icon, color } = getActionIconAndColor(item.action);
    const timestamp = new Date(item.timestamp);
    const formattedDate = timestamp.toLocaleDateString("en-IN");
    const formattedTime = timestamp.toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const isSuccess = item.status === "success";

    return (
      <View style={styles.activityItem}>
        <View style={[styles.iconBg, { backgroundColor: color + "20" }]}>
          <MaterialIcons name={icon as any} size={24} color={color} />
        </View>

        <View style={styles.activityContent}>
          <View style={styles.activityHeader}>
            <Text style={styles.activityAction}>
              {formatActionLabel(item.action)}
            </Text>
            <View
              style={[
                styles.statusBadge,
                {
                  backgroundColor: isSuccess ? "#D1FAE5" : "#FEE2E2",
                },
              ]}
            >
              <MaterialIcons
                name={isSuccess ? "check-circle" : "error"}
                size={14}
                color={isSuccess ? "#059669" : "#DC2626"}
              />
              <Text
                style={{
                  color: isSuccess ? "#059669" : "#DC2626",
                  fontSize: 11,
                  fontWeight: "700",
                }}
              >
                {isSuccess ? "Success" : "Failed"}
              </Text>
            </View>
          </View>

          <Text style={styles.activityDescription} numberOfLines={2}>
            {item.description}
          </Text>

          {item.jobId && (
            <Text style={styles.activityJobId}>
              Job: {item.jobId.substring(0, 12)}...
            </Text>
          )}

          <Text style={styles.activityTime}>
            {formattedDate} at {formattedTime}
          </Text>
        </View>

        <TouchableOpacity style={styles.expandBtn}>
          <MaterialIcons name="arrow-forward" size={18} color="#9CA3AF" />
        </TouchableOpacity>
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#6C63FF" />
        <Text style={styles.loadingText}>Loading activity history...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#6C63FF", "#A78BFA"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Activity History</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      {/* Filter Tabs */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.filterScroll}
        contentContainerStyle={styles.filterContent}
      >
        <TouchableOpacity
          style={[
            styles.filterBtn,
            selectedFilter === "all" && styles.filterBtnActive,
          ]}
          onPress={() => setSelectedFilter("all")}
        >
          <Text
            style={[
              styles.filterText,
              selectedFilter === "all" && styles.filterTextActive,
            ]}
          >
            All ({activities.length})
          </Text>
        </TouchableOpacity>

        {getActionTypes().map((action) => (
          <TouchableOpacity
            key={action}
            style={[
              styles.filterBtn,
              selectedFilter === action && styles.filterBtnActive,
            ]}
            onPress={() => setSelectedFilter(action)}
          >
            <Text
              style={[
                styles.filterText,
                selectedFilter === action && styles.filterTextActive,
              ]}
            >
              {formatActionLabel(action)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Activities List */}
      {filteredActivities.length > 0 ? (
        <FlatList
          data={filteredActivities}
          renderItem={renderActivityItem}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchActivityHistory();
              }}
              colors={["#6C63FF"]}
            />
          }
        />
      ) : (
        <View style={styles.emptyContainer}>
          <MaterialIcons name="history" size={80} color="#D1D5DB" />
          <Text style={styles.emptyTitle}>No Activity Yet</Text>
          <Text style={styles.emptyText}>
            Your activity will appear here as you use the app.
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
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 40,
    paddingBottom: 16,
    paddingHorizontal: 16,
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
  filterScroll: {
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  filterContent: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 8,
  },
  filterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#F3F4F6",
  },
  filterBtnActive: {
    backgroundColor: "#6C63FF",
  },
  filterText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6B7280",
  },
  filterTextActive: {
    color: "#fff",
  },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 20,
  },
  activityItem: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
    alignItems: "flex-start",
    gap: 12,
  },
  iconBg: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  activityContent: {
    flex: 1,
  },
  activityHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  activityAction: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    gap: 4,
  },
  activityDescription: {
    fontSize: 13,
    color: "#6B7280",
    marginBottom: 6,
    lineHeight: 18,
  },
  activityJobId: {
    fontSize: 11,
    color: "#9CA3AF",
    marginBottom: 4,
    fontFamily: "monospace",
  },
  activityTime: {
    fontSize: 11,
    color: "#D1D5DB",
  },
  expandBtn: {
    padding: 8,
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
