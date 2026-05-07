import React, { useState, useCallback } from 'react';
import { ScrollView, View, Text, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import styles from '../styles/FullContainerStyles';
import { useLanguage } from '../context/LanguageContext';

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
  loading?: boolean;
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
StatCard.displayName = 'StatCard';

export default function FullContainer({
  todayEarnings = 0,
  timeOnOrder = 0,
  todayJobs = 0,
  historyCount = 0,
  totalEarnings = 0,
  offersClaimed = 0,
  averageRating = 0,
  activeBonuses = 0,
  loading = false,
  onRefresh,
}: FullContainerProps) {
  const { t } = useLanguage();
  const [refreshing, setRefreshing] = useState(false);

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
      // ✅ Add pull-to-refresh
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor="#667eea"
          title={t('pullToRefresh')}
        />
      }
    >
      {/* Welcome Section */}
      <View style={styles.welcomeSection}>
        <Text style={styles.welcomeText}>{t('todaysOverview')}</Text>
      </View>

      {loading ? (
        <View style={{ gap: 12 }}>
          <View style={{ height: 140, borderRadius: 16, backgroundColor: '#dbe2ee' }} />
          <View style={{ height: 140, borderRadius: 16, backgroundColor: '#e2e8f4' }} />
          <View style={{ height: 200, borderRadius: 16, backgroundColor: '#cfd9e8' }} />
        </View>
      ) : (
        <>

      {/* Today's Progress - Grid Layout */}
      <View style={styles.gridContainer}>
        <View style={styles.gridRow}>
          <StatCard 
            icon="attach-money" 
            label={t('todaysEarnings')}
            value={`₹${(todayEarnings ?? 0).toLocaleString('en-IN')}`}
            color="#10b981"
            isLarge={true}
          />
          <StatCard 
            icon="schedule" 
            label={t('timeOnOrder')}
            value={formatTime(timeOnOrder)} 
            color="#3b82f6"
            isLarge={true}
          />
        </View>
        <View style={styles.gridRow}>
          <StatCard 
            icon="work" 
            label={t('jobsToday')}
            value={todayJobs.toString()} 
            color="#8b5cf6"
          />
          <StatCard 
            icon="history" 
            label={t('totalHistory')}
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
            <Text style={styles.summaryTitle}>{t('overallStatistics')}</Text>
          </View>
          
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>{t('totalEarnings')}</Text>
              <Text style={[styles.summaryValue, styles.summaryValueLarge]}>₹{(totalEarnings ?? 0).toLocaleString('en-IN')}</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>{t('jobsCompleted')}</Text>
              <Text style={styles.summaryValue}>{offersClaimed}</Text>
            </View>
          </View>

          <View style={[styles.summaryRow, { marginTop: 16 }]}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>{t('avgRatingCompleted')}</Text>
              <Text style={styles.summaryValue}>{(averageRating || 0).toFixed(2)} ⭐</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryLabel}>{t('activeBonuses')}</Text>
              <Text style={[styles.summaryValue, styles.summaryValueLarge]}>₹{(activeBonuses ?? 0).toLocaleString('en-IN')}</Text>
            </View>
          </View>
        </LinearGradient>
      </View>

      {/* Quick Tips removed */}
        </>
      )}
    </ScrollView>
  );
}
