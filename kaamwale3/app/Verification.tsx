import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Image,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "../context/AuthContext";
import * as ImagePicker from "expo-image-picker";
import { getFileInfo, readFileAsBase64 } from "../utils/fileSystem";
import { SERVER_URL } from "../utils/config";
import api from "../utils/api";
import { uploadToCloudinaryDirect } from "../utils/cloudinaryDirectUpload";
import { SafeAreaView } from "react-native-safe-area-context";

interface VerificationDocument {
  type: string;
  fileUrl: string;
  fileName: string;
  uploadedAt: string;
  verificationStatus: "pending" | "approved" | "rejected" | "expired";
  documentNumber?: string;
  expiryDate?: string;
}

interface VerificationStatus {
  phone: string;
  documents: VerificationDocument[];
  overallVerificationStatus: string;
  kycStatus: string;
  backgroundCheckPassed: boolean;
  accountStatus: "active" | "restricted" | "suspended" | "banned";
  verifiedAt?: string;
}

const DOCUMENT_TYPES = [
  { id: "aadhar", label: "Aadhar Card", icon: "credit-card" },
  { id: "pan", label: "PAN Card", icon: "credit-card" },
  { id: "voter", label: "Voter ID", icon: "how-to-vote" },
  { id: "bank_account", label: "Bank Account", icon: "account-balance" },
];

const VERIFICATION_FILE_SIZE_LIMIT = 4 * 1024 * 1024; // 4MB

async function getFileSize(uri: string) {
  try {
    const fileInfo = await getFileInfo(uri);
    const size = typeof fileInfo.size === 'number' ? fileInfo.size : 0;
    if (size > 0) return size;
    
    // Fallback: read as base64 to estimate size
    const base64 = await readFileAsBase64(uri);
    return Math.ceil((base64.length * 3) / 4);
  } catch (err) {
    console.warn("Failed to read file size", err);
    return 0;
  }
}

async function validateVerificationFile(uri: string) {
  const size = await getFileSize(uri);
  if (!size) {
    return { valid: false, message: "Unable to read selected file. Please choose another image." };
  }
  if (size > VERIFICATION_FILE_SIZE_LIMIT) {
    return {
      valid: false,
      message: "Selected file is too large. Please choose an image smaller than 4MB.",
    };
  }
  return { valid: true, size };
}

