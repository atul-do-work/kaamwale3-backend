import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  Linking,
  Platform,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

interface Tutorial {
  id: string;
  title: string;
  description: string;
  youtubeUrl: string;
  duration: string;
  icon: string;
  category: 'getting-started' | 'features' | 'safety' | 'earning';
}

const TUTORIALS: Tutorial[] = [
  {
    id: '1',
    title: 'Getting Started with Kaamwale',
    description: 'Learn how to sign up, create your profile, and start accepting jobs.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '5:32',
    icon: 'play-circle',
    category: 'getting-started',
  },
  {
    id: '2',
    title: 'How to Find & Accept Jobs',
    description: 'Explore the job feed and learn how to accept jobs that match your skills.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '4:15',
    icon: 'work',
    category: 'features',
  },
  {
    id: '3',
    title: 'Completing Jobs & Getting Paid',
    description: 'Understand the job completion process and how to receive payments.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '6:48',
    icon: 'payment',
    category: 'features',
  },
  {
    id: '4',
    title: 'Using the Map Feature',
    description: 'Learn how to use the interactive map to find jobs near you.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '3:20',
    icon: 'map',
    category: 'features',
  },
  {
    id: '5',
    title: 'Building Your Reputation',
    description: 'Tips for getting ratings and reviews to build your worker profile.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '4:45',
    icon: 'star',
    category: 'earning',
  },
  {
    id: '6',
    title: 'Safety & Security Tips',
    description: 'Important guidelines to stay safe while working on the platform.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '5:10',
    icon: 'security',
    category: 'safety',
  },
  {
    id: '7',
    title: 'Managing Your Wallet',
    description: 'Learn about wallet balance, deposits, and transactions.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '3:55',
    icon: 'account-balance-wallet',
    category: 'features',
  },
  {
    id: '8',
    title: 'Support & Dispute Resolution',
    description: 'How to contact support and resolve disputes with contractors.',
    youtubeUrl: 'https://youtu.be/dQw4w9WgXcQ',
    duration: '4:30',
    icon: 'help',
    category: 'safety',
  },
];

const CATEGORIES = [
  { id: 'all', label: 'All Videos', icon: 'play-circle' },
  { id: 'getting-started', label: 'Getting Started', icon: 'school' },
  { id: 'features', label: 'Features', icon: 'lightbulb' },
  { id: 'earning', label: 'Earning Tips', icon: 'trending-up' },
  { id: 'safety', label: 'Safety', icon: 'shield' },
];

