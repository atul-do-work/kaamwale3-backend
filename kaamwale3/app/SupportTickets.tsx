import React, { useEffect, useState, useCallback } from "react";
import { useLanguage } from "../utils/auth";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  FlatList,
  TextInput,
  Modal,
  Image,
  RefreshControl,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "../context/AuthContext";
import * as ImagePicker from "expo-image-picker";
import { SERVER_URL } from "../utils/config";
import api from "../utils/api";

interface SupportTicket {
  _id: string;
  ticketId: string;
  reporterPhone: string;
  reportedPhone?: string;
  jobId?: string;
  type: string;
  subject: string;
  description: string;
  status: string;
  priority?: string;
  screenshots?: string[];
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

const TICKET_TYPES = [
  { id: "payment_issue", label: "💳 Payment Issue", color: "#8B5CF6" },
  { id: "quality_issue", label: "⭐ Quality Issue", color: "#F59E0B" },
  { id: "safety_concern", label: "🛡️ Safety Concern", color: "#EF4444" },
  { id: "fraud", label: "🚨 Fraud", color: "#DC2626" },
  { id: "behavioral_issue", label: "👤 Behavioral Issue", color: "#EC4899" },
  { id: "technical_issue", label: "🔧 Technical Issue", color: "#6366F1" },
];

const TICKET_STATUSES = {
  open: { label: "Open", color: "#3B82F6", icon: "circle" },
  under_review: { label: "Under Review", color: "#F59E0B", icon: "schedule" },
  waiting_user_response: {
    label: "Waiting Response",
    color: "#8B5CF6",
    icon: "comment",
  },
  resolved: { label: "Resolved", color: "#10B981", icon: "check-circle" },
  closed: { label: "Closed", color: "#6B7280", icon: "close-circle" },
};

export default function SupportTicketsScreen(): React.ReactElement {
    const { t } = useLanguage();
  const router = useRouter();
  const { accessToken } = useAuth();
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTicket, setSelectedTicket] = useState<SupportTicket | null>(
    null
  );
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // Create ticket form state
  const [newTicket, setNewTicket] = useState({
    type: "",
    subject: "",
    description: "",
    jobId: "",
    reportedPhone: "",
    screenshots: [] as string[],
  });
  const [creating, setCreating] = useState(false);

