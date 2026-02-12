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
  FlatList,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter, useFocusEffect } from "expo-router";
import { useAuth } from "../context/AuthContext";
import * as ImagePicker from "expo-image-picker";
import { SERVER_URL } from "../utils/config";
import api from "../utils/api";

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
  { id: "driver_license", label: "Driver License", icon: "directions-car" },
  { id: "voter_id", label: "Voter ID", icon: "how-to-vote" },
  { id: "bank_account", label: "Bank Account", icon: "account-balance" },
  { id: "gst", label: "GST Certificate", icon: "business" },
];

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
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
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
        aspect: [4, 3],
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
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

  // Upload document using multipart/form-data (preferred for mobile)
  const uploadDocument = async () => {
    if (!selectedDocType || !selectedFile || !token) {
      Alert.alert("Error", "Please select document type and file");
      return;
    }

    setUploading(true);

    try {
      const form = new FormData();
      form.append('type', selectedDocType);
      form.append('documentNumber', `DOC-${Date.now()}`);
      form.append('expiryDate', new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString());

      // For React Native / Expo, append the file object with uri, name, type
      form.append('file' as any, {
        uri: selectedFile.uri,
        name: selectedFile.name || `doc_${Date.now()}.jpg`,
        type: selectedFile.type || 'image/jpeg',
      } as any);

      const response = await fetch(`${SERVER_URL}/verification/upload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          // Do NOT set Content-Type; fetch will set multipart boundary
        },
        body: form as any,
      });

      const data = await response.json().catch(() => ({ success: false, message: 'Invalid response' }));
      setUploading(false);

      if (response.ok && data.success) {
        Alert.alert('Success', 'Document uploaded for verification!');
        setSelectedDocType(null);
        setSelectedFile(null);
        fetchVerificationStatus();
      } else {
        Alert.alert('Error', data.message || 'Failed to upload document');
      }
    } catch (error) {
      setUploading(false);
      console.error('Upload document error:', error);
      Alert.alert('Error', 'Failed to upload document');
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
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#667eea" />
        <Text style={styles.loadingText}>Loading verification status...</Text>
      </View>
    );
  }

  const documentList =
    verificationStatus?.documents || [];
  const isFullyVerified =
    verificationStatus?.accountStatus === "active" &&
    verificationStatus?.kycStatus === "complete";

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#667eea", "#A78BFA"]} style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          style={styles.backBtn}
        >
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Verification</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      <View style={styles.contentContainer}>
        {/* Account Status Card */}
        {verificationStatus && (
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

          {!selectedDocType ? (
            <View style={styles.docTypeGrid}>
              {DOCUMENT_TYPES.map((doc) => (
                <TouchableOpacity
                  key={doc.id}
                  style={styles.docTypeBtn}
                  onPress={() => setSelectedDocType(doc.id)}
                >
                  <MaterialIcons
                    name={doc.icon as any}
                    size={32}
                    color="#667eea"
                  />
                  <Text style={styles.docTypeLabel}>{doc.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : (
            <View style={styles.uploadProgress}>
              <View style={styles.selectedDoc}>
                <Text style={styles.selectedDocText}>
                  Selected:{" "}
                  {DOCUMENT_TYPES.find((d) => d.id === selectedDocType)?.label}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setSelectedDocType(null);
                    setSelectedFile(null);
                  }}
                >
                  <MaterialIcons name="close" size={24} color="#EF4444" />
                </TouchableOpacity>
              </View>

              {selectedFile ? (
                <View style={styles.fileSelected}>
                  <Image
                    source={{ uri: selectedFile.uri }}
                    style={styles.docPreview}
                  />
                  <Text style={styles.fileSelectedText}>File selected ✓</Text>
                  <TouchableOpacity
                    style={styles.removeFileBtn}
                    onPress={() => setSelectedFile(null)}
                  >
                    <Text style={styles.removeFileText}>Change File</Text>
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
                  !selectedFile && { opacity: 0.5 },
                ]}
                onPress={uploadDocument}
                disabled={!selectedFile || uploading}
              >
                {uploading ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <MaterialIcons name="cloud-upload" size={20} color="#fff" />
                    <Text style={styles.uploadBtnText}>Upload Document</Text>
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

        {/* Information Box */}
        <View style={styles.infoBox}>
          <MaterialIcons name="info" size={24} color="#3B82F6" />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Why Verification?</Text>
            <Text style={styles.infoText}>
              We verify documents to ensure safety and build trust in our
              community. Your account has restrictions until verification is
              complete.
            </Text>
          </View>
        </View>

        {/* Tips */}
        <View style={styles.tipsBox}>
          <Text style={styles.tipsTitle}>💡 Tips for Verification</Text>
          <Text style={styles.tipItem}>
            ✓ Ensure all document details are clearly visible
          </Text>
          <Text style={styles.tipItem}>
            ✓ Good lighting helps our system verify faster
          </Text>
          <Text style={styles.tipItem}>
            ✓ Verification usually takes 24-48 hours
          </Text>
          <Text style={styles.tipItem}>
            ✓ You'll receive notification once verified
          </Text>
        </View>

        <View style={styles.bottomPadding} />
      </View>
    </ScrollView>
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
    paddingBottom: 20,
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
  contentContainer: {
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  statusCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderTopWidth: 4,
  },
  statusHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  statusTitle: {
    fontSize: 14,
    color: "#9CA3AF",
    marginBottom: 4,
  },
  statusBadge: {
    fontSize: 18,
    fontWeight: "700",
  },
  restrictionText: {
    marginTop: 12,
    fontSize: 13,
    color: "#F59E0B",
    lineHeight: 20,
  },
  progressCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  progressHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  progressTitle: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1F2937",
  },
  progressPercent: {
    fontSize: 18,
    fontWeight: "700",
    color: "#667eea",
  },
  progressBar: {
    height: 8,
    backgroundColor: "#E5E7EB",
    borderRadius: 4,
    overflow: "hidden",
    marginBottom: 8,
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#10B981",
  },
  progressText: {
    fontSize: 12,
    color: "#6B7280",
  },
  uploadCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#1F2937",
    marginBottom: 16,
  },
  docTypeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
  },
  docTypeBtn: {
    width: "48%",
    backgroundColor: "#F3F0FF",
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#E9D5FF",
  },
  docTypeLabel: {
    marginTop: 8,
    fontSize: 12,
    fontWeight: "600",
    color: "#667eea",
    textAlign: "center",
  },
  uploadProgress: {
    gap: 12,
  },
  selectedDoc: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
  },
  selectedDocText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#6C63FF",
  },
  fileSelected: {
    alignItems: "center",
    paddingVertical: 16,
  },
  docPreview: {
    width: 120,
    height: 120,
    borderRadius: 8,
    marginBottom: 8,
  },
  fileSelectedText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#10B981",
    marginBottom: 8,
  },
  removeFileBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#EF4444",
  },
  removeFileText: {
    color: "#EF4444",
    fontSize: 13,
    fontWeight: "600",
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
    paddingVertical: 12,
    backgroundColor: "#F3F0FF",
    borderRadius: 8,
    gap: 6,
  },
  pickerBtnText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#667eea",
  },
  uploadBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    backgroundColor: "#667eea",
    borderRadius: 8,
    gap: 8,
  },
  uploadBtnText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  documentsCard: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  documentItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  docItemLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  docStatusIcon: {
    width: 48,
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  docName: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1F2937",
  },
  docDate: {
    fontSize: 12,
    color: "#9CA3AF",
    marginTop: 2,
  },
  docStatus: {
    fontSize: 12,
    fontWeight: "700",
  },
  infoBox: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#DBEAFE",
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#1E40AF",
    marginBottom: 4,
  },
  infoText: {
    fontSize: 12,
    color: "#1E40AF",
    lineHeight: 18,
  },
  tipsBox: {
    backgroundColor: "#FEF3C7",
    borderRadius: 12,
    padding: 14,
    marginBottom: 24,
  },
  tipsTitle: {
    fontSize: 14,
    fontWeight: "700",
    color: "#92400E",
    marginBottom: 8,
  },
  tipItem: {
    fontSize: 12,
    color: "#92400E",
    marginBottom: 6,
    lineHeight: 18,
  },
  bottomPadding: {
    height: 40,
  },
});
