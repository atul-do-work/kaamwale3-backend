import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureSet, secureGet, secureDelete } from '../utils/secureStore';
// API_BASE not required here (AuthProvider uses SecureStore and AsyncStorage)

type AuthContextType = {
  accessToken: string | null;
  user: any | null;
  loading: boolean;
  saveTokens: (accessToken: string | null, refreshToken?: string | null, user?: any) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

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
    <AuthContext.Provider value={{ accessToken, user, loading, saveTokens, logout }}>
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