  // Fetch tickets
  const fetchTickets = useCallback(async () => {
    try {
      if (!accessToken) {
        Alert.alert(t('support_error_title'), t('support_error_no_token'));
        return;
      }

      const res = await api.get(`/support/tickets`);
      const data = res.data;

      if (data.success) {
        setTickets(data.tickets || []);
        console.log(`📋 Loaded ${data.tickets.length} support tickets`);
      } else {
        Alert.alert(t('support_error_title'), data.message || t('support_error_load'));
      }
    } catch (error) {
      console.error("Fetch tickets error:", error);
      Alert.alert(t('support_error_title'), t('support_error_load'));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [accessToken]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchTickets();
  }, []);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      fetchTickets();
    }, [fetchTickets])
  );

  // Pick screenshot
  const pickScreenshot = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        // In real app, upload to cloud and get URL
        // For now, use local URI
        setNewTicket((prev) => ({
          ...prev,
          screenshots: [...prev.screenshots, result.assets[0].uri],
        }));
      }
    } catch (error) {
      console.error("Pick screenshot error:", error);
      Alert.alert(t('support_error_title'), t('support_error_pick_image'));
    }
  };

  // Create support ticket
  const handleCreateTicket = async () => {
    if (!newTicket.type || !newTicket.subject || !newTicket.description) {
      Alert.alert(t('support_error_title'), t('support_error_fill_fields'));
      return;
    }

    setCreating(true);

    try {
      if (!accessToken) return;

      const res = await api.post(`/support/create`, {
        type: newTicket.type,
        subject: newTicket.subject,
        description: newTicket.description,
        jobId: newTicket.jobId || undefined,
        reportedPhone: newTicket.reportedPhone || undefined,
        screenshots: newTicket.screenshots,
      });

      const data = res.data;
      setCreating(false);

      if (data.success) {
        Alert.alert(t('support_success_title'), `${t('support_success_message')} ${data.ticket.ticketId}`);
        setShowCreateModal(false);
        setNewTicket({
          type: "",
          subject: "",
          description: "",
          jobId: "",
          reportedPhone: "",
          screenshots: [],
        });
        fetchTickets();
      } else {
        Alert.alert(t('support_error_title'), data.message || t('support_error_create'));
      }
    } catch (error) {
      setCreating(false);
      console.error("Create ticket error:", error);
      Alert.alert(t('support_error_title'), t('support_error_create'));
    }
  };

  // View ticket details
  const viewTicketDetails = async (ticketId: string) => {
    try {
      if (!accessToken) return;

      const res = await api.get(`/support/ticket/${ticketId}`);
      const data = res.data;

      if (data.success) {
        setSelectedTicket(data.ticket);
        setShowDetailModal(true);
      } else {
        Alert.alert(t('support_error_title'), t('support_error_ticket_details'));
      }
    } catch (error) {
      console.error("Fetch ticket details error:", error);
      Alert.alert(t('support_error_title'), t('support_error_ticket_details'));
    }
  };

  // Render ticket item
  const renderTicketItem = ({ item }: { item: SupportTicket }) => {
    const statusInfo = TICKET_STATUSES[item.status as keyof typeof TICKET_STATUSES] || { label: item.status, color: "#666", icon: "info" };
    const typeInfo = TICKET_TYPES.find((t) => t.id === item.type);
    const daysAgo = Math.floor(
      (Date.now() - new Date(item.createdAt).getTime()) / (1000 * 60 * 60 * 24)
    );

    return (
      <TouchableOpacity
        style={styles.ticketItem}
        onPress={() => viewTicketDetails(item.ticketId)}
      >
        <View style={styles.ticketHeader}>
          <View style={styles.ticketInfo}>
            <Text style={styles.ticketId}>{item.ticketId}</Text>
            <Text style={styles.ticketSubject}>{item.subject}</Text>
            <Text style={styles.ticketDate}>
              {daysAgo === 0 ? t('support_today') : t('support_days_ago', {days: daysAgo})}
            </Text>
          </View>
          <View
            style={[
              styles.statusBadge,
              { backgroundColor: statusInfo.color + "20" },
            ]}
          >
            <MaterialIcons
              name={statusInfo.icon as any}
              size={16}
              color={statusInfo.color}
            />
            <Text style={[styles.statusText, { color: statusInfo.color }]}>
              {statusInfo.label}
            </Text>
          </View>
        </View>

        <View style={styles.ticketFooter}>
          <Text style={styles.ticketType}>{typeInfo?.label || item.type}</Text>
          <MaterialIcons name="arrow-forward" size={18} color="#9CA3AF" />
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#667eea" />
        <Text style={styles.loadingText}>{t('support_loading')}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#667eea", "#A78BFA"]} style={styles.header}>
        <View style={styles.headerTop}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('support_title')}</Text>
          <View style={{ width: 40 }} />
        </View>
      </LinearGradient>

      {/* Tickets List */}
      {tickets.length > 0 ? (
        <FlatList
          data={tickets}
          renderItem={renderTicketItem}
          keyExtractor={(item) => item._id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                fetchTickets();
              }}
              colors={["#667eea"]}
            />
          }
        />
      ) : (
        <View style={styles.emptyContainer}>
          <MaterialIcons name="support-agent" size={80} color="#D1D5DB" />
          <Text style={styles.emptyTitle}>{t('support_no_tickets')}</Text>
          <Text style={styles.emptyText}>{t('support_no_tickets_desc')}</Text>
        </View>
      )}

      {/* Create Ticket Button */}
      <TouchableOpacity
        style={styles.createBtn}
        onPress={() => setShowCreateModal(true)}
      >
        <MaterialIcons name="add" size={24} color="#fff" />
        <Text style={styles.createBtnText}>{t('support_create_ticket')}</Text>
      </TouchableOpacity>

      {/* Create Ticket Modal */}
      <Modal visible={showCreateModal} animationType="slide" transparent>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            {/* Modal Header */}
            <LinearGradient
              colors={["#667eea", "#A78BFA"]}
              style={styles.modalHeader}
            >
              <TouchableOpacity
                onPress={() => setShowCreateModal(false)}
                style={styles.closeBtn}
              >
                <Ionicons name="close" size={24} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.modalTitle}>Create Support Ticket</Text>
                          <Text style={styles.modalTitle}>{t('support_modal_title')}</Text>
              <View style={{ width: 40 }} />
            </LinearGradient>

            <ScrollView style={styles.modalBody}>
              {/* Ticket Type */}
              <Text style={styles.label}>Issue Type *</Text>
                            <Text style={styles.label}>{t('support_issue_type')}</Text>
              <View style={styles.typeGrid}>
                {TICKET_TYPES.map((type) => (
                  <TouchableOpacity
                    key={type.id}
                    style={[
                      styles.typeBtn,
                      newTicket.type === type.id && styles.typeBtnSelected,
                    ]}
                    onPress={() => setNewTicket({ ...newTicket, type: type.id })}
                  >
                    <Text style={styles.typeLabel}>{type.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Subject */}
              <Text style={styles.label}>Subject *</Text>
                            <Text style={styles.label}>{t('support_subject')}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('support_subject_placeholder')}
                placeholderTextColor="#9CA3AF"
                value={newTicket.subject}
                onChangeText={(text) =>
                  setNewTicket({ ...newTicket, subject: text })
                }
              />

              {/* Description */}
              <Text style={styles.label}>Description *</Text>
                            <Text style={styles.label}>{t('support_description')}</Text>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder={t('support_description_placeholder')}
                placeholderTextColor="#9CA3AF"
                value={newTicket.description}
                onChangeText={(text) =>
                  setNewTicket({ ...newTicket, description: text })
                }
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />

              {/* Optional Fields */}
              <Text style={styles.label}>Related Job ID (Optional)</Text>
                            <Text style={styles.label}>{t('support_jobid_optional')}</Text>
              <TextInput
                style={styles.input}
                placeholder={t('support_jobid_placeholder')}
                placeholderTextColor="#9CA3AF"
                value={newTicket.jobId}
                onChangeText={(text) =>
                  setNewTicket({ ...newTicket, jobId: text })
                }
              />

              {/* Screenshots */}
              <Text style={styles.label}>Screenshots (Optional)</Text>
                            <Text style={styles.label}>{t('support_screenshots_optional')}</Text>
              <TouchableOpacity
                style={styles.uploadScreenBtn}
                onPress={pickScreenshot}
              >
                <MaterialIcons name="add-a-photo" size={24} color="#667eea" />
                <Text style={styles.uploadScreenText}>Add Screenshot</Text>
                              <Text style={styles.uploadScreenText}>{t('support_add_screenshot')}</Text>
              </TouchableOpacity>

              {newTicket.screenshots.length > 0 && (
                <View style={styles.screenshotsList}>
                  {newTicket.screenshots.map((uri, idx) => (
                    <View key={idx} style={styles.screenshotItem}>
                      <Image
                        source={{ uri }}
                        style={styles.screenshotThumb}
                      />
                      <TouchableOpacity
                        onPress={() => {
                          setNewTicket((prev) => ({
                            ...prev,
                            screenshots: prev.screenshots.filter(
                              (_, i) => i !== idx
                            ),
                          }));
                        }}
                        style={styles.removeScreenBtn}
                      >
                        <MaterialIcons name="close" size={18} color="#EF4444" />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => setShowCreateModal(false)}
                >
                  <Text style={styles.cancelBtnText}>{t('support_cancel')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.submitBtn,
                    creating && { opacity: 0.6 },
                  ]}
                  onPress={handleCreateTicket}
                  disabled={creating}
                >
                  {creating ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.submitBtnText}>{t('support_submit')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Ticket Details Modal */}
      {selectedTicket && (
        <Modal visible={showDetailModal} animationType="slide" transparent>
          <View style={styles.modalContainer}>
            <View style={styles.modalContent}>
              {/* Modal Header */}
              <LinearGradient
                colors={["#667eea", "#A78BFA"]}
                style={styles.modalHeader}
              >
                <TouchableOpacity
                  onPress={() => setShowDetailModal(false)}
                  style={styles.closeBtn}
                >
                  <Ionicons name="close" size={24} color="#fff" />
                </TouchableOpacity>
                <Text style={styles.modalTitle}>Ticket Details</Text>
                                <Text style={styles.modalTitle}>{t('support_details_title')}</Text>
                <View style={{ width: 40 }} />
              </LinearGradient>

              <ScrollView style={styles.modalBody}>
                {/* Ticket ID */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Ticket ID</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_ticketid')}</Text>
                  <Text style={styles.detailValue}>{selectedTicket.ticketId}</Text>
                </View>

                {/* Status */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Status</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_status')}</Text>
                  <View
                    style={[
                      styles.statusBadge,
                      {
                        backgroundColor: (TICKET_STATUSES[selectedTicket.status as keyof typeof TICKET_STATUSES]?.color || "#666") + "20",
                      },
                    ]}
                  >
                    <Text
                      style={{
                        color:
                          TICKET_STATUSES[selectedTicket.status as keyof typeof TICKET_STATUSES]?.color || "#666",
                        fontWeight: "700",
                      }}
                    >
                      {TICKET_STATUSES[selectedTicket.status as keyof typeof TICKET_STATUSES]?.label || selectedTicket.status}
                    </Text>
                  </View>
                </View>

                {/* Type */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Issue Type</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_type')}</Text>
                  <Text style={styles.detailValue}>
                    {TICKET_TYPES.find((t) => t.id === selectedTicket.type)
                      ?.label || selectedTicket.type}
                  </Text>
                </View>

                {/* Subject */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Subject</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_subject')}</Text>
                  <Text style={styles.detailValue}>{selectedTicket.subject}</Text>
                </View>

                {/* Description */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Description</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_description')}</Text>
                  <Text style={styles.detailValue}>
                    {selectedTicket.description}
                  </Text>
                </View>

                {/* Date Created */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>Created</Text>
                                    <Text style={styles.detailLabel}>{t('support_detail_created')}</Text>
                  <Text style={styles.detailValue}>
                    {new Date(selectedTicket.createdAt).toLocaleDateString(
                      "en-IN"
                    )}{" "}
                    {new Date(selectedTicket.createdAt).toLocaleTimeString(
                      "en-IN"
                    )}
                  </Text>
                </View>

                {/* Resolution */}
                {selectedTicket.resolution && (
                  <View style={styles.detailSection}>
                    <Text style={styles.detailLabel}>Resolution</Text>
                                        <Text style={styles.detailLabel}>{t('support_detail_resolution')}</Text>
                    <Text style={styles.detailValue}>
                      {selectedTicket.resolution}
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>
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
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 100,
  },
  ticketItem: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  ticketHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 12,
  },
  ticketInfo: {
    flex: 1,
  },
  ticketId: {
    fontSize: 12,
    fontWeight: "700",
    color: "#667eea",
    marginBottom: 4,
  },
  ticketSubject: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 4,
  },
  ticketDate: {
    fontSize: 12,
    color: "#9CA3AF",
  },
  statusBadge: {
    flexDirection: "row",
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    alignItems: "center",
    gap: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: "700",
  },
  ticketFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
  },
  ticketType: {
    fontSize: 12,
    color: "#6B7280",
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
  createBtn: {
    position: "absolute",
    bottom: 24,
    right: 24,
    flexDirection: "row",
    backgroundColor: "#6C63FF",
    borderRadius: 28,
    paddingHorizontal: 24,
    paddingVertical: 14,
    alignItems: "center",
    gap: 8,
    elevation: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
  },
  createBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  modalContainer: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalContent: {
    flex: 1,
    backgroundColor: "#fff",
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: 40,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 16,
  },
  closeBtn: {
    padding: 8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    textAlign: "center",
  },
  modalBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 8,
    marginTop: 12,
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  typeBtn: {
    flex: 1,
    minWidth: "48%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#E9D5FF",
    alignItems: "center",
  },
  typeBtnSelected: {
    backgroundColor: "#E9D5FF",
    borderColor: "#6C63FF",
  },
  typeLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6C63FF",
    textAlign: "center",
  },
  input: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: "#1F2937",
    marginBottom: 8,
  },
  textarea: {
    minHeight: 100,
    paddingTop: 10,
  },
  uploadScreenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#E9D5FF",
    gap: 8,
    marginBottom: 8,
  },
  uploadScreenText: {
    color: "#6C63FF",
    fontSize: 14,
    fontWeight: "600",
  },
  screenshotsList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
  },
  screenshotItem: {
    position: "relative",
    width: "30%",
    aspectRatio: 1,
  },
  screenshotThumb: {
    width: "100%",
    height: "100%",
    borderRadius: 8,
  },
  removeScreenBtn: {
    position: "absolute",
    top: 4,
    right: 4,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 4,
  },
  modalFooter: {
    flexDirection: "row",
    gap: 12,
    marginTop: 20,
    marginBottom: 20,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#E5E7EB",
    alignItems: "center",
  },
  cancelBtnText: {
    color: "#6B7280",
    fontSize: 16,
    fontWeight: "700",
  },
  submitBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 8,
    backgroundColor: "#6C63FF",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  detailSection: {
    marginBottom: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  detailLabel: {
    fontSize: 12,
    color: "#9CA3AF",
    marginBottom: 4,
    fontWeight: "600",
  },
  detailValue: {
    fontSize: 14,
    color: "#1F2937",
    fontWeight: "500",
    lineHeight: 20,
  },
});
