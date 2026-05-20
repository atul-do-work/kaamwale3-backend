import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAuthAccessToken, setAuthAccessToken, getRefreshToken, clearAuthTokens } from './secureStore';
import { API_BASE } from './config';

const api = axios.create({ baseURL: API_BASE });

let isRefreshing = false;
let refreshQueue: Array<(token?: string | null, err?: any) => void> = [];

// processQueue(token, error) - call queued callbacks with (token, error)
const processQueue = (token: string | null = null, error: any = null) => {
  refreshQueue.forEach(cb => cb(token, error));
  refreshQueue = [];
};

api.interceptors.request.use(async (config) => {
  const token = await getAuthAccessToken();
  if (token && config.headers) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  res => res,
  async err => {
    const originalReq = err.config;
    if (err.response?.status === 401 && !originalReq._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push((token, error) => {
            if (error) return reject(error);
            if (originalReq.headers) originalReq.headers.Authorization = 'Bearer ' + token;
            resolve(axios(originalReq));
          });
        });
      }

      originalReq._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = await getRefreshToken();
        if (!refreshToken) throw new Error('No refresh token');
        const response = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken });
        const newToken = response.data.accessToken;
        await setAuthAccessToken(newToken);
        processQueue(newToken, null);
        if (originalReq.headers) originalReq.headers.Authorization = 'Bearer ' + newToken;
        return axios(originalReq);
      } catch (e) {
        processQueue(null, e);
        // Clear tokens
        await clearAuthTokens();
        throw e;
      } finally {
        isRefreshing = false;
      }
    }
    throw err;
  }
);

// ✅ API helper functions
export const updateUserLocation = async (latitude: number, longitude: number) => {
  try {
    const response = await api.post('/user/update-location', {
      latitude,
      longitude,
    });
    return response.data;
  } catch (error) {
    console.error('Error updating location:', error);
    throw error;
  }
};

export const updateWorkerAvailability = async (isAvailable: boolean, latitude?: number, longitude?: number) => {
  try {
    const body: any = { isAvailable };
    if (latitude !== undefined && longitude !== undefined) {
      body.latitude = latitude;
      body.longitude = longitude;
    }
    const response = await api.put('/workers/availability', body);
    return response.data;
  } catch (error) {
    console.error('Error updating availability:', error);
    throw error;
  }
};

export default api;
