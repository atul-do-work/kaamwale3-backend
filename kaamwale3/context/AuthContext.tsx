import React, { createContext, useContext, useEffect, useState, useRef, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuthAccessToken, setAuthAccessToken, getRefreshToken, setRefreshToken, clearAuthTokens } from '../utils/secureStore';
import api from '../utils/api';
import { socket, disconnectSocket } from '../utils/socket';
import { premiumCacheManager } from '../utils/premiumCacheManager';
import { isPremiumPlanActive, mergePremiumPlan } from '../utils/premiumPlanState';

type AuthContextType = {
  accessToken: string | null;
  user: any | null;
  loading: boolean;
  saveTokens: (accessToken: string | null, refreshToken?: string | null, user?: any) => Promise<void>;
  logout: () => Promise<void>;
  updateUserPremium: (premiumPlan: any) => Promise<void>;
  updateUserField: (field: string, value: any) => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  const persistUser = React.useCallback(async (nextUser: any | null) => {
    setUser(nextUser);
    if (nextUser) {
      await AsyncStorage.setItem('user', JSON.stringify(nextUser));
    } else {
      await AsyncStorage.removeItem('user');
    }
  }, []);

  const syncPremiumCache = React.useCallback((plan: any) => {
    if (!plan) {
      premiumCacheManager.invalidate();
      return;
    }

    premiumCacheManager.setCache({
      success: true,
      isActive: isPremiumPlanActive(plan),
      premiumPlan: plan.type || 'free',
      premiumDetails: plan,
      entitlements: plan.entitlements || null,
    });
  }, []);

  const persistTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queuePersistUser = React.useCallback((nextUser: any | null) => {
    if (persistTimeoutRef.current) {
      clearTimeout(persistTimeoutRef.current);
    }
    persistTimeoutRef.current = setTimeout(() => {
      persistUser(nextUser).catch((err) => console.warn('Failed to persist user state', err));
      persistTimeoutRef.current = null;
    }, 150);
  }, [persistUser]);

  useEffect(() => {
    const handlePremiumSubscriptionUpdate = async (data: any) => {
      console.log('Received premium subscription update:', data);
      premiumCacheManager.invalidate();

      if (!data?.contractorPhone || !data?.planType) {
        return;
      }

      setUser((currentUser: any | null) => {
        if (!currentUser || currentUser.phone !== data.contractorPhone) {
          return currentUser;
        }

        const updatedPlan = mergePremiumPlan(currentUser.premiumPlan, data.premiumPlan || {
          type: data.planType,
          expiryDate: data.expiryDate || currentUser.premiumPlan?.expiryDate || null,
          graceUntil: data.graceUntil || currentUser.premiumPlan?.graceUntil || null,
          status: data.status || (data.planType === 'free' ? 'inactive' : currentUser.premiumPlan?.status || 'active'),
          entitlements: data.entitlements || currentUser.premiumPlan?.entitlements || null,
          subscriptionId: data.subscriptionId || currentUser.premiumPlan?.subscriptionId || null,
        });
        const updatedUser = { ...currentUser, premiumPlan: updatedPlan };

        queuePersistUser(updatedUser);
        syncPremiumCache(updatedPlan);
        return updatedUser;
      });
      console.log('Premium status updated instantly via socket');
    };

    socket.on('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);
    return () => {
      socket.off('premiumSubscriptionUpdate', handlePremiumSubscriptionUpdate);
    };
  }, [syncPremiumCache]);

  useEffect(() => {
    (async () => {
      try {
        const a = await getAuthAccessToken();
        const u = await AsyncStorage.getItem('user');
        const refresh = await getRefreshToken();

        const parsedUser = u ? JSON.parse(u) : null;

        setAccessToken(a);
        setUser(parsedUser);

        if (parsedUser?.premiumPlan) {
          syncPremiumCache(parsedUser.premiumPlan);
        }

        if (a) {
          console.log('App started: Fetching fresh premium status...');
          const freshStatus = await premiumCacheManager.forceFresh();
          const freshPremiumDetails = freshStatus?.premiumDetails;
          if (freshPremiumDetails && parsedUser) {
            const updatedUser = {
              ...parsedUser,
              premiumPlan: mergePremiumPlan(parsedUser.premiumPlan, freshPremiumDetails),
            };
            await persistUser(updatedUser);
            syncPremiumCache(updatedUser.premiumPlan);
            console.log('User updated with fresh premium status on startup');
          }
        }

        if (!refresh) {
          console.log('No refresh token found on startup');
        }
      } catch (e) {
        console.warn('AuthProvider init error', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [persistUser, syncPremiumCache]);

  const saveTokens = async (aToken: string | null, refreshToken?: string | null, userObj?: any) => {
    try {
      setAccessToken(aToken);
      await setAuthAccessToken(aToken);
      if (refreshToken !== undefined) {
        await setRefreshToken(refreshToken);
      }

      if (userObj) {
        await persistUser(userObj);
        if (userObj.premiumPlan) {
          syncPremiumCache(userObj.premiumPlan);
        }
      }
    } catch (e) {
      console.warn('saveTokens error', e);
    }
  };

  const updateUserPremium = async (premiumPlan: any) => {
    try {
      if (!user) return;

      const updatedPlan = mergePremiumPlan(user.premiumPlan, premiumPlan);
      const updatedUser = { ...user, premiumPlan: updatedPlan };
      await persistUser(updatedUser);
      syncPremiumCache(updatedPlan);
      console.log('User premium status updated in AuthContext');
    } catch (e) {
      console.warn('updateUserPremium error', e);
    }
  };

  const updateUserField = async (field: string, value: any) => {
    try {
      if (!user) return;

      const updatedUser = { ...user, [field]: value };
      await persistUser(updatedUser);
      console.log(`User ${field} updated in AuthContext:`, value);
    } catch (e) {
      console.warn(`updateUserField error for ${field}:`, e);
    }
  };

  const logout = async () => {
    try {
      const refreshToken = await getRefreshToken();
      if (refreshToken) {
        await api.post('/auth/logout', { refreshToken });
      }
    } catch (error) {
      console.warn('logout backend error', error);
    }

    try {
      disconnectSocket();
    } catch (error) {
      console.warn('socket disconnect error', error);
    }

    try {
      setAccessToken(null);
      setUser(null);
      premiumCacheManager.clear();
      await clearAuthTokens();
      await AsyncStorage.removeItem('user');
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
