import React, { useState } from 'react';
import { ScrollView, View, Text, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import styles from '../styles/FullContainerStyles';
import BannerCarousel from './BannerCarousel';

interface FullContainerProps {
  todayEarnings?: number;
  timeOnOrder?: number;
  todayJobs?: number;
  historyCount?: number;
  totalEarnings?: number;
  offersClaimed?: number;
  pendingOffers?: number;
  activeBonuses?: number;
}

const formatTime = (minutes: number): string => {
  if (!minutes || minutes < 0) return '0h 0m';
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours}h ${mins}m`;
};

// Stat card component for reusability
const StatCard = ({ icon, label, value, color, isLarge = false }: any) => (
  <LinearGradient
    colors={['#1a2f4d', '#152039']} // ✅ Dark blue bubble style
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 1 }}
    style={[styles.statCard, isLarge && styles.statCardLarge]}
  >
    <View style={styles.statIconContainer}>
      <MaterialIcons name={icon} size={isLarge ? 32 : 24} color="#fff" />
    </View>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[styles.statValue, isLarge && styles.statValueLarge]}>{value}</Text>
  </LinearGradient>
);

export default function FullContainer({
  todayEarnings = 0,
  timeOnOrder = 0,
  todayJobs = 0,
  historyCount = 0,
  totalEarnings = 0,
  offersClaimed = 0,
  pendingOffers = 0,
  activeBonuses = 0,
}: FullContainerProps) {
  const [scrollY] = useState(new Animated.Value(0));

  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: false }
  );

  const welcomeScale = scrollY.interpolate({
    inputRange: [-100, 0],
    outputRange: [1.3, 1],
    extrapolate: 'clamp',
  });

  return (
    <ScrollView 
      style={styles.container} 
      contentContainerStyle={styles.scrollContent}
      scrollEventThrottle={16}
      onScroll={handleScroll}
    >
      {/* Welcome Section - Stretches when pulled up */}
      <Animated.View style={[
        styles.welcomeSection,
        { transform: [{ scaleY: welcomeScale }] }
      ]}>
        <Text style={styles.welcomeText}>Today's Overview</Text>
      </Animated.View>

      {/* Today's Progress - Grid Layout */}
      <View style={styles.gridContainer}>
        <View style={styles.gridRow}>
          <StatCard 
            icon="attach-money" 
            label="Today's Earnings" 
            value={`₹${todayEarnings.toLocaleString('en-IN')}`} 
            color="green"
            isLarge={true}
          />
          <StatCard 
            icon="schedule" 
            label="Time on Order" 
            value={formatTime(timeOnOrder)} 
            color="blue"
            isLarge={true}
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard 
            icon="work" 
            label="Jobs Today" 
            value={todayJobs.toString()} 
            color="purple"
          />
          <StatCard 
            icon="history" 
            label="Total History" 
            value={historyCount.toString()} 
            color="orange"
          />
        </View>
      </View>

      {/* Summary Section */}
      <View style={styles.summarySection}>
        <LinearGradient
          colors={['#2d3748', '#1a202c']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.summaryCard}
        >
          <View style={styles.summaryHeader}>
            <MaterialIcons name="trending-up" size={24} color="#10b981" />
            <Text style={styles.summaryTitle}>Overall Statistics</Text>
          </View>
          
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Total Earnings</Text>
              <Text style={styles.summaryValue}>₹{totalEarnings.toLocaleString('en-IN')}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Jobs Completed</Text>
              <Text style={styles.summaryValue}>{offersClaimed}</Text>
            </View>
          </View>

          <View style={[styles.summaryRow, { marginTop: 16 }]}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Pending Offers</Text>
              <Text style={styles.summaryValue}>{pendingOffers}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Active Bonuses</Text>
              <Text style={styles.summaryValue}>₹{activeBonuses.toLocaleString('en-IN')}</Text>
            </View>
          </View>
        </LinearGradient>
      </View>

      {/* Quick Tips Section */}
      <View style={styles.tipsSection}>
        <View style={styles.tipHeader}>
          <MaterialIcons name="lightbulb" size={20} color="#f59e0b" />
          <Text style={styles.tipTitle}>Quick Tips</Text>
        </View>
        <Text style={styles.tipText}>💡 Accept more jobs to increase your daily earnings</Text>
        <Text style={styles.tipText}>⏱️ Complete jobs on time for bonus rewards</Text>
        <Text style={styles.tipText}>⭐ Maintain high ratings for premium job offers</Text>
      </View>

      {/* Banner Carousel */}
      <BannerCarousel />
    </ScrollView>
  );
}
