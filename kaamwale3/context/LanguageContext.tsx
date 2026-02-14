import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { translations, Language } from '../constants/translations';

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => Promise<void>;
  t: (key: keyof typeof translations.en) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>('en');
  const [isLoading, setIsLoading] = useState(true);

  // Load saved language on app startup
  useEffect(() => {
    const loadLanguage = async () => {
      try {
        const savedLanguage = await AsyncStorage.getItem('appLanguage');
        if (savedLanguage && (savedLanguage === 'en' || savedLanguage === 'hi' || savedLanguage === 'mr')) {
          setLanguageState(savedLanguage as Language);
        }
      } catch (err) {
        console.error('Error loading language preference:', err);
      } finally {
        setIsLoading(false);
      }
    };

    loadLanguage();
  }, []);

  // Function to change language and save to AsyncStorage
  const handleSetLanguage = async (lang: Language) => {
    try {
      setLanguageState(lang);
      await AsyncStorage.setItem('appLanguage', lang);
      console.log(`🌐 Language changed to: ${lang}`);
    } catch (err) {
      console.error('Error saving language preference:', err);
    }
  };

  // Translation function with fallback
  const t = (key: keyof typeof translations.en): string => {
    const translationMap = translations[language];
    return (translationMap[key as keyof typeof translationMap] as string) || translations.en[key] || key;
  };

  if (isLoading) {
    return null; // Or show a splash screen
  }

  return (
    <LanguageContext.Provider value={{ language, setLanguage: handleSetLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
};

// Hook to use language context
export const useLanguage = () => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within LanguageProvider');
  }
  return context;
};
