import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  RefreshControl,
  TouchableOpacity,
  ActivityIndicator,
  Image,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';
import { MaterialIcons, FontAwesome5 } from '@expo/vector-icons';
import api from '../utils/api';
import { useLanguage } from '../context/LanguageContext';

type BrowseJob = {
  _id: string;
  title?: string;
  description?: string;
  contractorName?: string;
  location?: string;
  amount?: string | number;
  requiredWorkers?: number;
  workerType?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  imageUrl?: string;
  rating?: number;
  reviewCount?: number;
};

type BrowseJobRequest = {
  _id: string;
  requestId: string;
  status: 'pending' | 'accepted' | 'declined';
  title: string;
  body: string;
  metadata: {
    contractorPhone?: string;
    contractorName?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    requiredWorkers?: number;
    paymentFrequency?: string;
    message?: string;
    siteImageUri?: string;
  };
  createdAt: string;
};

interface Notification {
  _id: string;
  title?: string;
  body?: string;
  type?: string;
  metadata?: {
    requestId?: string;
    responded?: boolean;
    accepted?: boolean;
    contractorPhone?: string;
    contractorName?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    location?: string;
    requiredWorkers?: number;
    paymentFrequency?: string;
    message?: string;
    siteImageUri?: string;
  };
  createdAt?: string;
}

