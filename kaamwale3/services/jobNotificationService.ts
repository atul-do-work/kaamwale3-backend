import * as Haptics from 'expo-haptics';
import { Audio } from 'expo-av';
import { Platform } from 'react-native';

let sound: Audio.Sound | null = null;
let vibrationInterval: ReturnType<typeof setInterval> | null = null;
let autoStopTimeout: ReturnType<typeof setTimeout> | null = null;

export const triggerJobAlert = async () => {
  try {
    console.log('🔔 Starting job alert...');
    
    // Always cleanup previous sound
    if (sound) {
      try {
        await sound.unloadAsync();
      } catch (e) {
        console.warn('Warning unloading previous sound:', e);
      }
      sound = null;
    }

    // VIBRATION - Always works (even in silent mode)
    console.log('📳 Triggering vibration...');
    try {
      await Haptics.notificationAsync(
        Haptics.NotificationFeedbackType.Success
      );
      console.log('✅ Notification vibration triggered');
    } catch (e) {
      console.warn('⚠️ Notification vibration failed:', e);
    }
    
    await new Promise(r => setTimeout(r, 150));
    
    try {
      await Haptics.impactAsync(
        Haptics.ImpactFeedbackStyle.Heavy
      );
      console.log('✅ Impact vibration triggered');
    } catch (e) {
      console.warn('⚠️ Impact vibration failed:', e);
    }

    // AUDIO MODE - Critical for sound playback
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
    } catch (e) {
    }

    // SOUND - Load and play on loop
    console.log('🎵 Loading sound file...');
    try {
      sound = new Audio.Sound();
      
      // Load the sound file
      await sound.loadAsync(require('../assets/skype.mp3'));
      
      // Set to loop continuously
      await sound.setIsLoopingAsync(true);
      
      // Play the sound
      await sound.playAsync();
      
    } catch (e) {
      console.error('❌ Sound playback failed:', e);
      console.error('Error details:', {
        message: e instanceof Error ? e.message : String(e),
        code: (e as any).code,
      });
      
      if (sound) {
        try {
          await sound.unloadAsync();
        } catch (e2) {
          console.warn('Failed to unload sound:', e2);
        }
        sound = null;
      }
    }

    // Start continuous vibration every 2 seconds
    console.log('📳 Starting continuous vibration...');
    if (vibrationInterval) {
      clearInterval(vibrationInterval);
    }
    vibrationInterval = setInterval(async () => {
      try {
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      } catch (e) {
        // Silently continue
      }
    }, 2000); // Vibrate every 2 seconds

    // Auto-stop after 30 seconds
    console.log('⏰ Setting auto-stop timer (30 seconds)...');
    if (autoStopTimeout) {
      clearTimeout(autoStopTimeout);
    }
    autoStopTimeout = setTimeout(async () => {
      console.log('⏰ 30 seconds elapsed - auto-stopping sound & vibration');
      await cleanupJobAlert();
    }, 30000); // 30 seconds

    console.log('🔔 Job alert triggered - sound looping + vibration continuous (auto-stop in 30s)');
  } catch (err) {
    console.error('❌ Unexpected job alert error:', err);
  }
};

export const cleanupJobAlert = async () => {
  try {
    console.log('🛑 Cleaning up job alert (sound + vibration)...');
    
    // Clear auto-stop timeout
    if (autoStopTimeout) {
      clearTimeout(autoStopTimeout);
      autoStopTimeout = null;
      console.log('✅ Auto-stop timer cleared');
    }
    
    // Stop vibration loop
    if (vibrationInterval) {
      clearInterval(vibrationInterval);
      vibrationInterval = null;
      console.log('✅ Vibration stopped');
    }
    
    // Stop and unload sound
    if (sound) {
      try {
        // Stop playing first
        await sound.stopAsync();
        console.log('✅ Sound stopped');
        
        // Then unload
        await sound.unloadAsync();
        console.log('✅ Sound unloaded');
      } catch (e) {
        console.warn('⚠️ Error stopping sound:', e);
      }
      sound = null;
    }
    
    console.log('✅ Job alert cleanup complete');
  } catch (err) {
    console.warn('⚠️ Cleanup error:', err);
  }
};

export const initializeAudioSession = async () => {
  try {
    console.log('🎧 Initializing audio session...');
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: false,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });
    console.log('✅ Audio session initialized');
  } catch (e) {
    console.warn('⚠️ Audio session initialization failed:', e);
  }
};
