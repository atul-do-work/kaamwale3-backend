import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureSet, secureGet, secureDelete } from '../utils/secureStore';
import { socket } from '../utils/socket';
import { API_BASE } from '../utils/config';
import { premiumCacheManager } from '../utils/premiumCacheManager';

type AuthContextType = {
  accessToken: string | null;
  user: any | null;
  loading: boolean;
  saveTokens: (accessToken: string | null, refreshToken?: string | null, user?: any) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * ✅ Update user premium status instantly (called when premium subscription received)
   */
  updateUserPremium: (premiumPlan: any) => Promise<void>;
  /**
   * ✅ Generic update for any user field (profilePhoto, etc.)
   */
  updateUserField: (field: string, value: any) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  // ✅ Listen for premium subscription updates via socket
  useEffect(() => {
    socket.on('premiumSubscriptionUpdate', async (data: any) => {
      console.log('📡 Received premium subscription update:', data);

      // ✅ FIXED: Invalidate cache but don't immediately fetch - let components fetch when needed
      premiumCacheManager.invalidate();

      // Update current user if it's them (don't make API call)
      if (user && user.phone === data.contractorPhone) {
        // Just update the local user object with new status if available
        if (data.planType) {
          const updatedUser = { ...user, premiumPlan: { ...user.premiumPlan, type: data.planType } };
          setUser(updatedUser);
          await AsyncStorage.setItem('user', JSON.stringify(updatedUser));
          console.log('✅ Premium status updated instantly via socket');
        }
      }
    });

    return () => {
      socket.off('premiumSubscriptionUpdate');
    };
  }, [user]);

  useEffect(() => {
    (async () => {
      try {
        const a = await AsyncStorage.getItem('accessToken');
        const u = await AsyncStorage.getItem('user');
        const refresh = await secureGet('refreshToken');
        // If refresh exists but accessToken missing, leave null (will refresh on demand)
        // Migrate refreshToken from AsyncStorage (if present) into SecureStore
        if (!refresh) {
          const oldRefresh = await AsyncStorage.getItem('refreshToken');
          if (oldRefresh) {
            try {
              await secureSet('refreshToken', oldRefresh);
              await AsyncStorage.removeItem('refreshToken');
              console.log('Migrated refreshToken to SecureStore');
            } catch (mErr) {
              console.warn('Failed migrating refresh token to SecureStore', mErr);
            }
          }
        }
        setAccessToken(a);
        setUser(u ? JSON.parse(u) : null);

        // ✅ ON APP STARTUP: Fetch fresh premium status (don't trust cached login data)
        if (a) {
          console.log('🚀 App started: Fetching fresh premium status...');
          const freshStatus = await premiumCacheManager.forceFresh(a);
          if (freshStatus?.user?.premiumPlan) {
            // Update user with fresh premium data
            const parsedUser = u ? JSON.parse(u) : null;
            if (parsedUser) {
              parsedUser.premiumPlan = freshStatus.user.premiumPlan;
              setUser(parsedUser);
              await AsyncStorage.setItem('user', JSON.stringify(parsedUser));
              console.log('✅ User updated with fresh premium status on startup');
            }
          }
        }
      } catch (e) {
        console.warn('AuthProvider init error', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveTokens = async (aToken: string | null, refreshToken?: string | null, userObj?: any) => {
    try {
      setAccessToken(aToken);
      if (aToken) await AsyncStorage.setItem('accessToken', aToken);
      else await AsyncStorage.removeItem('accessToken');

      if (refreshToken) await secureSet('refreshToken', refreshToken);
      else if (refreshToken === null) await secureDelete('refreshToken');

      if (userObj) {
        setUser(userObj);
        await AsyncStorage.setItem('user', JSON.stringify(userObj));
      }
    } catch (e) {
      console.warn('saveTokens error', e);
    }
  };

  /**
   * ✅ Update user premium instantly when subscription completes
   */
  const updateUserPremium = async (premiumPlan: any) => {
    try {
      if (user) {
        const updatedUser = { ...user, premiumPlan };
        setUser(updatedUser);
        await AsyncStorage.setItem('user', JSON.stringify(updatedUser));
        console.log('✅ User premium status updated in AuthContext');
      }
    } catch (e) {
      console.warn('updateUserPremium error', e);
    }
  };

  /**
   * ✅ Generic update for any user field (profilePhoto, name, etc.)
   */
  const updateUserField = async (field: string, value: any) => {
    try {
      if (user) {
        const updatedUser = { ...user, [field]: value };
        setUser(updatedUser);
        await AsyncStorage.setItem('user', JSON.stringify(updatedUser));
        console.log(`✅ User ${field} updated in AuthContext:`, value);
      }
    } catch (e) {
      console.warn(`updateUserField error for ${field}:`, e);
    }
  };

  const logout = async () => {
    try {
      setAccessToken(null);
      setUser(null);
      await AsyncStorage.removeItem('accessToken');
      await AsyncStorage.removeItem('user');
      await secureDelete('refreshToken');
    } catch (e) {
      console.warn('logout error', e);
    }
  };

  return (
    <AuthContext.Provider value={{ accessToken, user, loading, saveTokens, logout, updateUserPremium, updateUserField }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
};

export default AuthContext;
