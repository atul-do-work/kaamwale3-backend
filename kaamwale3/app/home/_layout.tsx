import { Stack } from 'expo-router';

/**
 * Home layout - Expo Router auto-discovers child routes
 * Role-based routing is handled in home/index.tsx
 */
export default function Layout() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      {/* Let Expo Router auto-discover home/index, home/worker/*, home/contractor/* */}
    </Stack>
  );
}
