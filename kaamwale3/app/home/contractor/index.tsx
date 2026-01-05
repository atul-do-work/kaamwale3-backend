import React from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView, Alert } from 'react-native';
import { MaterialIcons, FontAwesome } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { socket } from '../../../utils/socket';
import { SERVER_URL } from '../../../utils/config';
import PremiumPlansModal from '../../../components/PremiumPlansModal';
import styles from '../../../styles/ContractorHomeStyles';
const bannerImage = require('../../../assets/discount.jpg');
// @ts-ignore - Image files are properly located in assets folder
const profile = require('../../../assets/oip2.jpg');

export default function ContractorHome() {
  const router = useRouter();
  const [token, setToken] = React.useState<string>('');
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

  // Initialize socket connection on focus
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const savedToken = await AsyncStorage.getItem('token');
          const userStr = await AsyncStorage.getItem('user');
          
          if (savedToken) {
            setToken(savedToken);
            
            let currentUser = null;
            let hasActivePremium = false;
            
            // Fetch user data
            if (userStr) {
              currentUser = JSON.parse(userStr);
              setUserName(currentUser.name || 'You');
              if (currentUser.profilePhoto) {
                setUserProfilePhoto({ uri: currentUser.profilePhoto });
              }
            }
            
            // ✅ If premiumPlan not in localStorage, fetch fresh from backend
            if (!currentUser?.premiumPlan) {
              try {
                const response = await fetch(`${SERVER_URL}/contractor/profile`, {
                  headers: { Authorization: `Bearer ${savedToken}` },
                });
                const data = await response.json();
                
                if (data.success && data.user) {
                  currentUser = { ...currentUser, ...data.user };
                  // Update AsyncStorage with fresh data
                  await AsyncStorage.setItem('user', JSON.stringify(currentUser));
                }
              } catch (err) {
                console.warn('Could not fetch fresh user data:', err);
              }
            }
            
            // ✅ Check if user has an ACTIVE premium plan in their user data
            if (currentUser?.premiumPlan && currentUser.premiumPlan.type) {
              const expiryDate = new Date(currentUser.premiumPlan.expiryDate);
              const now = new Date();
              
              // If premium plan exists and hasn't expired
              if (expiryDate > now) {
                hasActivePremium = true;
                // Save to AsyncStorage for future reference
                await AsyncStorage.setItem('hasPremium', 'true');
              }
            }
            
            setHasPremium(hasActivePremium);
            
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
                // Fallback: try city endpoint if no cached data
                try {
                  const leaderboardRes = await fetch(
                    `${SERVER_URL}/leaderboard/city?latitude=${currentUser?.latitude || 0}&longitude=${currentUser?.longitude || 0}`,
                    {
                      headers: { Authorization: `Bearer ${savedToken}` },
                    }
                  );
                  const leaderboardData = await leaderboardRes.json();
                  
                  if (leaderboardData.leaderboard && Array.isArray(leaderboardData.leaderboard)) {
                    const formattedLeaderboard = leaderboardData.leaderboard.map((contractor: any) => ({
                      id: contractor.contractorId || contractor._id,
                      name: contractor.name,
                      points: contractor.score || 0,
                      profile: contractor.profilePhoto ? contractor.profilePhoto : null,
                      rank: contractor.rank,
                      rating: contractor.avgRating,
                      jobsPosted: contractor.totalJobsPosted,
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
            if (!socket.connected) {
              socket.auth = { token: savedToken };
              socket.connect();
            }

            // Fetch wallet balance and jobs
            await fetchWalletBalance();
            await fetchJobs();
          }
        } catch (err) {
          // Silent fail on token loading
        }
      })();

      return () => {
        // Cleanup on unmount
      };
    }, [])
  );

  const topCards = [
    { id: 1, icon: 'people', amount: activeWorkerCount.toString(), label: 'Active Workers' },
    { id: 2, icon: 'history', amount: jobsDoneCount.toString(), label: 'Jobs Done' },
  ];

  const bottomCard = { id: 3, icon: 'dashboard', amount: '', label: 'Dashboard' };

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
      const savedToken = await AsyncStorage.getItem('token');
      const res = await fetch(`${SERVER_URL}/wallet/balance`, {
        headers: { Authorization: `Bearer ${savedToken}` },
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
      const savedToken = await AsyncStorage.getItem('token');
      const res = await fetch(`${SERVER_URL}/jobs`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${savedToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!res.ok) throw new Error('Failed to fetch jobs');

      const data = await res.json();
      setJobs(data);

      // Count active workers (unpaid jobs with accepted workers)
      const unpaidJobs = data.filter((job: any) => job.paymentStatus !== 'Paid' && job.acceptedBy);
      const uniqueUnpaidWorkers = new Set(unpaidJobs.map((job: any) => job.acceptedBy));
      setActiveWorkerCount(uniqueUnpaidWorkers.size);

      // Count jobs done (paid jobs)
      const paidJobs = data.filter((job: any) => job.paymentStatus === 'Paid');
      setJobsDoneCount(paidJobs.length);
    } catch (err) {
      console.error('Job fetch error:', err);
    }
  };

  const handlePlanSelected = async (planId: string) => {
    try {
      // ✅ Save premium status to AsyncStorage
      await AsyncStorage.setItem('hasPremium', 'true');
      
      // Close modal
      setPremiumModalVisible(false);
      
      // Set premium status
      setHasPremium(true);
      
      // ✅ Fetch city-based leaderboard using cached data
      const cachedLeaderboard = await AsyncStorage.getItem('leaderboard');
      if (cachedLeaderboard) {
        const leaderboardData = JSON.parse(cachedLeaderboard);
        
        // Support both data formats
        const boardData = Array.isArray(leaderboardData) ? leaderboardData : leaderboardData.leaderboard || [];
        
        const formattedLeaderboard = boardData.map((contractor: any) => ({
          id: contractor.contractorId || contractor._id || contractor.phone,
          name: contractor.name,
          points: contractor.score || contractor.points || 0,
          profile: contractor.profilePhoto ? { uri: contractor.profilePhoto } : userProfilePhoto,
          rank: contractor.rank,
          rating: contractor.avgRating,
          jobsPosted: contractor.totalJobsPosted,
          tier: contractor.tier,
        }));
        
        setLeaderboard(formattedLeaderboard);
        console.log('✅ Leaderboard loaded after premium purchase:', formattedLeaderboard);
      } else {
        console.warn('⚠️ No cached leaderboard found after premium purchase');
      }
    } catch (err) {
      console.warn('Could not fetch leaderboard after plan selection:', (err as Error).message);
    }
  };

  return (
    <View style={styles.container}>
      {/* Header with Gradient */}
      <LinearGradient 
        colors={['#1a2f4d', '#2d5a8c']} 
        start={{ x: 0, y: 0 }} 
        end={{ x: 1, y: 1 }}
        style={styles.headerContainer}
      >
        <View style={styles.headerContent}>
          <View>
            <Text style={styles.dashboardText}>Dashboard</Text>
            <Text style={styles.greetingText}>Good Morning, {userName}</Text>
          </View>
          <TouchableOpacity 
            style={styles.bellContainer}
            onPress={() => router.push("/NotificationHistory" as any)}
          >
            <MaterialIcons name="notifications-none" size={28} color="#000" />
          </TouchableOpacity>
        </View>
      </LinearGradient>

      {/* Top cards */}
      <View style={styles.topRow}>
        {topCards.map((card) => (
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

          {/* Leaderboard cards - Current user on top */}
          <ScrollView style={styles.leaderboardScroll} showsVerticalScrollIndicator={false}>
            {leaderboard
              .sort((a, b) => {
                // Current user always on top
                if (a.name === userName) return -1;
                if (b.name === userName) return 1;
                // Then sort by rank
                return (a.rank || 999) - (b.rank || 999);
              })
              .map((person, index) => {
                const isCurrentUser = person.name === userName;
                const displayRank = isCurrentUser ? person.rank : (index > 0 ? leaderboard.find((p) => p.name === person.name)?.rank || index : index + 1);
                
                return (
                  <View
                    key={person.id}
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
              })}
          </ScrollView>
        </View>
      </View>

      {/* Premium Plans Modal */}
      <PremiumPlansModal
        visible={premiumModalVisible}
        onClose={() => setPremiumModalVisible(false)}
        onPlanSelected={handlePlanSelected}
      />
    </View>
  );
}

