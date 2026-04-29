import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureSet, secureGet, secureDelete } from '../utils/secureStore';
import { socket } from '../utils/socket';
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

        AsyncStorage.setItem('user', JSON.stringify(updatedUser)).catch((err) =>
          console.warn('Failed to persist socket premium update', err)
        );
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
        const a = await AsyncStorage.getItem('accessToken');
        const u = await AsyncStorage.getItem('user');
        const refresh = await secureGet('refreshToken');

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

        const parsedUser = u ? JSON.parse(u) : null;

        setAccessToken(a);
        setUser(parsedUser);

        if (parsedUser?.premiumPlan) {
          syncPremiumCache(parsedUser.premiumPlan);
        }

        if (a) {
          console.log('App started: Fetching fresh premium status...');
          const freshStatus = await premiumCacheManager.forceFresh(a);
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
      if (aToken) await AsyncStorage.setItem('accessToken', aToken);
      else await AsyncStorage.removeItem('accessToken');

      if (refreshToken) await secureSet('refreshToken', refreshToken);
      else if (refreshToken === null) await secureDelete('refreshToken');

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
      setAccessToken(null);
      setUser(null);
      premiumCacheManager.clear();
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
