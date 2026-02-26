import React, { useEffect } from 'react';
import { View, Text, Image, TouchableOpacity, FlatList, Modal } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { socket } from '../../../utils/socket';
import { SERVER_URL, API_BASE } from '../../../utils/config';
import PremiumPlansModal from '../../../components/PremiumPlansModal';
import { useLanguage } from '../../../context/LanguageContext';
import { useAuth } from '../../../context/AuthContext';
import styles from '../../../styles/ContractorHomeStyles';
const profile = require('../../../assets/oip2.jpg');

export default function ContractorHome() {
  const router = useRouter();
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const currentUserPhone = authUser?.phone || null;
  const [premiumModalVisible, setPremiumModalVisible] = React.useState(false);
  const [hasPremium, setHasPremium] = React.useState(false);
  const [premiumStatusLoading, setPremiumStatusLoading] = React.useState(true);
  const [userProfilePhoto, setUserProfilePhoto] = React.useState(profile);
  const [leaderboard, setLeaderboard] = React.useState<any[]>([]);
  const [leaderboardExpanded, setLeaderboardExpanded] = React.useState(false);
  const [jobsDoneCount, setJobsDoneCount] = React.useState(0);
  const [postedCount, setPostedCount] = React.useState(0);
  const [totalSpending, setTotalSpending] = React.useState(0);
  const [workersEngaged, setWorkersEngaged] = React.useState(0);
  const [notificationCount, setNotificationCount] = React.useState<number>(0); // ? Add notification count state
  const [showLocationModal, setShowLocationModal] = React.useState<boolean>(false); // ? Location modal state
  const [requestingLocation, setRequestingLocation] = React.useState<boolean>(false); // ? Loading state for location request
  const [supportModalVisible, setSupportModalVisible] = React.useState(false);
  // ? Removed dead token state - use accessToken from context instead

  // ? Separate premium listener effect - runs on login, not on every tab focus
  React.useEffect(() => {
    if (!accessToken) return;

    const handlePremiumSubscriptionUpdate = async (data: any) => {
      console.log(`Premium subscription update received from contractor ${data.contractorPhone}`);
      
      try {
        const userStr = await AsyncStorage.getItem('user');
        const user = userStr ? JSON.parse(userStr) : null;
        const formattedLeaderboard = await fetchLeaderboardByDistrict({
          latitude: Number(user?.latitude || 0),
          longitude: Number(user?.longitude || 0),
          token: accessToken,
        });
        setLeaderboard(formattedLeaderboard);
        console.log('Leaderboard refreshed after premium subscription update:', formattedLeaderboard);
      } catch (err) {
        console.error('Error refreshing leaderboard on subscription update:', (err as Error).message);
      }
    };

    socket.on('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);

    return () => {
      socket.off('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // ? Memoize sorted leaderboard to prevent re-sorting on every render
  // CRITICAL: Clone array before sorting to avoid mutating React state
  const sortedLeaderboard = React.useMemo(() => {
    return [...leaderboard].sort((a, b) => {
      // Current user always on top
      const aIsCurrent = Boolean(currentUserPhone && (a.id === currentUserPhone || a.phone === currentUserPhone));
      const bIsCurrent = Boolean(currentUserPhone && (b.id === currentUserPhone || b.phone === currentUserPhone));
      if (aIsCurrent) return -1;
      if (bIsCurrent) return 1;
      // Then sort by rank
      return (a.rank || 999) - (b.rank || 999);
    });
  }, [leaderboard, currentUserPhone]);

  const toSafeNumber = React.useCallback((value: any) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : 0;
  }, []);

  const mapLeaderboardRows = React.useCallback((rows: any[] = []) => {
    return rows.map((contractor: any) => ({
      id: contractor.contractorId || contractor._id || contractor.phone,
      phone: contractor.phone || contractor.contractorPhone || contractor.contractorId || contractor._id,
      name: contractor.name || 'Unknown',
      points: toSafeNumber(contractor.score ?? contractor.points ?? contractor.finalScore ?? contractor.myPoints ?? 0),
      profile: contractor.profilePhoto ? contractor.profilePhoto : null,
      rank: toSafeNumber(contractor.rank ?? contractor.position ?? 0),
      rating: toSafeNumber(contractor.rating ?? contractor.avgRating ?? contractor.averageRating ?? 0),
      jobsPosted: toSafeNumber(contractor.jobCount ?? contractor.totalJobsPosted ?? contractor.jobsPosted ?? 0),
      tier: contractor.tier || 'new',
    }));
  }, [toSafeNumber]);

  const fetchLeaderboardByDistrict = React.useCallback(async ({
    latitude,
    longitude,
    token = accessToken,
    useCacheFallback = false,
  }: {
    latitude?: number;
    longitude?: number;
    token?: string | null;
    useCacheFallback?: boolean;
  } = {}) => {
    if (!token) return [];

    const lat = Number(latitude ?? authUser?.latitude ?? 0);
    const lon = Number(longitude ?? authUser?.longitude ?? 0);

    try {
      const leaderboardRes = await fetch(
        `${SERVER_URL}/leaderboard/contractors/by-district?lat=${lat}&lon=${lon}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!leaderboardRes.ok) {
        throw new Error(`Leaderboard fetch failed with status ${leaderboardRes.status}`);
      }

      const leaderboardData = await leaderboardRes.json();
      const boardData = Array.isArray(leaderboardData) ? leaderboardData : leaderboardData?.leaderboard || [];
      const formattedLeaderboard = mapLeaderboardRows(boardData);

      if (!Array.isArray(leaderboardData)) {
        await AsyncStorage.setItem('leaderboard', JSON.stringify(leaderboardData));
      }

      return formattedLeaderboard;
    } catch (err) {
      if (!useCacheFallback) throw err;
      const cachedLeaderboard = await AsyncStorage.getItem('leaderboard');
      if (!cachedLeaderboard) return [];
      const leaderboardData = JSON.parse(cachedLeaderboard);
      const boardData = Array.isArray(leaderboardData) ? leaderboardData : leaderboardData.leaderboard || [];
      return mapLeaderboardRows(boardData);
    }
  }, [accessToken, authUser?.latitude, authUser?.longitude, mapLeaderboardRows]);

  const fetchPremiumStatus = React.useCallback(async (): Promise<boolean> => {
    if (!accessToken) {
      setHasPremium(false);
      setPremiumStatusLoading(false);
      return false;
    }
    setPremiumStatusLoading(true);
    try {
      const response = await fetch(`${SERVER_URL}/premium/status`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await response.json();
      const isActive = Boolean(data?.success && data?.isActive);
      setHasPremium(isActive);
      return isActive;
    } catch (err) {
      console.warn('Could not fetch premium status:', (err as Error).message);
      setHasPremium(false);
      return false;
    } finally {
      setPremiumStatusLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setPremiumStatusLoading(false);
      setHasPremium(false);
      setLeaderboard([]);
      return;
    }
    // Prevent locked-banner flicker while status request is in-flight.
    setPremiumStatusLoading(true);
  }, [accessToken]);
  const topCards = [
    { id: 1, icon: 'work', amount: postedCount.toString(), label: t('jobsPosted') },
    { id: 2, icon: 'check-circle', amount: jobsDoneCount.toString(), label: t('jobsCompleted') },
    { id: 3, icon: 'people', amount: workersEngaged.toString(), label: t('workers') },
    { id: 4, icon: 'attach-money', amount: `₹${totalSpending}`, label: t('spending') },
  ];

  const bottomCard = { id: 3, icon: 'dashboard', amount: '', label: t('dashboard') };

  // Leaderboard is now populated from state in useFocusEffect

  const handleUpgrade = () => {
    setPremiumModalVisible(true);
  };

  const fetchJobs = React.useCallback(async () => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      const res = await fetch(`${SERVER_URL}/jobs`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch jobs');

      const data = await res.json();

      // Filter jobs posted by this contractor
      const myJobs = data.filter((job: any) => job.contractorPhone === currentUserPhone && !job.isCancelled);
      setPostedCount(myJobs.length);

      // Count active/unpaid workers for contractor jobs
      const unpaidJobs = myJobs.filter((job: any) => String(job.paymentStatus || '').toLowerCase() !== 'paid' && (job.acceptedBy || (job.acceptedWorkers && job.acceptedWorkers.length > 0)));
      const uniqueUnpaidWorkers = new Set(unpaidJobs.flatMap((job: any) => job.acceptedWorkers && job.acceptedWorkers.length ? job.acceptedWorkers.map((w: any) => w.phone || w) : (job.acceptedBy ? [job.acceptedBy] : [])));
      setWorkersEngaged(uniqueUnpaidWorkers.size);

      // Count jobs done (paid jobs for this contractor)
      const paidJobs = myJobs.filter((job: any) => String(job.paymentStatus || '').toLowerCase() === 'paid');
      setJobsDoneCount(paidJobs.length);

      // Total spending by contractor (sum of amounts for paid jobs)
      const spending = paidJobs.reduce((sum: number, j: any) => sum + (Number(j.amount) || 0), 0);
      setTotalSpending(spending);
      
      // ? Save last posted job ID for waiting screen access
      if (myJobs.length > 0) {
        const lastJob = myJobs[myJobs.length - 1]; // Most recent job
        try {
          await AsyncStorage.setItem('lastJobId', lastJob._id);
          console.log('? Last job ID saved:', lastJob._id);
        } catch (err) {
          console.warn('Could not save lastJobId:', err);
        }
      }
    } catch (err) {
      console.error('Job fetch error:', err);
    }
  }, [accessToken, currentUserPhone]);

  // ? Fetch notification count
  const fetchNotificationCount = React.useCallback(async () => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      const res = await fetch(`${SERVER_URL}/notifications?limit=100&skip=0`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) throw new Error('Failed to fetch notifications');
      
      const data = await res.json();
      setNotificationCount(data.unreadCount || 0);
    } catch (err) {
      console.error('Failed to fetch notification count:', err);
    }
  }, [accessToken]);

  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const savedToken = accessToken;

          if (savedToken) {
            let currentUser = null;

            if (authUser) {
              currentUser = authUser;
              if (currentUser.profilePhoto) {
                setUserProfilePhoto({ uri: currentUser.profilePhoto });
              }
            }

            if (!currentUser?.premiumPlan) {
              try {
                const response = await fetch(`${SERVER_URL}/users/profile`, {
                  headers: { Authorization: `Bearer ${savedToken}` },
                });
                if (response.ok) {
                  const data = await response.json();

                  if (data.success && data.user) {
                    currentUser = { ...currentUser, ...data.user };
                    await AsyncStorage.setItem('user', JSON.stringify(currentUser));
                  }
                } else {
                  console.warn(`Profile fetch returned status ${response.status}`);
                }
              } catch (err) {
                console.warn('Could not fetch fresh user data:', err);
              }
            }

            const hasActivePremium = await fetchPremiumStatus();
            if (!hasActivePremium) {
              setLeaderboard([]);
            }

            if (hasActivePremium) {
              try {
                const formattedLeaderboard = await fetchLeaderboardByDistrict({
                  latitude: Number(currentUser?.latitude || 0),
                  longitude: Number(currentUser?.longitude || 0),
                  token: savedToken,
                  useCacheFallback: true,
                });
                setLeaderboard(formattedLeaderboard);
                console.log('Loaded leaderboard:', formattedLeaderboard);
              } catch (err) {
                console.warn('Error loading leaderboard:', (err as Error).message);
              }
            }

            if (!socket.connected && savedToken) {
              socket.auth = { token: savedToken };
              socket.connect();
            }

            await Promise.all([
              fetchJobs(),
              fetchNotificationCount(),
            ]);
          }
        } catch {
          // Silent fail on token loading
        }
      })();

      return () => {
        // ? Socket listener cleanup is now handled in separate useEffect
        // This useFocusEffect focuses on data fetching
      };
    }, [accessToken, authUser, fetchJobs, fetchLeaderboardByDistrict, fetchNotificationCount, fetchPremiumStatus])
  );

  // ? REQUEST AND UPDATE LOCATION FOR CONTRACTOR
  const requestAndUpdateLocation = async (): Promise<boolean> => {
    try {
      setRequestingLocation(true);
      console.log('Requesting location permission for contractor...');

      const { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        console.warn('Location permission denied');
        return false;
      }

      console.log('? Location permission granted, getting position...');
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      console.log(`Location obtained: lat=${latitude}, lon=${longitude}`);

      // Update location on backend
      console.log(`Sending location update to ${API_BASE}/user/update-location`);
      const response = await fetch(`${API_BASE}/user/update-location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ latitude, longitude }),
      });

      console.log(`Backend response status: ${response.status}`);
      const data = await response.json();
      console.log(`Backend response data:`, data);

      if (!response.ok) {
        console.error('? Backend returned error status:', response.status, data.message);
        return false;
      }

      if (!data.success) {
        console.error('? Backend returned success=false:', data.message);
        return false;
      }

      console.log('? Location updated on backend:', data.user);
      
      // Update local user data
      const userStr = await AsyncStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        user.latitude = data.user.latitude;
        user.longitude = data.user.longitude;
        user.city = data.user.city;
        user.state = data.user.state;
        await AsyncStorage.setItem('user', JSON.stringify(user));
        console.log('? Contractor location data updated in local storage');
      }

      // Close modal after successful location update
      console.log('Closing location modal...');
      setShowLocationModal(false);
      console.log(`? Location enabled! City: ${data.user.city}, State: ${data.user.state}`);
      return true;
    } catch (err) {
      console.error('? Error requesting location:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Error details: ${errorMsg}`);
      return false;
    } finally {
      console.log('Cleanup: Setting requestingLocation to false');
      setRequestingLocation(false);
    }
  };

  // ? CHECK FOR DEFAULT LOCATION AND SHOW MODAL POST-LOGIN
  useEffect(() => {
    (async () => {
      if (!accessToken) return;

      try {
        const userStr = await AsyncStorage.getItem('user');
        if (!userStr) return;

        const user = JSON.parse(userStr);
        const locationProvidedOnLogin = await AsyncStorage.getItem('locationProvidedOnLogin');

        // Check if location is default (0,0) or missing
        const hasDefaultLocation = (user.latitude === 0 && user.longitude === 0) || 
                                   !(user.latitude && user.longitude);
        const shouldPromptForLocation = locationProvidedOnLogin !== 'true' && hasDefaultLocation;

        if (shouldPromptForLocation) {
          console.log("Contractor has default location (0,0) - showing location permission modal");
          setShowLocationModal(true);
        } else {
          console.log("? Contractor already has location set:", { lat: user.latitude, lon: user.longitude });
        }
      } catch (err) {
        console.error("Error checking contractor location:", err);
      }
    })();
  }, [accessToken]);

  const handlePlanSelected = async (planId: string) => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      console.log(`Premium plan selected: ${planId}`);
      // Optimistic UI so contractor sees premium section immediately after successful payment.
      setHasPremium(true);
      
      // ? Fetch updated user data from backend and save to AsyncStorage with premium plan info
      try {
        const response = await fetch(`${SERVER_URL}/users/profile`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.user) {
            // Update user in AsyncStorage with fresh data including premium plan
            await AsyncStorage.setItem('user', JSON.stringify(data.user));
            console.log('? Updated user data with premium plan:', data.user.premiumPlan);
          }
        }
      } catch (err) {
        console.warn('Could not fetch fresh user data after plan purchase:', err);
      }
      
      // Close modal
      setPremiumModalVisible(false);
      
      // Confirm premium status from backend (source of truth)
      const isActive = await fetchPremiumStatus();
      if (!isActive) {
        setHasPremium(false);
        setLeaderboard([]);
        return;
      }
      
      try {
        const userStr = await AsyncStorage.getItem('user');
        const u = userStr ? JSON.parse(userStr) : null;
        const formattedLeaderboard = await fetchLeaderboardByDistrict({
          latitude: Number(u?.latitude || 0),
          longitude: Number(u?.longitude || 0),
          token: accessToken,
        });
        setLeaderboard(formattedLeaderboard);
        console.log('Fresh leaderboard fetched after premium purchase:', formattedLeaderboard);
      } catch (err) {
        console.error('Error fetching fresh leaderboard after premium purchase:', (err as Error).message);
      }
    } catch (err) {
      console.warn('Could not complete premium plan selection:', (err as Error).message);
    }
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right']}
      style={styles.container}
    >
      {/* Header with Gradient */}
      <LinearGradient 
        colors={['#1a2f4d', '#2d5a8c']} 
        start={{ x: 0, y: 0 }} 
        end={{ x: 1, y: 1 }}
        style={styles.headerContainer}
      >
        <View style={styles.headerContent}>
          {/* ? Circular Profile Photo on Left */}
          <TouchableOpacity 
            onPress={() => router.push('/home/contractor/profile' as any)}
            style={styles.headerProfileContainer}
          >
            <Image source={userProfilePhoto} style={styles.headerProfilePhoto} />
          </TouchableOpacity>
          <View style={styles.headerActions}>
            <TouchableOpacity
              style={styles.supportContainer}
              onPress={() => setSupportModalVisible(true)}
            >
              <MaterialIcons name="support-agent" size={22} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.bellContainer}
              onPress={() => router.push("/NotificationHistory" as any)}
            >
              <MaterialIcons name="notifications-none" size={28} color="#000" />
              {notificationCount > 0 && ( // ? Show badge if unread notifications exist
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {notificationCount > 9 ? '9+' : notificationCount}
                  </Text>
                </View>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </LinearGradient>

      {/* Top cards (show only Jobs Posted + Completed on home screen) */}
      <View style={styles.topRow}>
        {topCards.slice(0, 2).map((card) => (
          <TouchableOpacity key={card.id} style={styles.card}>
            <LinearGradient 
              colors={card.id === 1 ? ['#1f3a5f', '#1f3a5f'] : ['#1f3a5f', '#1f3a5f']} 
              style={styles.gradientCard}
            >
              <View style={styles.bubble1} />
              <View style={styles.bubble2} />
              <MaterialIcons name={card.icon as any} size={32} color="#fff" />
              <Text style={styles.amountTextWhite}>{card.amount}</Text>
              <Text style={styles.labelTextWhite}>{card.label}</Text>
            </LinearGradient>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bottom card - Dashboard */}
      <TouchableOpacity style={styles.fullWidthCard} onPress={() => router.navigate('../../dashboard' as any)}>
        <LinearGradient colors={['#1f3a5f', '#1f3a5f']} style={styles.gradientCard}>
          <View style={styles.bubble1} />
          <View style={styles.bubble2} />
          <MaterialIcons name={bottomCard.icon as any} size={32} color="#fff" />
          <Text style={styles.amountTextWhite}>{bottomCard.amount}</Text>
          <Text style={styles.labelTextWhite}>{bottomCard.label}</Text>
        </LinearGradient>
      </TouchableOpacity>

      {/* Scrollable Leaderboard with Premium Overlay */}
      <View
        style={[
          styles.leaderboardWrapper,
          leaderboardExpanded && styles.leaderboardWrapperExpanded,
          { paddingBottom: 16 },
        ]}
      >
        {/* Gradient Background */}
        <LinearGradient
          colors={['#ffffff', '#1f3a5f']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={styles.leaderboardBackgroundGradient}
        />
        
        {/* Bubbles in background */}
        <View style={styles.leaderboardBubbles1} />
        {/* <View style={styles.leaderboardBubbles2} /> */}

        <View style={styles.leaderboardContent}>
          {/* Leaderboard Header with Title and Expand Button */}
          <View style={styles.leaderboardHeader}>
            <Text style={styles.leaderboardTitle}>🏆 Leadership Board</Text>
            {!premiumStatusLoading && hasPremium && (
              <TouchableOpacity 
                onPress={() => setLeaderboardExpanded(!leaderboardExpanded)}
                style={styles.expandButton}
              >
                <MaterialIcons 
                  name={leaderboardExpanded ? "close" : "expand-more"} 
                  size={28} 
                  color="#1f3a5f" 
                />
              </TouchableOpacity>
            )}
          </View>

          {/* Premium Unlock Banner - only show if user doesn't have premium */}
          {premiumStatusLoading && (
            <View style={styles.premiumBanner}>
              <Text style={styles.premiumBannerTitle}>Checking premium status...</Text>
              <View style={{ marginTop: 10, gap: 8 }}>
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#d6dbe1' }} />
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#e4e7eb', width: '88%' }} />
                <View style={{ height: 14, borderRadius: 6, backgroundColor: '#eef0f3', width: '70%' }} />
              </View>
            </View>
          )}

          {!premiumStatusLoading && !hasPremium && (
            <View style={styles.premiumBanner}>
              <MaterialIcons name="lock" size={32} color="#1f3a5f" />
              <Text style={styles.premiumBannerTitle}>Unlock Leadership Board</Text>
              <Text style={styles.premiumBannerSubtitle}>Upgrade to Premium to see full rankings</Text>
              <TouchableOpacity style={styles.premiumBannerButton} onPress={handleUpgrade}>
                <Text style={styles.premiumBannerButtonText}>Upgrade Now</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Leaderboard cards - Current user on top - Only render if premium */}
          {!premiumStatusLoading && hasPremium && sortedLeaderboard.length > 0 ? (
            <FlatList
              data={sortedLeaderboard}
              keyExtractor={(person) => person.id}
              style={styles.leaderboardScroll}
              contentContainerStyle={{ paddingBottom: 16 }}
              showsVerticalScrollIndicator={false}
              scrollEnabled={true}
              initialNumToRender={5}
              maxToRenderPerBatch={5}
              windowSize={5}
              removeClippedSubviews={true}
              renderItem={({ item: person, index }) => {
                const isCurrentUser = Boolean(
                  currentUserPhone && (person.id === currentUserPhone || person.phone === currentUserPhone)
                );
                // ? No need to .find() - rank is already set correctly after sorting
                const displayRank = isCurrentUser ? person.rank : person.rank || index + 1;
                
                return (
                  <View
                    style={[styles.leaderboardCard, isCurrentUser && styles.firstCardHighlight]}
                  >
                    {/* Bubbles */}
                    <View style={styles.cardBubble1} />
                    {/* <View style={styles.cardBubble2} /> */}

                    {/* Rank Number - Left */}
                    <View style={styles.rankIcon}>
                      <Text style={{ fontSize: 18, color: '#1a2f4d', fontWeight: '900' }}>
                        {displayRank}
                      </Text>
                    </View>

                    {/* Profile Picture */}
                    {isCurrentUser ? (
                      <Image 
                        source={userProfilePhoto}
                        style={styles.profilePicture}
                        defaultSource={profile}
                      />
                    ) : person.profile ? (
                      <Image 
                        source={typeof person.profile === 'string' ? { uri: person.profile } : person.profile}
                        style={styles.profilePicture}
                        defaultSource={profile}
                      />
                    ) : (
                      <View style={[styles.profilePicture, { backgroundColor: '#1f3a5f', justifyContent: 'center', alignItems: 'center' }]}>
                        <Text style={{ color: '#fff', fontSize: 18, fontWeight: 'bold' }}>
                          {person.name?.charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}

                    {/* Name - Middle */}
                    <Text style={styles.nameText}>
                      {isCurrentUser ? `${person.name} (You)` : person.name}
                    </Text>

                    {/* Score - Right */}
                    <View style={styles.pointsBadge}>
                      <Text style={styles.pointsText}>{person.points}</Text>
                    </View>
                  </View>
                );
              }}
            />
          ) : null}
        </View>
      </View>

      {/* Premium Plans Modal */}
      <PremiumPlansModal
        visible={premiumModalVisible}
        onClose={() => setPremiumModalVisible(false)}
        onPlanSelected={handlePlanSelected}
      />

      <Modal visible={supportModalVisible} transparent animationType="fade" onRequestClose={() => setSupportModalVisible(false)}>
        <TouchableOpacity style={styles.supportModalOverlay} activeOpacity={1} onPress={() => setSupportModalVisible(false)}>
          <View style={styles.supportModalCard}>
            <MaterialIcons name="support-agent" size={28} color="#e74c3c" />
            <Text style={styles.supportModalTitle}>Support</Text>
            <Text style={styles.supportModalText}>Support will call you shortly.</Text>
            <TouchableOpacity style={styles.supportModalBtn} onPress={() => setSupportModalVisible(false)}>
              <Text style={styles.supportModalBtnText}>OK</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* ? POST-LOGIN LOCATION PERMISSION MODAL FOR CONTRACTOR */}
      <Modal visible={showLocationModal} transparent animationType="fade">
        <TouchableOpacity 
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' }}
          activeOpacity={1}
        >
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
            <TouchableOpacity 
              style={{ 
                backgroundColor: '#fff', 
                borderRadius: 16, 
                padding: 24, 
                width: '100%',
                maxWidth: 350,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.25,
                shadowRadius: 3.84,
                elevation: 5,
              }}
              onPress={(e) => e.stopPropagation()}
            >
              {/* Icon */}
              <View style={{ alignItems: 'center', marginBottom: 16 }}>
                <MaterialIcons name="location-on" size={48} color="#3498db" />
              </View>

              {/* Title */}
              <Text style={{ fontSize: 20, fontWeight: '700', color: '#1a2f4d', textAlign: 'center', marginBottom: 8 }}>
                Enable Location
              </Text>

              {/* Subtitle */}
              <Text style={{ fontSize: 14, color: '#7f8c8d', textAlign: 'center', marginBottom: 20 }}>
                We need your location to match you with nearby workers and to provide location-based job recommendations.
              </Text>

              {/* Enable Button */}
              <TouchableOpacity 
                style={{ 
                  backgroundColor: '#3498db', 
                  borderRadius: 10, 
                  paddingVertical: 14,
                  alignItems: 'center',
                  marginBottom: 10,
                  opacity: requestingLocation ? 0.6 : 1,
                }}
                onPress={requestAndUpdateLocation}
                disabled={requestingLocation}
              >
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                  {requestingLocation ? 'Getting Location...' : 'Enable Location'}
                </Text>
              </TouchableOpacity>

              {/* Skip Button */}
              <TouchableOpacity 
                style={{ 
                  borderWidth: 1.5,
                  borderColor: '#bdc3c7',
                  borderRadius: 10, 
                  paddingVertical: 12,
                  alignItems: 'center',
                }}
                onPress={() => setShowLocationModal(false)}
                disabled={requestingLocation}
              >
                <Text style={{ color: '#7f8c8d', fontSize: 14, fontWeight: '700' }}>
                  Skip for Now
                </Text>
              </TouchableOpacity>

              {/* Info Text */}
              <Text style={{ fontSize: 12, color: '#95a5a6', textAlign: 'center', marginTop: 16 }}>
                You can enable location anytime in Settings
              </Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </SafeAreaView>
  );
}




