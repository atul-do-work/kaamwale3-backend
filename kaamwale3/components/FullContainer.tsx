import React, { useState, useCallback } from 'react';
import { ScrollView, View, Text, Animated, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import styles from '../styles/FullContainerStyles';

// ✅ Helper function to format seconds into time string
const formatTime = (seconds: number): string => {
  if (seconds < 60) {
    return `${Math.floor(seconds)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
};

interface FullContainerProps {
  todayEarnings?: number;
  timeOnOrder?: number;
  todayJobs?: number;
  historyCount?: number;
  totalEarnings?: number;
  offersClaimed?: number;
  averageRating?: number;
  activeBonuses?: number;
  onRefresh?: () => void;
}

interface StatCardProps {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  value: string;
  color?: string;
  isLarge?: boolean;
}

// ✅ Memoized StatCard to prevent re-renders on scroll
const StatCard = React.memo(({ icon, label, value, color = '#667eea', isLarge = false }: StatCardProps) => (
  <LinearGradient
    colors={['#1a2f4d', '#152039']}
    start={{ x: 0, y: 0 }}
    end={{ x: 1, y: 1 }}
    style={[styles.statCard, isLarge && styles.statCardLarge]}
  >
    {/* ✅ Use dynamic color for icon background */}
    <View style={[styles.statIconContainer, { backgroundColor: color }]}>
      <MaterialIcons name={icon} size={isLarge ? 32 : 24} color="#fff" />
    </View>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[styles.statValue, isLarge && styles.statValueLarge]}>{value}</Text>
  </LinearGradient>
));

export default function FullContainer({
  todayEarnings = 0,
  timeOnOrder = 0,
  todayJobs = 0,
  historyCount = 0,
  totalEarnings = 0,
  offersClaimed = 0,
  averageRating = 0,
  activeBonuses = 0,
  onRefresh,
}: FullContainerProps) {
  const [scrollY] = useState(new Animated.Value(0));
  const [refreshing, setRefreshing] = useState(false);

  // ✅ Use native driver for better performance
  const handleScroll = Animated.event(
    [{ nativeEvent: { contentOffset: { y: scrollY } } }],
    { useNativeDriver: false } // ✅ FIX: Disabled native driver to prevent scroll crashes
  );

  // ✅ Wrap scroll handler with error boundary
  const safeHandleScroll = useCallback((event: any) => {
    try {
      if (handleScroll && typeof handleScroll === 'function') {
        handleScroll(event);
      }
    } catch (err) {
      console.error('Scroll handler error:', err);
    }
  }, [handleScroll]);

  // ✅ Better interpolation values for subtle stretch
  const welcomeScale = scrollY.interpolate({
    inputRange: [-80, 0],
    outputRange: [1.15, 1],
    extrapolate: 'clamp',
  });

  // ✅ Memoize refresh handler to prevent recreation on every render
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // ✅ FIX: Safe function call with proper error handling
      if (onRefresh) {
        try {
          await Promise.resolve(onRefresh());
        } catch (callErr) {
          // Fallback if onRefresh throws
          console.error('onRefresh callback error:', callErr);
        }
      }
    } catch (err) {
      console.error('Refresh error:', err);
    } finally {
      setRefreshing(false);
    }
  }, [onRefresh]);

  return (
    <ScrollView 
      style={styles.container} 
      contentContainerStyle={styles.scrollContent}
      scrollEventThrottle={16}
      onScroll={safeHandleScroll}
      // ✅ Add pull-to-refresh
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor="#667eea"
          title="Pull to refresh"
        />
      }
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
            value={`₹${(todayEarnings ?? 0).toLocaleString('en-IN')}`}
            color="#10b981"
            isLarge={true}
          />
          <StatCard 
            icon="schedule" 
            label="Time on Order" 
            value={formatTime(timeOnOrder)} 
            color="#3b82f6"
            isLarge={true}
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard 
            icon="work" 
            label="Jobs Today" 
            value={todayJobs.toString()} 
            color="#8b5cf6"
          />
          <StatCard 
            icon="history" 
            label="Total History" 
            value={historyCount.toString()} 
            color="#f59e0b"
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
              <Text style={[styles.summaryValue, styles.summaryValueLarge]}>₹{(totalEarnings ?? 0).toLocaleString('en-IN')}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Jobs Completed</Text>
              <Text style={styles.summaryValue}>{offersClaimed}</Text>
            </View>
          </View>

          <View style={[styles.summaryRow, { marginTop: 16 }]}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Avg Rating (Completed)</Text>
              <Text style={styles.summaryValue}>{(averageRating || 0).toFixed(2)} ⭐</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>Active Bonuses</Text>
              <Text style={[styles.summaryValue, styles.summaryValueLarge]}>₹{(activeBonuses ?? 0).toLocaleString('en-IN')}</Text>
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
    </ScrollView>
  );
}
