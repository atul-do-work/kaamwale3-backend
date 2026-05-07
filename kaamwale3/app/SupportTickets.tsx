import React, { useEffect, useState, useCallback, useRef } from "react";
import { useLanguage } from "../context/LanguageContext";
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

import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "../context/AuthContext";
import * as ImagePicker from "expo-image-picker";
import { uploadToCloudinaryDirect } from "../utils/cloudinaryDirectUpload";
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
  const [charCounts, setCharCounts] = useState({ subject: 0, description: 0 });
  const isFetchingRef = useRef(false);

  // Fetch tickets (locked to avoid duplicate concurrent calls)
  const fetchTickets = useCallback(async () => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    try {
      if (!accessToken) {
        Alert.alert(t('support_error_title'), t('support_error_no_token'));
        return;
      }

      const res = await api.get(`/support/tickets`);
      const data = res.data;

      if (data.success) {
        const next = data.tickets || [];
        setTickets((prev) => (JSON.stringify(prev) !== JSON.stringify(next) ? next : prev));
        console.log(`📋 Loaded ${next.length} support tickets`);
      } else {
        Alert.alert(t('support_error_title'), data.message || t('support_error_load'));
      }
    } catch (error) {
      console.error("Fetch tickets error:", error);
      Alert.alert(t('support_error_title'), t('support_error_load'));
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  }, [accessToken]);

  // Load on focus (covers first mount and when returning to screen)
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchTickets();
    }, [fetchTickets])
  );

  // Pick screenshot
  const pickScreenshot = async () => {
    try {
      // ✅ Check screenshot limit
      if (newTicket.screenshots.length >= 5) {
        Alert.alert(t('support_error_title'), t('support_max_screenshots') || 'Maximum 5 screenshots allowed');
        return;
      }

      // ✅ Request media library permissions
      const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permissionResult.granted) {
        Alert.alert(
          t('support_error_title'),
          t('support_permission_required') || 'Media library permission is required'
        );
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets?.[0]) {
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

  const uploadSupportScreenshot = async (uri: string) => {
    if (!uri) throw new Error('Invalid screenshot');
    if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;

    const uploadResult = await uploadToCloudinaryDirect(
      uri,
      'kaamwale/support',
      `support-screenshot-${Date.now()}`,
      {
        uploadType: 'support',
        authToken: accessToken || undefined,
        maxRetries: 3,
      }
    );

    if (!uploadResult.success) {
      throw new Error(uploadResult.error || 'Failed to upload screenshot');
    }

    const screenshotUrl = uploadResult.fileUrl || uploadResult.url;
    if (!screenshotUrl) {
      throw new Error('Failed to upload screenshot');
    }
    return screenshotUrl;
  };

  // Create support ticket
  const handleCreateTicket = async () => {
    // ✅ Prevent double submission
    if (creating) return;

    const subjectText = newTicket.subject?.trim?.() || "";
    const descriptionText = newTicket.description?.trim?.() || "";

    if (!newTicket.type || !subjectText || !descriptionText) {
      Alert.alert(
        t('support_error_title'),
        `Please select an issue type and fill in the subject and description.`
      );
      return;
    }

    if (subjectText.length < 5 || descriptionText.length < 15) {
      Alert.alert(
        t('support_error_title'),
        `Subject must be at least 5 characters and description at least 15 characters.`
      );
      return;
    }

    if (newTicket.reportedPhone && !/^[0-9]{10}$/.test(newTicket.reportedPhone.trim())) {
        Alert.alert(t('support_error_title'), 'Reported phone must be 10 digits');
        return;
      }
    setCreating(true);

    try {
      if (!accessToken) {
        throw new Error(t('support_error_no_token') || 'Authentication required');
      }

      const screenshots = await Promise.all(
        newTicket.screenshots.map(async (uri) => {
          const screenshotUrl = await uploadSupportScreenshot(uri);
          if (!screenshotUrl) throw new Error('Screenshot upload failed');
          return screenshotUrl;
        })
      );

      const res = await api.post(`/support/create`, {
        type: newTicket.type,
        subject: newTicket.subject.trim(),
        description: newTicket.description.trim(),
        jobId: newTicket.jobId?.trim() || undefined,
        reportedPhone: newTicket.reportedPhone?.trim() || undefined,
        screenshots,
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
      console.error("Create ticket error:", error);
      Alert.alert(t('support_error_title'), (error as any)?.message || t('support_error_create'));
    } finally {
      setCreating(false);
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

  // ✅ Render ticket item with useCallback for performance
  const renderTicketItem = useCallback(({ item }: { item: SupportTicket }) => {
    const statusInfo = TICKET_STATUSES[item.status as keyof typeof TICKET_STATUSES] || { label: item.status, color: "#666", icon: "info" };
    const typeInfo = TICKET_TYPES.find((t) => t.id === item.type);
    // ✅ Better days ago calculation (by date only, not exact time)
    const createdDate = new Date(item.createdAt);
    const today = new Date();
    createdDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const daysAgo = Math.floor((today.getTime() - createdDate.getTime()) / (1000 * 60 * 60 * 24));

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
              {daysAgo === 0 ? t('support_today') : `${daysAgo} days ago`}
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
  }, []);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#667eea" />
        <Text style={styles.loadingText}>{t('support_loading')}</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.headerWrapper}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={24} color="#111827" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('support_title')}</Text>
          <View style={{ width: 40 }} />
        </View>
      </View>

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
              onRefresh={async () => {
                setRefreshing(true);
                await fetchTickets();
                setRefreshing(false);
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
            <View style={styles.modalHeaderWrapper}>
              <View style={styles.modalHeader}>
                <TouchableOpacity
                  onPress={() => setShowCreateModal(false)}
                  style={styles.closeBtn}
                >
                  <Ionicons name="close" size={24} color="#111827" />
                </TouchableOpacity>
                <Text style={styles.modalTitle}>{t('support_modal_title')}</Text>
                <View style={{ width: 40 }} />
              </View>
            </View>

            <ScrollView style={styles.modalBody}>
              {/* Ticket Type */}
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
              <View style={styles.labelRow}>
                <Text style={styles.label}>{t('support_subject')}</Text>
                <Text style={styles.charCount}>{charCounts.subject} / 120</Text>
              </View>
              <TextInput
                style={styles.input}
                placeholder={t('support_subject_placeholder')}
                placeholderTextColor="#9CA3AF"
                value={newTicket.subject}
                maxLength={120}
                onChangeText={(text) => {
                  setNewTicket({ ...newTicket, subject: text });
                  setCharCounts(prev => ({ ...prev, subject: text.length }));
                }}
              />

              {/* Description */}
              <View style={styles.labelRow}>
                <Text style={styles.label}>{t('support_description')}</Text>
                <Text style={styles.charCount}>{charCounts.description} / 2000</Text>
              </View>
              <TextInput
                style={[styles.input, styles.textarea]}
                placeholder={t('support_description_placeholder')}
                placeholderTextColor="#9CA3AF"
                value={newTicket.description}
                maxLength={2000}
                onChangeText={(text) => {
                  setNewTicket({ ...newTicket, description: text });
                  setCharCounts(prev => ({ ...prev, description: text.length }));
                }}
                multiline
                numberOfLines={5}
                textAlignVertical="top"
              />

              {/* Optional Fields */}
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
              <View style={styles.modalHeaderWrapper}>
                <View style={styles.modalHeader}>
                  <TouchableOpacity
                    onPress={() => {
                      setShowDetailModal(false);
                      setSelectedTicket(null);
                    }}
                    style={styles.closeBtn}
                  >
                    <Ionicons name="close" size={24} color="#fff" />
                  </TouchableOpacity>
                  <Text style={styles.modalTitle}>{t('support_details_title')}</Text>
                  <View style={{ width: 40 }} />
                </View>
              </View>

              <ScrollView style={styles.modalBody}>
                {/* Ticket ID */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>{t('support_detail_ticketid')}</Text>
                  <Text style={styles.detailValue}>{selectedTicket.ticketId}</Text>
                </View>

                {/* Status */}
                <View style={styles.detailSection}>
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
                  <Text style={styles.detailLabel}>{t('support_detail_type')}</Text>
                  <Text style={styles.detailValue}>
                    {TICKET_TYPES.find((t) => t.id === selectedTicket.type)
                      ?.label || selectedTicket.type}
                  </Text>
                </View>

                {/* Subject */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>{t('support_detail_subject')}</Text>
                  <Text style={styles.detailValue}>{selectedTicket.subject}</Text>
                </View>

                {/* Description */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>{t('support_detail_description')}</Text>
                  <Text style={styles.detailValue}>
                    {selectedTicket.description}
                  </Text>
                </View>

                {/* Date Created */}
                <View style={styles.detailSection}>
                  <Text style={styles.detailLabel}>{t('support_detail_created')}</Text>
                  <Text style={styles.detailValue}>
                    {new Date(selectedTicket.createdAt).toLocaleDateString()}{" "}
                    {new Date(selectedTicket.createdAt).toLocaleTimeString()}
                  </Text>
                </View>

                {/* Resolution */}
                {selectedTicket.resolution && (
                  <View style={styles.detailSection}>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  centerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#F1F5F9",
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
    color: "#666",
  },
  headerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    backgroundColor: "#F1F5F9",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    shadowColor: "#0f172a",
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 4,
  },
  backBtn: {
    padding: 8,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#1a2f4d",
    flex: 1,
    textAlign: "center",
  },
  listContent: {
    paddingHorizontal: 12,
    paddingTop: 16,
    paddingBottom: 120,
  },
  ticketItem: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    marginBottom: 10,
    shadowColor: "#0f172a",
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 2,
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
    paddingHorizontal: 24,
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
    bottom: 32,
    right: 24,
    flexDirection: "row",
    backgroundColor: "#1a2f4d",
    borderRadius: 28,
    paddingHorizontal: 24,
    paddingVertical: 14,
    alignItems: "center",
    gap: 8,
    elevation: 6,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
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
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    marginTop: 40,
  },
  modalHeaderWrapper: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 14,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#1a2f4d",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  closeBtn: {
    padding: 10,
    borderRadius: 10,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    textAlign: "center",
  },
  modalBody: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 18,
  },
  label: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 8,
    marginTop: 14,
  },
  labelRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 14,
    marginBottom: 8,
  },
  charCount: {
    fontSize: 12,
    color: "#94A3B8",
    fontWeight: "500",
  },
  typeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    marginBottom: 12,
  },
  typeBtn: {
    flex: 1,
    minWidth: "48%",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#F3F0FF",
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#E9D5FF",
    alignItems: "center",
    marginBottom: 8,
  },
  typeBtnSelected: {
    backgroundColor: "#1a2f4d",
    borderColor: "#1a2f4d",
  },
  typeLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1a2f4d",
    textAlign: "center",
  },
  input: {
    backgroundColor: "#F9FAFB",
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: "#1F2937",
    marginBottom: 12,
  },
  textarea: {
    minHeight: 110,
    paddingTop: 12,
  },
  uploadScreenBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#F3F0FF",
    borderRadius: 10,
    borderWidth: 2,
    borderColor: "#E9D5FF",
    gap: 10,
    marginBottom: 12,
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
    borderRadius: 10,
    overflow: "hidden",
  },
  screenshotThumb: {
    width: "100%",
    height: "100%",
    borderRadius: 10,
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
    gap: 14,
    marginTop: 24,
    marginBottom: 24,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
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
    borderRadius: 10,
    backgroundColor: "#1a2f4d",
    alignItems: "center",
    justifyContent: "center",
  },
  submitBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  detailSection: {
    marginBottom: 18,
    paddingBottom: 14,
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
