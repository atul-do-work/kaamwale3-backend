import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { secureGet } from './secureStore';
import { API_BASE } from './config';

const api = axios.create({ baseURL: API_BASE });

let isRefreshing = false;
let refreshQueue: Array<(token?: string | null, err?: any) => void> = [];

const processQueue = (error: any, token: string | null = null) => {
  refreshQueue.forEach(cb => cb(token, error));
  refreshQueue = [];
};

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('accessToken');
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
            originalReq.headers.Authorization = 'Bearer ' + token;
            resolve(axios(originalReq));
          });
        });
      }

      originalReq._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = await secureGet('refreshToken');
        if (!refreshToken) throw new Error('No refresh token');
        const response = await axios.post(`${API_BASE}/auth/refresh`, { refreshToken });
        const newToken = response.data.accessToken;
        await AsyncStorage.setItem('accessToken', newToken);
        processQueue(null, newToken);
        originalReq.headers.Authorization = 'Bearer ' + newToken;
        return axios(originalReq);
      } catch (e) {
        processQueue(e, null);
        // Clear tokens
        await AsyncStorage.removeItem('accessToken');
        try { await secureGet('refreshToken'); } catch (ignore) {}
        throw e;
      } finally {
        isRefreshing = false;
      }
    }
    throw err;
  }
);

export default api;