const formatDate = (value?: string) => {
  if (!value) return 'Date not available';

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

const formatTimeValue = (time?: string) => {
  if (!time) return null;
  const [hour, minute] = time.split(':').map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return time;
  }

  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

const formatTime = (start?: string, end?: string) => {
  const formattedStart = formatTimeValue(start);
  const formattedEnd = formatTimeValue(end);
  if (formattedStart && formattedEnd) return `${formattedStart} - ${formattedEnd}`;
  if (formattedStart) return formattedStart;
  if (formattedEnd) return formattedEnd;
  return 'Timing not available';
};

const normalizeRequest = (
  notification: Notification
): BrowseJobRequest => ({
  _id: notification._id,
  requestId:
    notification.metadata?.requestId ??
    notification._id ??
    Math.random().toString(),
  status: notification.metadata?.responded
    ? notification.metadata?.accepted
      ? 'accepted'
      : 'declined'
    : 'pending',
  title: notification.title || 'Job Request',
  body:
    notification.body ||
    notification.metadata?.message ||
    'Job request from contractor.',
  metadata: {
    contractorPhone: notification.metadata?.contractorPhone,
    contractorName: notification.metadata?.contractorName,
    date: notification.metadata?.date,
    startTime: notification.metadata?.startTime,
    endTime: notification.metadata?.endTime,
    location: notification.metadata?.location,
    requiredWorkers: notification.metadata?.requiredWorkers,
    paymentFrequency: notification.metadata?.paymentFrequency,
    message: notification.metadata?.message,
    siteImageUri: notification.metadata?.siteImageUri,
  },
  createdAt:
    notification.createdAt || new Date().toISOString(),
});

export default function BrowseJobs() {
  const { t } = useLanguage();

  const [jobs, setJobs] = useState<BrowseJob[]>([]);
  const [requests, setRequests] = useState<
    BrowseJobRequest[]
  >([]);

  const [loading, setLoading] = useState(true);
  const [requestLoading, setRequestLoading] =
    useState(true);

  const [refreshing, setRefreshing] = useState(false);

  const [error, setError] = useState<string | null>(
    null
  );

  const [requestError, setRequestError] = useState<
    string | null
  >(null);

  const [processingRequestId, setProcessingRequestId] =
    useState<string | null>(null);

  const [coords, setCoords] =
    useState<Location.LocationObjectCoords | null>(
      null
    );

  const getLocation = useCallback(async () => {
    if (coords) {
      return coords;
    }

    const { status } =
      await Location.requestForegroundPermissionsAsync();

    if (status !== 'granted') {
      Alert.alert(
        'Location Required',
        'Please enable location permissions to browse nearby jobs.'
      );

      throw new Error(
        'Location permission not granted'
      );
    }

    const location =
      await Location.getCurrentPositionAsync({});

    setCoords(location.coords);

    return location.coords;
  }, [coords]);

  const fetchNearbyJobs = useCallback(async () => {
    setError(null);

    try {
      const currentCoords = await getLocation();

      const response = await api.post(
        '/jobs/nearby',
        {
          lat: currentCoords.latitude,
          lon: currentCoords.longitude,
        }
      );

      const data = response.data;

      if (!Array.isArray(data)) {
        throw new Error(
          'Unexpected job data format'
        );
      }

      setJobs(data);
    } catch (err: any) {
      console.error(
        'BrowseJobs fetch error:',
        err
      );

      const message =
        err?.response?.data?.message ||
        err?.message ||
        'Could not load jobs.';

      setError(message);
    }
  }, [getLocation]);

  const fetchPendingRequests = useCallback(
    async () => {
      setRequestError(null);

      try {
        const response = await api.get(
          '/notifications?limit=50&skip=0'
        );

        if (!response.data?.success) {
          throw new Error(
            response.data?.message ||
              'Failed to load requests'
          );
        }

        const notifications: Notification[] =
          Array.isArray(
            response.data.notifications
          )
            ? response.data.notifications
            : [];

        const jobRequests = notifications
          .filter(
            (notification: Notification) =>
              notification.type ===
              'job_request'
          )
          .map(normalizeRequest);

        setRequests(jobRequests);
      } catch (err: any) {
        console.error(
          'BrowseJobs request fetch error:',
          err
        );

        const message =
          err?.response?.data?.message ||
          err?.message ||
          'Could not load job requests.';

        setRequestError(message);
      } finally {
        setRequestLoading(false);
      }
    },
    []
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setRequestLoading(true);

    const requestPromise = fetchPendingRequests();

    try {
      await fetchNearbyJobs();
    } finally {
      setLoading(false);
    }

    await requestPromise;
  }, [
    fetchNearbyJobs,
    fetchPendingRequests,
  ]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);

    const requestPromise = fetchPendingRequests();

    try {
      await fetchNearbyJobs();
    } finally {
      setRefreshing(false);
    }

    await requestPromise;
  }, [
    fetchNearbyJobs,
    fetchPendingRequests,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleRequestResponse = async (
    requestId: string,
    accepted: boolean
  ) => {
    setProcessingRequestId(requestId);

    try {
      const response = await api.post(
        '/workers/respond-job-request',
        {
          requestId,
          accepted,
        }
      );

      if (!response.data?.success) {
        throw new Error(
          response.data?.message ||
            'Failed to respond to job request'
        );
      }

      setRequests((prev) =>
        prev.map((request) =>
          request.requestId === requestId
            ? {
                ...request,
                status: accepted
                  ? 'accepted'
                  : 'declined',
              }
            : request
        )
      );

      Alert.alert(
        'Success',
        accepted
          ? 'Job request accepted.'
          : 'Job request declined.'
      );
    } catch (err: any) {
      console.error(
        'Respond to job request error:',
        err
      );

      const message =
        err?.response?.data?.message ||
        err?.message ||
        'Could not update job request.';

      Alert.alert('Error', message);
    } finally {
      setProcessingRequestId(null);
    }
  };

  const renderRequestCard = useCallback(
    ({
      item,
    }: {
      item: BrowseJobRequest;
    }) => {
      const requestTitle =
        item.title || 'New Job Request';
      const requestSubtitle =
        item.metadata.message ||
        item.body ||
        'Job request from contractor.';
      const paymentFrequency =
        item.metadata.paymentFrequency
          ? item.metadata.paymentFrequency
              .charAt(0)
              .toUpperCase() +
            item.metadata.paymentFrequency.slice(1)
          : 'Daily';

      return (
        <View
          style={[
            styles.card,
            styles.requestCard,
          ]}
        >
          {item.metadata.siteImageUri ? (
            <View style={styles.cardImageWrapper}>
              <Image
                source={{
                  uri: item.metadata.siteImageUri,
                }}
                style={styles.cardImage}
              />
            </View>
          ) : null}

          <View style={[styles.cardBody, styles.requestCardBody]}>
            <View style={styles.requestHeader}>
              <View style={styles.requestHeaderText}>
                <Text style={styles.requestTitle}>
                  {requestTitle}
                </Text>
                <Text
                  style={styles.requestSubtitle}
                  numberOfLines={2}
                >
                  {requestSubtitle}
                </Text>
                <View style={styles.metaRow}>
                  <MaterialIcons
                    name="location-on"
                    size={14}
                    color="#6b7280"
                  />
                  <Text style={styles.metaText} numberOfLines={2}>
                    {item.metadata.location || 'Location not available'}
                  </Text>
                </View>
              </View>

              <View
                style={[
                  styles.statusPill,
                  item.status === 'pending'
                    ? styles.pendingPill
                    : item.status === 'accepted'
                    ? styles.acceptedPill
                    : styles.declinedPill,
                ]}
              >
                <Text style={styles.statusText}>
                  {item.status.toUpperCase()}
                </Text>
              </View>
            </View>

            <View style={styles.requestMetaRow}>
              <View style={styles.requestMetaCol}>
                <Text style={styles.metaLabel}>
                  {t('date')}
                </Text>
                <Text style={styles.metaValue}>
                  {formatDate(item.metadata.date)}
                </Text>
              </View>
              <View style={styles.requestMetaCol}>
                <Text style={styles.metaLabel}>
                  Timing
                </Text>
                <Text style={styles.metaValue}>
                  {formatTime(
                    item.metadata.startTime,
                    item.metadata.endTime
                  )}
                </Text>
              </View>
            </View>

            <View style={styles.requestMetaRow}>
              <View style={styles.requestMetaCol}>
                <Text style={styles.metaLabel}>
                  {t('workersNeeded')}
                </Text>
                <Text style={styles.metaValue}>
                  {item.metadata.requiredWorkers ?? 1}
                </Text>
              </View>
              <View style={styles.requestMetaCol}>
                <Text style={styles.metaLabel}>
                  Payment frequency
                </Text>
                <Text style={styles.metaValue}>
                  {paymentFrequency}
                </Text>
              </View>
            </View>

            {item.status === 'pending' && (
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  accessible
                  accessibilityRole="button"
                  style={styles.declineButton}
                  disabled={
                    processingRequestId ===
                    item.requestId
                  }
                  onPress={() =>
                    handleRequestResponse(
                      item.requestId,
                      false
                    )
                  }
                >
                  <Text
                    style={styles.declineText}
                  >
                    {t('decline') ||
                      'Decline'}
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  accessible
                  accessibilityRole="button"
                  style={styles.acceptButton}
                  disabled={
                    processingRequestId ===
                    item.requestId
                  }
                  onPress={() =>
                    handleRequestResponse(
                      item.requestId,
                      true
                    )
                  }
                >
                  <Text
                    style={styles.acceptText}
                  >
                    {t('accept') ||
                      'Accept'}
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      );
    },
    [
      handleRequestResponse,
      processingRequestId,
      t,
    ]
  );

  const renderJobCard = useCallback(
    ({
      item,
    }: {
      item: BrowseJob;
    }) => {
      const workerCount = item.requiredWorkers ?? 1;
      const displayLocation =
        item.location ||
        'Mumbai, Maharashtra';

      return (
        <View style={styles.card}>
          <View
            style={styles.cardImageWrapper}
          >
            <Image
              source={{
                uri:
                  item.imageUrl ||
                  'https://images.unsplash.com/photo-1556911220-e15b29be8c6b?w=800&q=80&auto=format&fit=crop',
              }}
              style={styles.cardImage}
            />

            <View style={styles.requiredBadge}>
              <Text
                style={styles.requiredBadgeText}
              >
                {'Worker Required'}
              </Text>
            </View>

            <View style={styles.amountPillOverlay}>
              <Text
                style={styles.amountText}
              >
                ₹{item.amount ?? '0'}
              </Text>
            </View>
          </View>

          <View style={styles.cardBody}>
            <Text style={styles.jobTitle}>
              {item.title ||
                item.description ||
                t('jobTitle')}
            </Text>

            <Text
              style={styles.contractorText}
            >
              {item.contractorName ||
                'Sharma Construction'}
            </Text>

            <View style={styles.locationRow}>
              <MaterialIcons
                name="location-on"
                size={16}
                color="#6b7280"
              />
              <Text
                style={styles.locationText}
              >
                {displayLocation}
              </Text>
            </View>

            {item.rating !== undefined ? (
              <View style={styles.ratingRow}>
                <FontAwesome5
                  name="star"
                  size={12}
                  color="#F59E0B"
                />
                <Text
                  style={styles.ratingText}
                >
                  {item.rating.toFixed(1)}
                </Text>
                {item.reviewCount ? (
                  <Text
                    style={styles.reviewText}
                  >
                    {`(${item.reviewCount})`}
                  </Text>
                ) : null}
              </View>
            ) : null}

            <Text
              style={styles.descriptionText}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {item.description ||
                'Construction work at the site. Safety gear and punctuality required.'}
            </Text>

            <View style={styles.footerRow}>
              <View style={styles.footerTag}>
                <FontAwesome5
                  name="calendar-alt"
                  size={12}
                  color="#2563eb"
                />

                <Text
                  style={styles.footerText}
                >
                  {formatDate(
                    item.date ||
                      new Date().toISOString()
                  )}
                </Text>
              </View>

              <View style={styles.footerTag}>
                <MaterialIcons
                  name="schedule"
                  size={12}
                  color="#2563eb"
                />

                <Text
                  style={styles.footerText}
                >
                  {formatTime(
                    item.startTime,
                    item.endTime
                  )}
                </Text>
              </View>

              <View style={styles.footerTag}>
                <MaterialIcons
                  name="people"
                  size={12}
                  color="#2563eb"
                />

                <Text
                  style={styles.footerText}
                >
                  {`${workerCount} ${t('workers') || 'Workers'}`}
                </Text>
              </View>
            </View>
          </View>
        </View>
      );
    },
    [t]
  );

  const ListHeaderComponent =
    useCallback(() => {
      if (requestLoading) {
        return (
          <View
            style={styles.sectionHeader}
          >
            <Text
              style={styles.sectionTitle}
            >
              Job Requests
            </Text>

            <Text
              style={styles.sectionSubtitle}
            >
              Loading requests...
            </Text>
          </View>
        );
      }

      if (requests.length === 0) {
        return null;
      }

      return (
        <View style={styles.headerSection}>
          <View
            style={styles.sectionHeader}
          >
            <Text
              style={styles.sectionTitle}
            >
              Job Requests
            </Text>

            <Text
              style={styles.sectionSubtitle}
            >
              {`${requests.length} pending`}
            </Text>
          </View>

          <FlatList
            data={requests}
            renderItem={renderRequestCard}
            keyExtractor={(item) =>
              String(item._id)
            }
            scrollEnabled={false}
            ItemSeparatorComponent={() => (
              <View
                style={{ height: 12 }}
              />
            )}
          />
        </View>
      );
    }, [
      requestLoading,
      requests,
      renderRequestCard,
    ]);

  if (loading) {
    return (
      <SafeAreaView
        style={styles.container}
      >
        <View style={styles.centered}>
          <ActivityIndicator
            size="large"
            color="#2563eb"
          />

          <Text style={styles.loadingText}>
            {t('loading')}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.screenTitle}>
          Browse Jobs
        </Text>
      </View>

      {error &&
        jobs.length === 0 &&
        requests.length > 0 && (
          <View style={styles.errorBanner}>
            <Text
              style={styles.errorBannerText}
            >
              Could not load nearby jobs.
            </Text>
          </View>
        )}

      {requestError &&
        requests.length === 0 &&
        jobs.length > 0 && (
          <View style={styles.errorBanner}>
            <Text
              style={styles.errorBannerText}
            >
              Could not load job requests.
            </Text>
          </View>
        )}

      <FlatList
        data={jobs}
        keyExtractor={(item) =>
          String(item._id)
        }
        renderItem={renderJobCard}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={
          false
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            title={t('pullToRefresh')}
          />
        }
        ListHeaderComponent={
          ListHeaderComponent
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 16,
    paddingTop: 12,
  },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },

  screenTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111827',
  },

  listContent: {
    paddingBottom: 24,
  },

  card: {
    backgroundColor: '#ffffff',
    borderRadius: 18,
    marginBottom: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 20,
    shadowOffset: {
      width: 0,
      height: 8,
    },
    elevation: 5,
  },

  cardImageWrapper: {
    width: '100%',
    height: 155,
  },

  cardImage: {
    width: '100%',
    height: '100%',
  },

  badge: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: '#f8fafc',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },

  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#111827',
  },

  requiredBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: 'rgba(255,255,255,0.95)',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },

  requiredBadgeText: {
    fontSize: 12,
    color: '#111827',
    fontWeight: '700',
  },

  amountPillOverlay: {
    position: 'absolute',
    top: 12,
    right: 12,
    backgroundColor: '#2563eb',
    borderRadius: 14,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },

  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },

  locationText: {
    marginLeft: 8,
    color: '#6b7280',
    fontSize: 13,
    flex: 1,
  },

  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },

  ratingText: {
    marginLeft: 6,
    color: '#111827',
    fontSize: 13,
    fontWeight: '700',
  },

  reviewText: {
    marginLeft: 4,
    color: '#6b7280',
    fontSize: 12,
  },

  cardBody: {
    padding: 18,
  },

  cardHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },

  jobTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    lineHeight: 24,
  },

  contractorText: {
    marginTop: 6,
    fontSize: 14,
    color: '#6b7280',
  },

  amountPill: {
    backgroundColor: '#eff6ff',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },

  amountText: {
    color: '#1d4ed8',
    fontWeight: '700',
    fontSize: 14,
  },

  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
  },

  metaText: {
    marginLeft: 6,
    color: '#6b7280',
    fontSize: 13,
    flex: 1,
  },

  descriptionText: {
    marginTop: 12,
    color: '#4b5563',
    lineHeight: 20,
    fontSize: 14,
  },

  detailsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },

  detailItem: {
    flex: 1,
  },

  detailItemFull: {
    flex: 1,
  },

  detailLabel: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
  },

  detailValue: {
    marginTop: 4,
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },

  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 16,
  },

  footerTag: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#eff6ff',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },

  footerText: {
    color: '#2563eb',
    fontSize: 12,
    fontWeight: '600',
    marginLeft: 4,
  },

  requestCard: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },

  requestCardBody: {
    padding: 18,
  },

  requestHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 16,
  },

  requestHeaderText: {
    flex: 1,
    paddingRight: 12,
  },

  requestTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 6,
  },

  requestSubtitle: {
    color: '#6b7280',
    fontSize: 14,
    lineHeight: 20,
  },

  requestMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12,
  },

  requestMetaCol: {
    flex: 1,
    marginRight: 14,
  },

  metaLabel: {
    color: '#6b7280',
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 6,
  },

  metaValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#111827',
  },

  requestMetaColLast: {
    marginRight: 0,
  },

  statusPill: {
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },

  pendingPill: {
    backgroundColor: '#fef3c7',
  },

  acceptedPill: {
    backgroundColor: '#d1fae5',
  },

  declinedPill: {
    backgroundColor: '#fee2e2',
  },

  statusText: {
    color: '#111827',
    fontWeight: '700',
    fontSize: 11,
  },

  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 14,
  },

  acceptButton: {
    flex: 1,
    backgroundColor: '#2563eb',
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    marginLeft: 8,
  },

  declineButton: {
    flex: 1,
    backgroundColor: '#ef4444',
    paddingVertical: 12,
    borderRadius: 14,
    alignItems: 'center',
    marginRight: 8,
  },

  acceptText: {
    color: '#fff',
    fontWeight: '700',
  },

  declineText: {
    color: '#fff',
    fontWeight: '700',
  },

  sectionHeader: {
    marginBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },

  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },

  sectionSubtitle: {
    fontSize: 14,
    color: '#6b7280',
  },

  headerSection: {
    marginBottom: 20,
  },

  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },

  loadingText: {
    marginTop: 14,
    color: '#6b7280',
    fontSize: 14,
  },

  errorBanner: {
    backgroundColor: '#fee2e2',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 12,
  },

  errorBannerText: {
    color: '#b91c1c',
    fontSize: 13,
    fontWeight: '600',
  },
});