export default function VerificationScreen(): React.ReactElement {
  const router = useRouter();
  const { accessToken } = useAuth();
  const [verificationStatus, setVerificationStatus] =
    useState<VerificationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [selectedDocType, setSelectedDocType] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<any>(null);

  // Fetch verification status
  const fetchVerificationStatus = useCallback(async () => {
    try {
      if (!accessToken) {
        Alert.alert("Error", "No authentication token found");
        return;
      }

      const res = await api.get(`/verification/status`);
      const data = res.data;

      if (data.success) {
        setVerificationStatus(data.verification);
        console.log(
          `✅ Verification status loaded. Account: ${data.verification.accountStatus}`
        );
      } else {
        console.log("First time verification");
      }
    } catch (error) {
      console.error("Fetch verification status error:", error);
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  // Initial load
  useEffect(() => {
    setLoading(true);
    fetchVerificationStatus();
  }, []);

  // Reload on focus
  useFocusEffect(
    useCallback(() => {
      fetchVerificationStatus();
    }, [fetchVerificationStatus])
  );

  // Pick document from gallery
  const pickDocument = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const validation = await validateVerificationFile(asset.uri);
        if (!validation.valid) {
          Alert.alert("Error", validation.message);
          return;
        }
        setSelectedFile({
          uri: asset.uri,
          type: "image/jpeg",
          name: `doc_${Date.now()}.jpg`,
        });
        console.log("📸 Image selected:", asset.uri);
      }
    } catch (error) {
      console.error("Pick document error:", error);
      Alert.alert("Error", "Failed to pick image");
    }
  };

  // Take photo with camera
  const takePhoto = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission Required", "Camera permission is needed");
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        const validation = await validateVerificationFile(asset.uri);
        if (!validation.valid) {
          Alert.alert("Error", validation.message);
          return;
        }
        setSelectedFile({
          uri: asset.uri,
          type: "image/jpeg",
          name: `doc_${Date.now()}.jpg`,
        });
        console.log("📷 Photo taken:", asset.uri);
      }
    } catch (error) {
      console.error("Take photo error:", error);
      Alert.alert("Error", "Failed to take photo");
    }
  };

  // Upload document using direct Cloudinary storage
  const uploadDocument = async () => {
    if (!selectedDocType || !selectedFile || !accessToken) {
      Alert.alert("Error", "Please select document type and file");
      return;
    }

    setUploading(true);

    try {
      const uploadResult = await uploadToCloudinaryDirect(
        selectedFile.uri,
        'kaamwale/verification',
        `${selectedDocType}_${Date.now()}`,
        {
          uploadType: 'verification',
          authToken: accessToken,
          maxRetries: 3,
        }
      );

      if (!uploadResult.success) {
        throw new Error(uploadResult.error || 'Failed to upload document');
      }

      const response = await fetch(`${SERVER_URL}/verification/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: selectedDocType,
          documentNumber: `DOC-${Date.now()}`,
          expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
          fileUrl: uploadResult.fileUrl || uploadResult.url,
          cloudinaryPublicId: uploadResult.publicId,
        }),
      });

      const data = await response.json().catch(() => ({ success: false, message: 'Invalid response' }));

      if (response.ok && data.success) {
        Alert.alert('Success', 'Your document has been submitted and is under review.');
        setSelectedDocType(null);
        setSelectedFile(null);
        fetchVerificationStatus();
      } else {
        Alert.alert('Error', data.message || 'Failed to submit document');
      }
    } catch (error) {
      console.error('Upload document error:', error);
      Alert.alert('Error', (error as any)?.message || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status) {
      case "approved":
        return "#10B981";
      case "pending":
        return "#F59E0B";
      case "rejected":
        return "#EF4444";
      case "expired":
        return "#6B7280";
      default:
        return "#3B82F6";
    }
  };

  // Get account status color
  const getAccountStatusColor = (status: string) => {
    switch (status) {
      case "active":
        return "#10B981";
      case "restricted":
        return "#F59E0B";
      case "suspended":
        return "#EF4444";
      case "banned":
        return "#7F1D1D";
      default:
        return "#6B7280";
    }
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.centerContainer} edges={['top', 'left', 'right']}>
        <ActivityIndicator size="large" color="#667eea" />
        <Text style={styles.loadingText}>Loading verification status...</Text>
      </SafeAreaView>
    );
  }

  const documentList =
    verificationStatus?.documents || [];
  const alreadySubmittedTypes = documentList
    .filter((doc) =>
      doc.verificationStatus === "pending" ||
      doc.verificationStatus === "approved"
    )
    .map((doc) => doc.type);
  const hasPendingAadhar = documentList.some(
    (doc) => doc.type === "aadhar" && doc.verificationStatus === "pending"
  );
  const showAccountStatusCard =
    verificationStatus?.accountStatus &&
    verificationStatus.accountStatus !== "restricted";

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Verification</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView style={styles.contentWrapper} contentContainerStyle={styles.contentContainer}>
        {/* Account Status Card */}
        {showAccountStatusCard && verificationStatus && (
          <View
            style={[
              styles.statusCard,
              {
                borderTopColor: getAccountStatusColor(
                  verificationStatus.accountStatus
                ),
              },
            ]}
          >
            <View style={styles.statusHeader}>
              <View>
                <Text style={styles.statusTitle}>Account Status</Text>
                <Text
                  style={[
                    styles.statusBadge,
                    {
                      color: getAccountStatusColor(
                        verificationStatus.accountStatus
                      ),
                    },
                  ]}
                >
                  {verificationStatus.accountStatus.toUpperCase()}
                </Text>
              </View>
              <MaterialIcons
                name={
                  verificationStatus.accountStatus === "active"
                    ? "verified-user"
                    : "lock"
                }
                size={40}
                color={getAccountStatusColor(verificationStatus.accountStatus)}
              />
            </View>

            {verificationStatus.accountStatus !== "active" && (
              <Text style={styles.restrictionText}>
                ⚠️ Your account is {verificationStatus.accountStatus}. Complete
                verification to restore full access.
              </Text>
            )}
          </View>
        )}

        {/* Verification Progress */}
        {verificationStatus && (
          <View style={styles.progressCard}>
            <View style={styles.progressHeader}>
              <Text style={styles.progressTitle}>Verification Progress</Text>
              <Text style={styles.progressPercent}>
                {Math.round(
                  (documentList.filter((d) => d.verificationStatus === "approved")
                    .length /
                    Math.max(documentList.length, 1)) *
                    100
                )}
                %
              </Text>
            </View>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${
                      (documentList.filter((d) => d.verificationStatus === "approved")
                        .length /
                        Math.max(documentList.length, 1)) *
                      100
                    }%`,
                  },
                ]}
              />
            </View>
            <Text style={styles.progressText}>
              {documentList.filter((d) => d.verificationStatus === "approved")
                .length}{" "}
              of {documentList.length} documents verified
            </Text>
          </View>
        )}

        {/* Upload New Document */}
        <View style={styles.uploadCard}>
          <Text style={styles.cardTitle}>📄 Upload Document</Text>
          <Text style={styles.uploadHint}>Upload one document at a time. Documents with pending review cannot be re-uploaded.</Text>

          {!selectedDocType ? (
            <View style={styles.docTypeGrid}>
              {DOCUMENT_TYPES.map((doc) => {
                const disabled = alreadySubmittedTypes.includes(doc.id);
                return (
                  <TouchableOpacity
                    key={doc.id}
                    style={[
                      styles.docTypeBtn,
                      disabled && styles.docTypeDisabled,
                    ]}
                    onPress={() => !disabled && setSelectedDocType(doc.id)}
                    disabled={disabled}
                  >
                    <MaterialIcons
                      name={doc.icon as any}
                      size={28}
                      color={disabled ? "#94A3B8" : "#475569"}
                    />
                    <Text style={styles.docTypeLabel}>{doc.label}</Text>
                    {doc.id === "aadhar" && hasPendingAadhar && (
                      <Text style={styles.docTypeNote}>
                        Pending review
                      </Text>
                    )}
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <View style={styles.uploadProgress}>
              <View style={styles.selectedDocRow}>
                <View>
                  <Text style={styles.selectedDocLabel}>Selected document</Text>
                  <Text style={styles.selectedDocText}>{DOCUMENT_TYPES.find((d) => d.id === selectedDocType)?.label}</Text>
                </View>
                <TouchableOpacity onPress={() => { setSelectedDocType(null); setSelectedFile(null); }}>
                  <MaterialIcons name="close" size={20} color="#EF4444" />
                </TouchableOpacity>
              </View>

              {selectedFile ? (
                <View style={styles.fileSelected}>
                  <Image source={{ uri: selectedFile.uri }} style={styles.docPreview} />
                  <Text style={styles.fileSelectedText}>{selectedFile.name || "Document ready to upload"}</Text>
                  <TouchableOpacity style={styles.removeFileBtn} onPress={() => setSelectedFile(null)}>
                    <Text style={styles.removeFileText}>Choose another file</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <View style={styles.filePickerButtons}>
                  <TouchableOpacity
                    style={styles.pickerBtn}
                    onPress={takePhoto}
                  >
                    <MaterialIcons name="camera-alt" size={24} color="#667eea" />
                    <Text style={styles.pickerBtnText}>Take Photo</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.pickerBtn}
                    onPress={pickDocument}
                  >
                    <MaterialIcons name="image" size={24} color="#667eea" />
                    <Text style={styles.pickerBtnText}>Choose from Gallery</Text>
                  </TouchableOpacity>
                </View>
              )}

              <TouchableOpacity
                style={[
                  styles.uploadBtn,
                  (!selectedFile || uploading) && styles.uploadBtnDisabled,
                ]}
                onPress={uploadDocument}
                disabled={!selectedFile || uploading}
              >
                {uploading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="cloud-upload" size={20} color="#fff" />
                    <Text style={styles.uploadBtnText}>Submit</Text>
                  </>
                )}
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Uploaded Documents */}
        {documentList.length > 0 && (
          <View style={styles.documentsCard}>
            <Text style={styles.cardTitle}>✅ Uploaded Documents</Text>

            {documentList.map((doc, idx) => (
              <View key={idx} style={styles.documentItem}>
                <View style={styles.docItemLeft}>
                  <View
                    style={[
                      styles.docStatusIcon,
                      {
                        backgroundColor:
                          getStatusColor(doc.verificationStatus) + "20",
                      },
                    ]}
                  >
                    <MaterialIcons
                      name={
                        doc.verificationStatus === "approved"
                          ? "check-circle"
                          : doc.verificationStatus === "rejected"
                          ? "cancel"
                          : "schedule"
                      }
                      size={24}
                      color={getStatusColor(doc.verificationStatus)}
                    />
                  </View>
                  <View>
                    <Text style={styles.docName}>
                      {DOCUMENT_TYPES.find((d) => d.id === doc.type)?.label ||
                        doc.type}
                    </Text>
                    <Text style={styles.docDate}>
                      Uploaded:{" "}
                      {new Date(doc.uploadedAt).toLocaleDateString("en-IN")}
                    </Text>
                  </View>
                </View>
                <Text
                  style={[
                    styles.docStatus,
                    { color: getStatusColor(doc.verificationStatus) },
                  ]}
                >
                  {doc.verificationStatus.toUpperCase()}
                </Text>
              </View>
            ))}
          </View>
        )}

        <View style={styles.infoRow}>
          <MaterialIcons name="info" size={20} color="#2563EB" />
          <Text style={styles.infoRowText}>
            Verification keeps your account secure and unlocks full access quickly.
          </Text>
        </View>

        <View style={styles.bottomPadding} />
      </ScrollView>
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
    color: "#64748B",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 16,
    paddingBottom: 16,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    marginTop: 16,
    backgroundColor: "#fff",
    borderRadius: 20,
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
    color: "#111827",
    textAlign: "center",
    flex: 1,
  },
  contentWrapper: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 32,
  },
  statusCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    borderTopWidth: 4,
    borderColor: "transparent",
    shadowColor: "#0f172a",
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  statusHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  statusTitle: {
    fontSize: 12,
    color: "#64748B",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  statusBadge: {
    fontSize: 20,
    fontWeight: "800",
  },
  statusGrid: {
    flexDirection: "row",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: 12,
  },
  statusMetric: {
    width: "30%",
  },
  metricLabel: {
    fontSize: 11,
    color: "#94A3B8",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  metricValue: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  restrictionText: {
    marginTop: 14,
    fontSize: 13,
    color: "#475569",
    lineHeight: 20,
  },
  progressCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    shadowColor: "#0f172a",
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 14,
  },
  progressTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#0F172A",
  },
  progressPercent: {
    fontSize: 18,
    fontWeight: "800",
    color: "#2563EB",
  },
  progressBar: {
    height: 10,
    backgroundColor: "#E2E8F0",
    borderRadius: 999,
    overflow: "hidden",
    marginBottom: 10,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#22C55E",
  },
  progressText: {
    fontSize: 13,
    color: "#64748B",
  },
  uploadCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    shadowColor: "#0f172a",
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  uploadHeader: {
    marginBottom: 14,
  },
  uploadHint: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 8,
  },
  docTypeDisabled: {
    opacity: 0.5,
    borderColor: "#CBD5E1",
  },
  docTypeNote: {
    marginTop: 6,
    fontSize: 11,
    color: "#64748B",
    textAlign: "center",
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "800",
    color: "#0F172A",
  },
  docTypeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: 12,
  },
  docTypeBtn: {
    width: "48%",
    backgroundColor: "#EEF2FF",
    borderRadius: 16,
    paddingVertical: 18,
    marginBottom: 12,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#E0E7FF",
  },
  docTypeLabel: {
    marginTop: 10,
    fontSize: 13,
    fontWeight: "700",
    color: "#334155",
    textAlign: "center",
  },
  uploadProgress: {
    gap: 14,
  },
  selectedDocRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 14,
    backgroundColor: "#EEF2FF",
    borderRadius: 14,
  },
  selectedDocLabel: {
    fontSize: 12,
    color: "#475569",
    marginBottom: 4,
  },
  selectedDocText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#0F172A",
  },
  fileSelected: {
    alignItems: "center",
    paddingVertical: 16,
  },
  docPreview: {
    width: 120,
    height: 120,
    borderRadius: 14,
    marginBottom: 10,
    backgroundColor: "#E2E8F0",
  },
  fileSelectedText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1D4ED8",
    marginBottom: 10,
  },
  removeFileBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#CBD5E1",
  },
  removeFileText: {
    color: "#334155",
    fontSize: 13,
    fontWeight: "700",
  },
  filePickerButtons: {
    flexDirection: "row",
    gap: 12,
  },
  pickerBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#EFF6FF",
    borderRadius: 14,
    gap: 8,
  },
  pickerBtnText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#1D4ED8",
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#2563EB",
    borderRadius: 14,
    gap: 10,
  },
  uploadBtnDisabled: {
    opacity: 0.55,
  },
  uploadBtnText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "800",
  },
  documentsCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    shadowColor: "#0f172a",
    shadowOpacity: 0.05,
    shadowRadius: 16,
    elevation: 4,
  },
  documentItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E2E8F0",
  },
  documentMeta: {
    flex: 1,
  },
  docItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  docStatusIcon: {
    width: 44,
    height: 44,
    borderRadius: 12,
    justifyContent: "center",
    alignItems: "center",
  },
  docName: {
    fontSize: 14,
    fontWeight: "800",
    color: "#0F172A",
  },
  docDate: {
    fontSize: 12,
    color: "#64748B",
    marginTop: 4,
  },
  docStatus: {
    fontSize: 12,
    fontWeight: "800",
  },
  infoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: "#E0F2FE",
    borderRadius: 16,
    padding: 14,
    marginBottom: 16,
  },
  infoRowText: {
    flex: 1,
    fontSize: 13,
    color: "#1D4ED8",
    lineHeight: 18,
  },
  emptyStateCard: {
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 20,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 16,
    shadowColor: "#0f172a",
    shadowOpacity: 0.04,
    shadowRadius: 16,
    elevation: 3,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#0F172A",
    marginTop: 10,
  },
  emptyText: {
    fontSize: 13,
    color: "#64748B",
    textAlign: "center",
    marginTop: 6,
    lineHeight: 20,
  },
  bottomPadding: {
    height: 40,
  },
});
