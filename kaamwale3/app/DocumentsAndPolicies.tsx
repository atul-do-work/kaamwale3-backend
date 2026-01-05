import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Image,
  Alert,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import { API_BASE } from '../utils/config';

const logActivity = async (action: string, details: string) => {
  try {
    const token = await AsyncStorage.getItem('token');
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
  const [documents, setDocuments] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);

  React.useEffect(() => {
    fetchDocuments();
  }, []);

  const fetchDocuments = async () => {
    try {
      setLoading(true);
      const token = await AsyncStorage.getItem('token');
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
      Alert.alert('Error', 'Failed to pick image');
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
      Alert.alert('Error', 'Failed to take photo');
    }
  };

  const uploadDocument = async (photo: any, documentType: string) => {
    try {
      setUploading(true);
      const token = await AsyncStorage.getItem('token');
      
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
        Alert.alert('Success', `${documentType.toUpperCase()} uploaded successfully!`);
        await logActivity('DOCUMENT_UPLOAD', `Uploaded ${documentType} document`);
        fetchDocuments();
      } else {
        Alert.alert('Error', 'Failed to upload document');
      }
    } catch (err) {
      Alert.alert('Error', 'Upload failed. Please try again.');
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
    <View style={styles.container}>
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
    </View>
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
});
