import React, { useRef, useEffect, useState } from 'react';
import { View, ScrollView, Image, Dimensions, StyleSheet } from 'react-native';

const { width } = Dimensions.get('window');

const banners = [
  require('../assets/oip2.jpg'),
  require('../assets/oip2.jpg'),
  require('../assets/oip2.jpg'),
];
 
export default function BannerCarousel() {
  const scrollRef = useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      const nextIndex = (currentIndex + 1) % banners.length;
      setCurrentIndex(nextIndex);
      scrollRef.current?.scrollTo({ x: nextIndex * (width - 40), animated: true });
    }, 2500); // change banner every 3 seconds

    return () => clearInterval(interval);
  }, [currentIndex]);

  return (
    <View style={styles.container}>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        pagingEnabled
        scrollEnabled={false} // auto scroll only
        contentContainerStyle={styles.scrollContent}
      >
        {banners.map((banner, index) => (
          <Image key={index} source={banner} style={styles.bannerImage} resizeMode="cover" />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: 120, // small height
    marginTop: 12,
  },
  scrollContent: {
    alignItems: 'center',
  },
  bannerImage: {
    width: width - 40,
    height: 120,
    borderRadius: 12,
    marginHorizontal: 10,
  },
});
