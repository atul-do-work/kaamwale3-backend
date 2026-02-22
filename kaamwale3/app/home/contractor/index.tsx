import React, { useEffect, useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, FlatList, Alert, Modal } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons, FontAwesome } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import { socket } from '../../../utils/socket';
import { SERVER_URL } from '../../../utils/config';
import { API_BASE } from '../../../utils/config';
import PremiumPlansModal from '../../../components/PremiumPlansModal';
import { useLanguage } from '../../../context/LanguageContext';
import { useAuth } from '../../../context/AuthContext';
import styles from '../../../styles/ContractorHomeStyles';
const bannerImage = require('../../../assets/discount.jpg');
const profile = require('../../../assets/oip2.jpg');

export default function ContractorHome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const [premiumModalVisible, setPremiumModalVisible] = React.useState(false);
  const [hasPremium, setHasPremium] = React.useState(false);
  const [userName, setUserName] = React.useState('You');
  const [userProfilePhoto, setUserProfilePhoto] = React.useState(profile);
  const [leaderboard, setLeaderboard] = React.useState<any[]>([]);
  const [leaderboardExpanded, setLeaderboardExpanded] = React.useState(false);
  const [walletBalance, setWalletBalance] = React.useState(0);
  const [jobs, setJobs] = React.useState<any[]>([]);
  const [activeWorkerCount, setActiveWorkerCount] = React.useState(0);
  const [jobsDoneCount, setJobsDoneCount] = React.useState(0);
  const [postedCount, setPostedCount] = React.useState(0);
  const [totalSpending, setTotalSpending] = React.useState(0);
  const [workersEngaged, setWorkersEngaged] = React.useState(0);
  const [notificationCount, setNotificationCount] = React.useState<number>(0); // ✅ Add notification count state
  const [showLocationModal, setShowLocationModal] = React.useState<boolean>(false); // ✅ Location modal state
  const [requestingLocation, setRequestingLocation] = React.useState<boolean>(false); // ✅ Loading state for location request
  // ✅ Removed dead token state - use accessToken from context instead

  // ✅ Separate premium listener effect - runs on login, not on every tab focus
  React.useEffect(() => {
    if (!accessToken) return;

    const handlePremiumSubscriptionUpdate = async (data: any) => {
      console.log(`📢 Premium subscription update received from contractor ${data.contractorPhone}`);
      
      try {
        const userStr = await AsyncStorage.getItem('user');
        let latitude = 0, longitude = 0;
        if (userStr) {
          const u = JSON.parse(userStr);
          latitude = u.latitude || 0;
          longitude = u.longitude || 0;
        }
        
        const leaderboardRes = await fetch(
          `${SERVER_URL}/leaderboard/contractors/by-district?lat=${latitude}&lon=${longitude}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        
        if (!leaderboardRes.ok) {
          console.warn(`⚠️ Leaderboard refresh failed with status ${leaderboardRes.status}`);
          return;
        }
        
        const leaderboardData = await leaderboardRes.json();
        
        if (leaderboardData.leaderboard && Array.isArray(leaderboardData.leaderboard)) {
          const formattedLeaderboard = leaderboardData.leaderboard.map((contractor: any) => ({
            id: contractor.phone || contractor._id || 'unknown', // ✅ Use phone as ID, fall back to _id
            name: contractor.name || 'Unknown',
            points: contractor.score || 0,
            profile: contractor.profilePhoto ? contractor.profilePhoto : null,
            rank: contractor.rank || 0,
            rating: contractor.rating ?? contractor.averageRating ?? 0, // ✅ Default 0 instead of undefined
            jobsPosted: contractor.jobCount ?? contractor.totalJobsPosted ?? 0, // ✅ Default 0 instead of undefined
            tier: contractor.tier || 'new',
          }));
          setLeaderboard(formattedLeaderboard);
          console.log('✅ Leaderboard refreshed after premium subscription update:', formattedLeaderboard);
        }
      } catch (err) {
        console.error('Error refreshing leaderboard on subscription update:', (err as Error).message);
      }
    };

    socket.on('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);

    return () => {
      socket.off('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);
    };
  }, [accessToken]);

  const premiumSubUpdateHandlerRef = React.useRef<any>(null);

  // ✅ Memoize sorted leaderboard to prevent re-sorting on every render
  // CRITICAL: Clone array before sorting to avoid mutating React state
  const sortedLeaderboard = React.useMemo(() => {
    return [...leaderboard].sort((a, b) => {
      // Current user always on top
      if (a.name === userName) return -1;
      if (b.name === userName) return 1;
      // Then sort by rank
      return (a.rank || 999) - (b.rank || 999);
    });
  }, [leaderboard, userName]);
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const savedToken = accessToken;
          const userStr = authUser ? JSON.stringify(authUser) : null;

          if (savedToken) {
            let currentUser = null;
            let hasActivePremium = false;

            // Fetch user data
            if (authUser) {
              currentUser = authUser;
              setUserName(currentUser.name || 'You');
              if (currentUser.profilePhoto) {
                setUserProfilePhoto({ uri: currentUser.profilePhoto });
              }
            }
            
            // ✅ If premiumPlan not in localStorage, fetch fresh from backend
            if (!currentUser?.premiumPlan) {
              try {
                const response = await fetch(`${SERVER_URL}/users/profile`, {
                  headers: { Authorization: `Bearer ${savedToken}` },
                });
                if (response.ok) {
                  const data = await response.json();
                  
                  if (data.success && data.user) {
                    currentUser = { ...currentUser, ...data.user };
                    // Update AsyncStorage with fresh data
                    await AsyncStorage.setItem('user', JSON.stringify(currentUser));
                  }
                } else {
                  console.warn(`⚠️ Profile fetch returned status ${response.status}`);
                }
              } catch (err) {
                console.warn('Could not fetch fresh user data:', err);
              }
            }
            
            // ✅ Check if user has an ACTIVE premium plan - validate against expiry date
            // Always check expiry date for current validity, don't rely solely on cached boolean
            const cachedPremium = await AsyncStorage.getItem('hasPremium');
            
            if (cachedPremium === 'true' && currentUser?.premiumPlan?.expiryDate) {
              // Verify cached premium is still valid by checking expiry
              const expiryDate = new Date(currentUser.premiumPlan.expiryDate);
              const now = new Date();
              
              if (expiryDate > now) {
                hasActivePremium = true;
                console.log('✅ Premium status verified - cached and valid, expiry:', currentUser.premiumPlan.expiryDate);
              } else {
                console.log('⚠️ Cached premium expired:', currentUser.premiumPlan.expiryDate);
                hasActivePremium = false;
                await AsyncStorage.removeItem('hasPremium');
              }
            } else if (currentUser?.premiumPlan?.expiryDate) {
              // Check the premium plan data from user object
              const expiryDate = new Date(currentUser.premiumPlan.expiryDate);
              const now = new Date();
              
              // If premium plan hasn't expired
              if (expiryDate > now) {
                hasActivePremium = true;
                console.log('✅ Premium status - actively verified, expiry:', currentUser.premiumPlan.expiryDate);
              } else {
                console.log('⚠️ Premium subscription has expired:', currentUser.premiumPlan.expiryDate);
              }
            }
            
            setHasPremium(hasActivePremium);
            
            // ✅ Persist premium status for next time (tab switch, etc.)
            if (hasActivePremium) {
              await AsyncStorage.setItem('hasPremium', 'true');
            } else {
              await AsyncStorage.removeItem('hasPremium');
            }
            
            // ✅ Don't auto-show premium modal - only show when user clicks "Upgrade Now"
            // Modal will show on demand only
            
            // ✅ Only fetch leaderboard if user has premium
            try {
              const cachedLeaderboard = await AsyncStorage.getItem('leaderboard');
              if (cachedLeaderboard) {
                const leaderboardData = JSON.parse(cachedLeaderboard);
                console.log('📊 Cached leaderboard data:', leaderboardData);
                
                // The data can come in two formats:
                // 1. { leaderboard: [...], myRank, myScore, ... } (from login response)
                // 2. Array directly (legacy format)
                const boardData = Array.isArray(leaderboardData) ? leaderboardData : leaderboardData.leaderboard || [];
                
                const formattedLeaderboard = boardData.map((contractor: any) => ({
                  id: contractor.contractorId || contractor._id || contractor.phone,
                  name: contractor.name,
                  points: contractor.score || contractor.points || 0,
                  profile: contractor.profilePhoto ? contractor.profilePhoto : null,
                  rank: contractor.rank,
                  rating: contractor.avgRating,
                  jobsPosted: contractor.totalJobsPosted,
                  tier: contractor.tier,
                }));
                
                console.log('✅ Formatted leaderboard:', formattedLeaderboard);
                setLeaderboard(formattedLeaderboard);
              } else {
                // Fallback: try district-based leaderboard if no cached data
                try {
                  const leaderboardRes = await fetch(
                    `${SERVER_URL}/leaderboard/contractors/by-district?lat=${currentUser?.latitude || 0}&lon=${currentUser?.longitude || 0}`,
                    {
                      headers: { Authorization: `Bearer ${savedToken}` },
                    }
                  );
                  const leaderboardData = await leaderboardRes.json();
                  
                  if (leaderboardData.leaderboard && Array.isArray(leaderboardData.leaderboard)) {
                    const formattedLeaderboard = leaderboardData.leaderboard.map((contractor: any) => ({
                      id: contractor.contractorId || contractor._id || contractor.phone,
                      name: contractor.name,
                      points: contractor.score || 0,
                      profile: contractor.profilePhoto ? contractor.profilePhoto : null,
                      rank: contractor.rank,
                      rating: contractor.rating,
                      jobsPosted: contractor.jobCount,
                      tier: contractor.tier,
                    }));
                    setLeaderboard(formattedLeaderboard);
                    console.log('✅ Fetched leaderboard from API:', formattedLeaderboard);
                  }
                } catch (err) {
                  console.warn('Could not fetch leaderboard:', (err as Error).message);
                }
              }
            } catch (err) {
              console.warn('Error loading leaderboard:', (err as Error).message);
            }
            
            // Global socket already created at login
            // Just ensure it's connected
            if (!socket.connected && savedToken) {
              socket.auth = { token: savedToken };
              socket.connect();
            }

            // Fetch wallet balance and jobs in parallel
            await Promise.all([
              fetchWalletBalance(),
              fetchJobs(),
              fetchNotificationCount()
            ]);
          }
        } catch (err) {
          // Silent fail on token loading
        }
      })();

      return () => {
        // ✅ Socket listener cleanup is now handled in separate useEffect
        // This useFocusEffect focuses on data fetching
      };
    }, [accessToken, authUser])
  );

  const topCards = [
    { id: 1, icon: 'work', amount: postedCount.toString(), label: t('jobsPosted') },
    { id: 2, icon: 'check-circle', amount: jobsDoneCount.toString(), label: t('jobsCompleted') },
    { id: 3, icon: 'people', amount: workersEngaged.toString(), label: t('workers') },
    { id: 4, icon: 'attach-money', amount: `₹${totalSpending}`, label: t('spending') },
  ];

  const bottomCard = { id: 3, icon: 'dashboard', amount: '', label: t('dashboard') };

  // Leaderboard is now populated from state in useFocusEffect

  const getMedal = (rank: string | number) => {
    if (rank === 'You' || rank === 0) {
      return <FontAwesome name="star" size={20} color="#FF6B6B" />; // Current user badge
    }
    switch (rank) {
      case 1:
        return <FontAwesome name="trophy" size={20} color="#FFD700" />; // Gold
      case 2:
        return <FontAwesome name="trophy" size={20} color="#C0C0C0" />; // Silver
      case 3:
        return <FontAwesome name="trophy" size={20} color="#CD7F32" />; // Bronze
      default:
        return <Text style={{ fontSize: 14, width: 24, color: '#666', fontWeight: '600' }}>{rank}</Text>;
    }
  };

  const handleUpgrade = () => {
    setPremiumModalVisible(true);
  };

  const fetchWalletBalance = async () => {
    try {
      if (!accessToken) {
        console.warn('No access token available');
        return;
      }
      const res = await fetch(`${SERVER_URL}/wallet/balance`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (data.balance !== undefined) {
        setWalletBalance(data.balance);
      }
    } catch (err) {
      // Silently fail - wallet might not exist yet
    }
  };

  const fetchJobs = async () => {
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
      setJobs(data);

      // Filter jobs posted by this contractor
      const myJobs = data.filter((job: any) => job.contractorName === authUser?.name && !job.isCancelled); // ✅ Use authUser.name to avoid stale userName state
      setPostedCount(myJobs.length);

      // Count active/unpaid workers for contractor jobs
      const unpaidJobs = myJobs.filter((job: any) => job.paymentStatus !== 'Paid' && (job.acceptedBy || (job.acceptedWorkers && job.acceptedWorkers.length > 0)));
      const uniqueUnpaidWorkers = new Set(unpaidJobs.flatMap((job: any) => job.acceptedWorkers && job.acceptedWorkers.length ? job.acceptedWorkers.map((w: any) => w.phone || w) : (job.acceptedBy ? [job.acceptedBy] : [])));
      setActiveWorkerCount(uniqueUnpaidWorkers.size);
      setWorkersEngaged(uniqueUnpaidWorkers.size);

      // Count jobs done (paid jobs for this contractor)
      const paidJobs = myJobs.filter((job: any) => job.paymentStatus === 'Paid');
      setJobsDoneCount(paidJobs.length);

      // Total spending by contractor (sum of amounts for paid jobs)
      const spending = paidJobs.reduce((sum: number, j: any) => sum + (Number(j.amount) || 0), 0);
      setTotalSpending(spending);
      
      // ✅ Save last posted job ID for waiting screen access
      if (myJobs.length > 0) {
        const lastJob = myJobs[myJobs.length - 1]; // Most recent job
        try {
          await AsyncStorage.setItem('lastJobId', lastJob._id);
          console.log('✅ Last job ID saved:', lastJob._id);
        } catch (err) {
          console.warn('Could not save lastJobId:', err);
        }
      }
    } catch (err) {
      console.error('Job fetch error:', err);
    }
  };

  // ✅ Fetch notification count
  const fetchNotificationCount = async () => {
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
  };

  // ✅ REQUEST AND UPDATE LOCATION FOR CONTRACTOR
  const requestAndUpdateLocation = async (): Promise<boolean> => {
    try {
      setRequestingLocation(true);
      console.log('📍 Requesting location permission for contractor...');

      const { status } = await Location.requestForegroundPermissionsAsync();
      
      if (status !== 'granted') {
        console.warn('⚠️ Location permission denied');
        return false;
      }

      console.log('✅ Location permission granted, getting position...');
      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const latitude = location.coords.latitude;
      const longitude = location.coords.longitude;

      console.log(`📍 Location obtained: lat=${latitude}, lon=${longitude}`);

      // Update location on backend
      console.log(`🌐 Sending location update to ${API_BASE}/user/update-location`);
      const response = await fetch(`${API_BASE}/user/update-location`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ latitude, longitude }),
      });

      console.log(`📊 Backend response status: ${response.status}`);
      const data = await response.json();
      console.log(`📦 Backend response data:`, data);

      if (!response.ok) {
        console.error('❌ Backend returned error status:', response.status, data.message);
        return false;
      }

      if (!data.success) {
        console.error('❌ Backend returned success=false:', data.message);
        return false;
      }

      console.log('✅ Location updated on backend:', data.user);
      
      // Update local user data
      const userStr = await AsyncStorage.getItem('user');
      if (userStr) {
        const user = JSON.parse(userStr);
        user.latitude = data.user.latitude;
        user.longitude = data.user.longitude;
        user.city = data.user.city;
        user.state = data.user.state;
        await AsyncStorage.setItem('user', JSON.stringify(user));
        console.log('✅ Contractor location data updated in local storage');
      }

      // Close modal after successful location update
      console.log('🔄 Closing location modal...');
      setShowLocationModal(false);
      console.log(`✅ Location enabled! City: ${data.user.city}, State: ${data.user.state}`);
      return true;
    } catch (err) {
      console.error('❌ Error requesting location:', err);
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`Error details: ${errorMsg}`);
      return false;
    } finally {
      console.log('🟢 Cleanup: Setting requestingLocation to false');
      setRequestingLocation(false);
    }
  };

  // ✅ CHECK FOR DEFAULT LOCATION AND SHOW MODAL POST-LOGIN
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
          console.log("📍 Contractor has default location (0,0) - showing location permission modal");
          setShowLocationModal(true);
        } else {
          console.log("✅ Contractor already has location set:", { lat: user.latitude, lon: user.longitude });
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
      
      // ✅ Save premium status to AsyncStorage
      await AsyncStorage.setItem('hasPremium', 'true');
      
      // ✅ Fetch updated user data from backend and save to AsyncStorage with premium plan info
      try {
        const response = await fetch(`${SERVER_URL}/users/profile`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (response.ok) {
          const data = await response.json();
          if (data.success && data.user) {
            // Update user in AsyncStorage with fresh data including premium plan
            await AsyncStorage.setItem('user', JSON.stringify(data.user));
            console.log('✅ Updated user data with premium plan:', data.user.premiumPlan);
          }
        }
      } catch (err) {
        console.warn('Could not fetch fresh user data after plan purchase:', err);
      }
      
      // Close modal
      setPremiumModalVisible(false);
      
      // Set premium status immediately
      setHasPremium(true);
      
      // ✅ FETCH FRESH LEADERBOARD FROM NEW DISTRICT ENDPOINT AFTER PREMIUM PURCHASE
      try {
        const userStr = await AsyncStorage.getItem('user');
        let latitude = 0, longitude = 0;
        if (userStr) {
          const u = JSON.parse(userStr);
          latitude = u.latitude || 0;
          longitude = u.longitude || 0;
        }
        
        const leaderboardRes = await fetch(
          `${SERVER_URL}/leaderboard/contractors/by-district?lat=${latitude}&lon=${longitude}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );
        
        if (!leaderboardRes.ok) {
          console.warn(`⚠️ Leaderboard fetch failed with status ${leaderboardRes.status}`);
          return;
        }
        
        const leaderboardData = await leaderboardRes.json();
        
        if (leaderboardData.leaderboard && Array.isArray(leaderboardData.leaderboard)) {
          const formattedLeaderboard = leaderboardData.leaderboard.map((contractor: any) => ({
            id: contractor.phone,
            name: contractor.name,
            points: contractor.score || 0,
            profile: contractor.profilePhoto ? { uri: contractor.profilePhoto } : userProfilePhoto,
            rank: contractor.rank,
            rating: contractor.rating,
            jobsPosted: contractor.jobCount,
            tier: contractor.tier,
          }));
          setLeaderboard(formattedLeaderboard);
          
          // ✅ ALSO CACHE THE FRESH DATA FOR LATER USE
          await AsyncStorage.setItem('leaderboard', JSON.stringify(leaderboardData));
          console.log('✅ Fresh leaderboard fetched from new district endpoint after premium purchase:', formattedLeaderboard);
        } else {
          console.warn('⚠️ No leaderboard data from backend after premium purchase');
        }
      } catch (err) {
        console.error('Error fetching fresh leaderboard after premium purchase:', (err as Error).message);
      }
    } catch (err) {
      console.warn('Could not complete premium plan selection:', (err as Error).message);
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t('goodMorning');
    if (hour < 17) return t('goodAfternoon');
    return t('goodEvening');
  };

  return (
    <SafeAreaView
      edges={['top', 'left', 'right', 'bottom']}
      style={[styles.container, { paddingBottom: Math.max(insets.bottom, 12) }]}
    >
      {/* Header with Gradient */}
      <LinearGradient 
        colors={['#1a2f4d', '#2d5a8c']} 
        start={{ x: 0, y: 0 }} 
        end={{ x: 1, y: 1 }}
        style={styles.headerContainer}
      >
        <View style={styles.headerContent}>
          {/* ✅ Circular Profile Photo on Left */}
          <TouchableOpacity 
            onPress={() => router.push('/home/contractor/profile' as any)}
            style={styles.headerProfileContainer}
          >
            <Image source={userProfilePhoto} style={styles.headerProfilePhoto} />
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.bellContainer}
            onPress={() => router.push("/NotificationHistory" as any)}
          >
            <MaterialIcons name="notifications-none" size={28} color="#000" />
            {notificationCount > 0 && ( // ✅ Show badge if unread notifications exist
              <View style={styles.badge}>
                <Text style={styles.badgeText}>
                  {notificationCount > 9 ? '9+' : notificationCount}
                </Text>
              </View>
            )}
          </TouchableOpacity>
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
      <View style={[styles.leaderboardWrapper, leaderboardExpanded && styles.leaderboardWrapperExpanded]}>
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
            {hasPremium && (
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
          {!hasPremium && (
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
          {hasPremium && sortedLeaderboard.length > 0 ? (
            <FlatList
              data={sortedLeaderboard}
              keyExtractor={(person) => person.id}
              style={styles.leaderboardScroll}
              showsVerticalScrollIndicator={false}
              scrollEnabled={true}
              initialNumToRender={5}
              maxToRenderPerBatch={5}
              windowSize={5}
              removeClippedSubviews={true}
              renderItem={({ item: person, index }) => {
                const isCurrentUser = person.name === userName;
                // ✅ No need to .find() - rank is already set correctly after sorting
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

      {/* ✅ POST-LOGIN LOCATION PERMISSION MODAL FOR CONTRACTOR */}
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

