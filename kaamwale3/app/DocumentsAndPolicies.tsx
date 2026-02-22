import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
  Modal,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../context/AuthContext';
import * as ImagePicker from 'expo-image-picker';
import { API_BASE } from '../utils/config';
import { SafeAreaView } from 'react-native-safe-area-context';

const logActivity = async (token: string | null, action: string, details: string) => {
  try {
    await fetch(`${API_BASE}/activity`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        action,
        details,
        timestamp: new Date(),
      }),
    });
  } catch (err) {
    console.error('Activity log error:', err);
  }
};

export default function DocumentsAndPolicies() {
  const router = useRouter();
  const { accessToken } = useAuth();
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  
  // ✅ Modal state for alerts
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<"success" | "error" | "info">("success");
  
  const showModal = (type: "success" | "error" | "info", title: string, message: string) => {
    setModalType(type);
    setModalTitle(title);
    setModalMessage(message);
    setModalVisible(true);
  };

  React.useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const token = accessToken;
      const res = await fetch(`${API_BASE}/verification/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch (err) {
      console.error('Error fetching documents:', err);
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async (documentType: 'aadhar' | 'policy') => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [4, 3],
        quality: 1,
      });

      if (!result.canceled && result.assets) {
        uploadDocument(result.assets[0], documentType);
      }
    } catch (err) {
      showModal('error', 'Error', 'Failed to pick image');
    }
  };

  const takePhoto = async (documentType: 'aadhar' | 'policy') => {
    try {
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [4, 3],
        quality: 1,
      });

      if (!result.canceled && result.assets) {
        uploadDocument(result.assets[0], documentType);
      }
    } catch (err) {
      showModal('error', 'Error', 'Failed to take photo');
    }
  };

  const uploadDocument = async (photo: any, documentType: string) => {
    try {
      setUploading(true);
      const token = accessToken;
      
      const formData = new FormData();
      formData.append('documentType', documentType);
      formData.append('photo', {
        uri: photo.uri,
        type: 'image/jpeg',
        name: `${documentType}_${Date.now()}.jpg`,
      } as any);

      const res = await fetch(`${API_BASE}/verification/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (res.ok) {
        showModal('success', 'Success', `${documentType.toUpperCase()} uploaded successfully!`);
        await logActivity(accessToken, 'DOCUMENT_UPLOAD', `Uploaded ${documentType} document`);
        fetchDocuments();
      } else {
        showModal('error', 'Error', 'Failed to upload document');
      }
    } catch (err) {
      showModal('error', 'Error', 'Upload failed. Please try again.');
      console.error('Upload error:', err);
    } finally {
      setUploading(false);
    }
  };

  const getDocumentStatus = (type: string) => {
    const doc = documents.find(d => d.documentType === type);
    return doc?.status || 'pending';
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'verified':
        return '#27AE60';
      case 'pending':
        return '#F39C12';
      case 'rejected':
        return '#E74C3C';
      default:
        return '#95A5A6';
    }
  };

  const renderDocumentCard = (title: string, type: 'aadhar' | 'policy', icon: string) => {
    const status = getDocumentStatus(type);
    const doc = documents.find(d => d.documentType === type);

    return (
      <View key={type} style={styles.documentCard}>
        <View style={styles.cardHeader}>
          <MaterialIcons name={icon as any} size={32} color="#3498db" />
          <View style={styles.cardTitleSection}>
            <Text style={styles.cardTitle}>{title}</Text>
            <View style={[styles.statusBadge, { backgroundColor: getStatusColor(status) }]}>
              <Text style={styles.statusText}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </Text>
            </View>
          </View>
        </View>

        {doc?.photoUrl && (
          <Image source={{ uri: doc.photoUrl }} style={styles.documentImage} />
        )}

        <View style={styles.documentActions}>
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#3498db' }]}
            onPress={() => takePhoto(type)}
            disabled={uploading}
          >
            <MaterialIcons name="camera-alt" size={20} color="#fff" />
            <Text style={styles.actionButtonText}>Take Photo</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#16A085' }]}
            onPress={() => pickImage(type)}
            disabled={uploading}
          >
            <MaterialIcons name="image" size={20} color="#fff" />
            <Text style={styles.actionButtonText}>Upload</Text>
          </TouchableOpacity>
        </View>

        {doc?.rejectionReason && (
          <View style={styles.rejectionBox}>
            <MaterialIcons name="error" size={20} color="#E74C3C" />
            <Text style={styles.rejectionText}>{doc.rejectionReason}</Text>
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={styles.container}>
      {/* Header with safe area padding */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Documents & Policies</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#3498db" />
        </View>
      ) : (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {/* Info Box */}
          <View style={styles.infoBox}>
            <MaterialIcons name="info" size={24} color="#3498db" />
            <Text style={styles.infoText}>
              Upload verified documents to unlock premium features and build trust with contractors.
            </Text>
          </View>

          {/* Aadhar Card */}
          {renderDocumentCard('Aadhar Card', 'aadhar', 'card-membership')}

          {/* Insurance Policy */}
          {renderDocumentCard('Insurance Policy (90 days)', 'policy', 'policy')}

          {/* Requirements */}
          <View style={styles.requirementsSection}>
            <Text style={styles.requirementsTitle}>Requirements</Text>
            <View style={styles.requirementItem}>
              <MaterialIcons name="check-circle" size={20} color="#27AE60" />
              <Text style={styles.requirementText}>Clear, well-lit photos</Text>
            </View>
            <View style={styles.requirementItem}>
              <MaterialIcons name="check-circle" size={20} color="#27AE60" />
              <Text style={styles.requirementText}>All details must be visible</Text>
            </View>
            <View style={styles.requirementItem}>
              <MaterialIcons name="check-circle" size={20} color="#27AE60" />
              <Text style={styles.requirementText}>Valid and current documents</Text>
            </View>
            <View style={styles.requirementItem}>
              <MaterialIcons name="check-circle" size={20} color="#27AE60" />
              <Text style={styles.requirementText}>Full name must match app profile</Text>
            </View>
          </View>

          {/* Refresh Button */}
          <TouchableOpacity style={styles.refreshButton} onPress={fetchDocuments}>
            <MaterialIcons name="refresh" size={20} color="#fff" />
            <Text style={styles.refreshButtonText}>Refresh Status</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* ✅ Custom Alert Modal */}
      <Modal
        transparent={true}
        animationType="fade"
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            {/* Modal Header with Icon */}
            <View style={[
              styles.modalHeader,
              {
                backgroundColor: modalType === "success" ? "#10B98120" : modalType === "error" ? "#EF444420" : "#3B82F620",
              }
            ]}>
              <View style={[
                styles.modalIconBg,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}>
                <MaterialIcons
                  name={
                    modalType === "success" ? "check-circle" :
                    modalType === "error" ? "error" :
                    "info"
                  }
                  size={32}
                  color="#fff"
                />
              </View>
            </View>

            {/* Modal Content */}
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>{modalTitle}</Text>
              <Text style={styles.modalMessage}>{modalMessage}</Text>
            </View>

            {/* Modal Footer - OK Button */}
            <TouchableOpacity
              style={[
                styles.modalButton,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 12,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  backButton: {
    padding: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerSpacer: {
    width: 44,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#000',
    flex: 1,
    textAlign: 'center',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: {
    flex: 1,
    padding: 16,
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: '#E3F2FD',
    borderRadius: 8,
    padding: 12,
    marginBottom: 20,
    alignItems: 'flex-start',
  },
  infoText: {
    flex: 1,
    marginLeft: 12,
    fontSize: 14,
    color: '#1565C0',
    lineHeight: 20,
  },
  documentCard: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 3,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardTitleSection: {
    marginLeft: 12,
    flex: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#000',
    marginBottom: 4,
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
    alignSelf: 'flex-start',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  documentImage: {
    width: '100%',
    height: 200,
    borderRadius: 8,
    marginBottom: 12,
  },
  documentActions: {
    flexDirection: 'row',
    gap: 10,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: 8,
    gap: 8,
  },
  actionButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  rejectionBox: {
    marginTop: 12,
    flexDirection: 'row',
    backgroundColor: '#FADBD8',
    borderRadius: 8,
    padding: 10,
    alignItems: 'flex-start',
  },
  rejectionText: {
    flex: 1,
    marginLeft: 8,
    fontSize: 13,
    color: '#C0392B',
    lineHeight: 18,
  },
  requirementsSection: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  requirementsTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#000',
    marginBottom: 12,
  },
  requirementItem: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  requirementText: {
    marginLeft: 10,
    fontSize: 14,
    color: '#333',
  },
  refreshButton: {
    flexDirection: 'row',
    backgroundColor: '#3498db',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  refreshButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
    marginLeft: 8,
  },

  // ✅ Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },

  modalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 320,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },

  modalHeader: {
    paddingVertical: 24,
    alignItems: "center",
  },

  modalIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },

  modalContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: "center",
  },

  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 8,
    textAlign: "center",
  },

  modalMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },

  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },

  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
});
