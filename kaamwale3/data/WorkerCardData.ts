export type WorkerCardType = {
  id: number;
  title: string;
  description: string;
  iconLibrary: 'MaterialIcons' | 'FontAwesome5' | 'Ionicons';
  iconName: string;
};

export const workerCards: WorkerCardType[] = [
  {
    id: 1,
    title: 'Hotspot Area 1',
    description: 'Nearby construction site',
    iconLibrary: 'MaterialIcons',
    iconName: 'construction',
  },
  {
    id: 2,
    title: 'Hotspot Area 2',
    description: 'Urgent task nearby',
    iconLibrary: 'FontAwesome5',
    iconName: 'hard-hat',
  },
  {
    id: 3,
    title: 'Hotspot Area 3',
    description: 'Available job',
    iconLibrary: 'Ionicons',
    iconName: 'location-sharp',
  },
];

