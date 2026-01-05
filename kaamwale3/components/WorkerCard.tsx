import React from 'react';
import { View, Text } from 'react-native';
import { MaterialIcons, FontAwesome5, Ionicons } from '@expo/vector-icons';
import type { WorkerCardType } from '@/data/WorkerCardData';
import styles from '../styles/WorkerCardStyles';

type Props = {
  data: WorkerCardType;
};

export default function WorkerCard({ data }: Props) {
  if (!data) return null; 

  const renderIcon = () => {
    switch (data.iconLibrary) {
      case 'MaterialIcons':
        return <MaterialIcons name={data.iconName as any} size={30} color="#007AFF" />;
      case 'FontAwesome5':
        return <FontAwesome5 name={data.iconName as any} size={30} color="#007AFF" />;
      case 'Ionicons':
        return <Ionicons name={data.iconName as any} size={30} color="#007AFF" />;
      default:
        return null;
    }
  };

  return (
    <View style={styles.card}>
      <View style={{ flex: 1, paddingRight: 40 }}>
        <Text style={styles.title}>{data.title}</Text>
        <Text style={styles.description}>{data.description}</Text>
      </View>
      <View style={styles.iconContainer}>{renderIcon()}</View>
    </View>
  );
}
    