export default function VideosAndTutorials() {
  const router = useRouter();
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [loading, setLoading] = useState(false);

  const filteredTutorials = selectedCategory === 'all'
    ? TUTORIALS
    : TUTORIALS.filter(t => t.category === selectedCategory);

  const openYouTube = async (url: string, title: string) => {
    try {
      await logActivity('VIDEO_WATCHED', `Watched tutorial: ${title}`);
      await Linking.openURL(url);
    } catch (err) {
      console.error('Error opening URL:', err);
    }
  };

  const renderTutorialCard = (item: Tutorial) => (
    <TouchableOpacity
      style={styles.tutorialCard}
      onPress={() => openYouTube(item.youtubeUrl, item.title)}
      activeOpacity={0.7}
    >
      <View style={styles.cardThumbnail}>
        <MaterialIcons name={item.icon as any} size={48} color="#E74C3C" />
        <View style={styles.playButton}>
          <MaterialIcons name="play-arrow" size={24} color="#fff" />
        </View>
      </View>

      <View style={styles.cardContent}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <Text style={styles.cardDescription} numberOfLines={2}>
          {item.description}
        </Text>
        <View style={styles.cardFooter}>
          <MaterialIcons name="schedule" size={14} color="#95A5A6" />
          <Text style={styles.duration}>{item.duration}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );

  const renderCategoryButton = (category: any) => (
    <TouchableOpacity
      key={category.id}
      style={[
        styles.categoryButton,
        selectedCategory === category.id && styles.categoryButtonActive,
      ]}
      onPress={() => setSelectedCategory(category.id)}
    >
      <MaterialIcons
        name={category.icon as any}
        size={18}
        color={selectedCategory === category.id ? '#fff' : '#3498db'}
      />
      <Text
        style={[
          styles.categoryButtonText,
          selectedCategory === category.id && styles.categoryButtonTextActive,
        ]}
      >
        {category.label}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: Platform.OS === 'ios' ? 12 : 8 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={28} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Videos & Tutorials</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color="#3498db" />
        </View>
      ) : (
        <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
          {/* Info Banner */}
          <View style={styles.infoBanner}>
            <MaterialIcons name="video-library" size={32} color="#fff" />
            <View style={styles.bannerContent}>
              <Text style={styles.bannerTitle}>Learn & Grow</Text>
              <Text style={styles.bannerSubtitle}>
                Watch tutorials to master the platform
              </Text>
            </View>
          </View>

          {/* Categories */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.categoriesScroll}
          >
            <View style={styles.categoriesContainer}>
              {CATEGORIES.map(renderCategoryButton)}
            </View>
          </ScrollView>

          {/* Video Count */}
          <Text style={styles.videoCount}>
            {filteredTutorials.length} video{filteredTutorials.length !== 1 ? 's' : ''}
          </Text>

          {/* Tutorials List */}
          <View>
            {filteredTutorials.map((tutorial) => (
              <View key={tutorial.id}>{renderTutorialCard(tutorial)}</View>
            ))}
          </View>

          {/* Footer */}
          <View style={styles.footerBox}>
            <MaterialIcons name="lightbulb" size={24} color="#F39C12" />
            <Text style={styles.footerText}>
              Found a tutorial helpful? Share it with fellow workers!
            </Text>
          </View>
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
  },
  infoBanner: {
    flexDirection: 'row',
    backgroundColor: '#E74C3C',
    margin: 16,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  bannerContent: {
    marginLeft: 12,
    flex: 1,
  },
  bannerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  bannerSubtitle: {
    fontSize: 13,
    color: '#FADBD8',
    marginTop: 4,
  },
  categoriesScroll: {
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  categoriesContainer: {
    flexDirection: 'row',
    gap: 8,
    paddingRight: 16,
  },
  categoryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#E3F2FD',
    gap: 6,
    borderWidth: 1,
    borderColor: '#3498db',
  },
  categoryButtonActive: {
    backgroundColor: '#3498db',
    borderColor: '#3498db',
  },
  categoryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#3498db',
  },
  categoryButtonTextActive: {
    color: '#fff',
  },
  videoCount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#7F8C8D',
    marginHorizontal: 16,
    marginBottom: 12,
  },
  tutorialCard: {
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: '#fff',
    borderRadius: 12,
    overflow: 'hidden',
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  cardThumbnail: {
    width: 100,
    height: 100,
    backgroundColor: '#F5F5F5',
    justifyContent: 'center',
    alignItems: 'center',
    position: 'relative',
  },
  playButton: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(231, 76, 60, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  cardContent: {
    flex: 1,
    padding: 12,
    justifyContent: 'space-between',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#000',
    marginBottom: 4,
  },
  cardDescription: {
    fontSize: 12,
    color: '#7F8C8D',
    lineHeight: 16,
  },
  cardFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
  },
  duration: {
    fontSize: 12,
    color: '#95A5A6',
    marginLeft: 4,
  },
  footerBox: {
    marginHorizontal: 16,
    marginVertical: 20,
    flexDirection: 'row',
    backgroundColor: '#FEF5E7',
    borderRadius: 12,
    padding: 16,
    alignItems: 'flex-start',
  },
  footerText: {
    flex: 1,
    marginLeft: 12,
    fontSize: 14,
    color: '#A04000',
    lineHeight: 20,
  },
});
