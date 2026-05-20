import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Modal,
  TextInput,
  ActivityIndicator,
} from "react-native";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useLanguage } from "../context/LanguageContext";
import { useAuth } from "../context/AuthContext";
import { Language } from "../constants/translations";
import api from "../utils/api";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SettingsScreen(): React.ReactElement {
  const router = useRouter();
  const { logout } = useAuth();
  const { setLanguage: applyLanguage, t } = useLanguage();
  const [notifications, setNotifications] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [language, setLanguageState] = useState<Language>('en');
  const [isLoadingPreferences, setIsLoadingPreferences] = useState(true);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [upiAccount, setUpiAccount] = useState<any>(null);
  const [payoutMethod, setPayoutMethod] = useState<"bank" | "upi">("bank");
  const [showPayoutMethodModal, setShowPayoutMethodModal] = useState(false);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showAddUpi, setShowAddUpi] = useState(false);
  const [showBankInfo, setShowBankInfo] = useState(true);
  const [showUpiInfo, setShowUpiInfo] = useState(true);
  const [showPayoutConfirmModal, setShowPayoutConfirmModal] = useState(false);
  const [pendingPayoutMethod, setPendingPayoutMethod] = useState<"bank" | "upi" | null>(null);
  const [showDeleteAccountModal, setShowDeleteAccountModal] = useState(false);
  const [upiIdInput, setUpiIdInput] = useState("");
  const [isSavingBank, setIsSavingBank] = useState(false);
  const [isSavingUpi, setIsSavingUpi] = useState(false);
  const [isSavingPayoutMethod, setIsSavingPayoutMethod] = useState(false);
  const [isDeletingAccount, setIsDeletingAccount] = useState(false);
  const [isPayoutAllowed, setIsPayoutAllowed] = useState(true);
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: "",
    accountNumber: "",
    accountNumberConfirm: "",
    ifscCode: "",
    bankName: "",
  });
  
  // ✅ Modal state for alerts
  const [modalVisible, setModalVisible] = useState(false);
  const [modalTitle, setModalTitle] = useState("");
  const [modalMessage, setModalMessage] = useState("");
  const [modalType, setModalType] = useState<"success" | "error" | "info">("success");
  const tx = React.useCallback(
    (key: string, fallback: string) => {
      const translated = (t as any)(key);
      return typeof translated === "string" && translated !== key ? translated : fallback;
    },
    [t]
  );

  const showStatusModal = (type: "success" | "error" | "info", title: string, message: string) => {
    setModalType(type);
    setModalTitle(title);
    setModalMessage(message);
    setModalVisible(true);
  };

  const SETTINGS_STORAGE_KEY = "userSettings";

  const persistLocalSettings = async (settings: { notifications: boolean; emailAlerts: boolean; language?: Language; updatedAt?: number }) => {
    try {
      const payload = {
        notifications: settings.notifications,
        emailAlerts: settings.emailAlerts,
        language: settings.language ?? language,
        updatedAt: settings.updatedAt ?? Date.now(),
      };
      const json = JSON.stringify(payload);
      await AsyncStorage.setItem(SETTINGS_STORAGE_KEY, json);
    } catch (error) {
      console.error("Error saving local settings:", error);
    }
  };

  const loadLocalSettings = async () => {
    try {
      const stored = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          setNotifications(parsed.notifications ?? true);
          setEmailAlerts(parsed.emailAlerts ?? true);
          setLanguageState(parsed.language ?? 'en');
        } catch (parseErr) {
          console.warn('Corrupted local settings, clearing storage');
          await AsyncStorage.removeItem(SETTINGS_STORAGE_KEY);
        }
      }
    } catch (error) {
      console.error("Error loading local settings:", error);
    }
  };

  const loadPreferences = async (signal?: AbortSignal) => {
    setIsLoadingPreferences(true);
    let localSettings: any = null;

    try {
      const stored = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
      if (stored) {
        localSettings = JSON.parse(stored);
      }
    } catch (error) {
      console.warn('Could not read local settings before fetching preferences', error);
    }

    try {
      const res = await api.get(`/users/preferences`, { signal });
      if (res.data?.success && res.data.preferences) {
        if (signal?.aborted) return;

        const serverPrefs = res.data.preferences;
        const localUpdatedAt = localSettings?.updatedAt ?? 0;
        const serverUpdatedAt = serverPrefs.updatedAt ?? 0;
        const useLocal = localSettings && localUpdatedAt > serverUpdatedAt;
        const effectivePrefs = useLocal
          ? {
              notifications: localSettings.notifications ?? serverPrefs.notifications ?? true,
              emailAlerts: localSettings.emailAlerts ?? serverPrefs.emailAlerts ?? true,
              language: localSettings.language ?? serverPrefs.language ?? 'en',
              updatedAt: localUpdatedAt,
            }
          : {
              notifications: serverPrefs.notifications ?? true,
              emailAlerts: serverPrefs.emailAlerts ?? true,
              language: serverPrefs.language ?? 'en',
              updatedAt: serverUpdatedAt || Date.now(),
            };

        setNotifications(effectivePrefs.notifications);
        setEmailAlerts(effectivePrefs.emailAlerts);
        setLanguageState(effectivePrefs.language);
        await persistLocalSettings(effectivePrefs);
        return;
      }
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
        console.log('loadPreferences aborted');
        return;
      }
      console.error("Error fetching user preferences:", err);
    } finally {
      if (!signal?.aborted) {
        await loadLocalSettings();
        setIsLoadingPreferences(false);
      }
    }
  };

  const handleSave = async () => {
    if (isSavingSettings) return;
    setIsSavingSettings(true);
    try {
      const payload = {
        notifications,
        emailAlerts,
        language,
      };
      const res = await api.post(`/users/preferences`, payload);
      if (res.data?.success) {
        await persistLocalSettings({ ...payload, language, updatedAt: Date.now() });
        applyLanguage(language);
        showStatusModal("success", t("success"), t("settingsSaved"));
      } else {
        showStatusModal("error", t("error"), res.data?.message || tx("serverError", "Something went wrong"));
      }
    } catch (err: any) {
      showStatusModal("error", t("error"), err.response?.data?.message || tx("serverError", "Something went wrong"));
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleLanguageChange = (lang: Language) => {
    setLanguageState(lang);
  };

  const handleDeleteAccount = async () => {
    if (isDeletingAccount) return;
    setIsDeletingAccount(true);
    try {
      const res = await api.delete(`/users/account`);
      if (res.data?.success) {
        setShowDeleteAccountModal(false);
        await logout();
        await AsyncStorage.multiRemove([
          "token",
          "accessToken",
          "profilePhoto",
          "userSettings",
          "locationProvidedOnLogin",
          "tempRegistration",
          "fcmToken",
          "lastKnownLocation",
          "leaderboard",
          "myRank",
          "myScore",
        ]);
        router.replace("/");
        return;
      }
      showStatusModal("error", t("error"), res.data?.message || "Failed to delete account");
    } catch (err: any) {
      showStatusModal("error", t("error"), err.response?.data?.message || "Failed to delete account");
    } finally {
      setIsDeletingAccount(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const controller = new AbortController();

    const init = async () => {
      // sequence calls to avoid races and loading flicker
      await loadPreferences(controller.signal);
      if (!isMounted) return;
      await fetchBankAccount(controller.signal);
      if (!isMounted) return;
      await fetchUpiAccount(controller.signal);
      if (!isMounted) return;
      await fetchPayoutMethod(controller.signal);
    };

    init();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, []);

  const fetchBankAccount = async (signal?: AbortSignal) => {
    try {
      const res = await api.get(`/wallet/bank-account`, { signal });
      if (res.data.success) setBankAccount(res.data.bankAccount);
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      if (err?.response?.status === 403) setIsPayoutAllowed(false);
      console.error("Error fetching bank account:", err);
    }
  };

  const fetchUpiAccount = async (signal?: AbortSignal) => {
    try {
      const res = await api.get(`/wallet/upi`, { signal });
      if (res.data.success) setUpiAccount(res.data.upi || null);
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      if (err?.response?.status === 403) setIsPayoutAllowed(false);
      console.error("Error fetching UPI details:", err);
    }
  };

  const fetchPayoutMethod = async (signal?: AbortSignal) => {
    try {
      const res = await api.get(`/wallet/payout-method`, { signal });
      if (res.data?.success && ["bank", "upi"].includes(res.data.payoutMethod)) {
        setPayoutMethod(res.data.payoutMethod);
      }
      setIsPayoutAllowed(true);
    } catch (err: any) {
      if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
      if (err?.response?.status === 403) {
        setIsPayoutAllowed(false);
        return;
      }
      console.error("Error fetching payout method:", err);
    }
  };

  const persistPayoutMethod = async (method: "bank" | "upi") => {
    setPendingPayoutMethod(method);
    setShowPayoutConfirmModal(true);
  };

  const confirmPayoutMethodChange = async () => {
    if (!pendingPayoutMethod) return;
    
    setShowPayoutConfirmModal(false);
    setIsSavingPayoutMethod(true);
    const method = pendingPayoutMethod;
    setPendingPayoutMethod(null);
    
    const previousMethod = payoutMethod;
    try {
      const res = await api.post(`/wallet/payout-method`, { method });
      if (res.data?.success) {
        const updatedMethod = res.data.payoutMethod || method;
        setPayoutMethod(updatedMethod);
        showStatusModal("success", t("success"), res.data?.message || tx("settingsSaved", "Payout method updated"));
        return true;
      }
      setPayoutMethod(previousMethod);
      showStatusModal("error", t("error"), res.data?.message || tx("serverError", "Failed to update payout method"));
      return false;
    } catch (err: any) {
      setPayoutMethod(previousMethod);
      showStatusModal("error", t("error"), err.response?.data?.message || tx("serverError", "Something went wrong"));
      return false;
    } finally {
      setIsSavingPayoutMethod(false);
    }
  };

  const handleAddBankAccount = async () => {
    if (isSavingBank) return;
    if (!bankDetails.accountHolderName.trim()) {
      showStatusModal("error", t("error"), t("enterAccountHolderName"));
      return;
    }
    if (bankDetails.accountNumber.length < 9 || bankDetails.accountNumber.length > 18) {
      showStatusModal("error", t("error"), t("invalidAccountNumber"));
      return;
    }
    if (bankDetails.accountNumber !== bankDetails.accountNumberConfirm) {
      showStatusModal("error", t("error"), t("accountMismatch"));
      return;
    }
    if (bankDetails.ifscCode.length !== 11) {
      showStatusModal("error", t("error"), t("invalidIFSC"));
      return;
    }
    if (!bankDetails.bankName.trim()) {
      showStatusModal("error", t("error"), t("enterBankName"));
      return;
    }

    setIsSavingBank(true);
    try {
      // Ensure we're using HTTPS for sensitive bank requests
      const base = (api as any)?.defaults?.baseURL || '';
      if (base && !base.startsWith('https://')) {
        showStatusModal('error', t('error'), tx('insecureConnection', 'Insecure connection. Please use HTTPS'));
        setIsSavingBank(false);
        return;
      }
      const res = await api.post(`/wallet/bank-account/add`, bankDetails);
      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
        setShowAddBank(false);
        setShowBankInfo(true);
        setBankDetails({
          accountHolderName: "",
          accountNumber: "",
          accountNumberConfirm: "",
          ifscCode: "",
          bankName: "",
        });
        await persistPayoutMethod("bank");
      }
    } catch (err: any) {
      showStatusModal("error", t("error"), err.response?.data?.message || t("failedAddBank"));
    } finally {
      setIsSavingBank(false);
    }
  };

  const handleAddUpiId = async () => {
    if (isSavingUpi) return;
    const candidate = upiIdInput.trim().toLowerCase();
    const upiRegex = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z0-9.-]{2,64}$/;
    if (!candidate) {
      showStatusModal("error", t("error"), tx("enterUpiId", "Please enter a UPI ID"));
      return;
    }
    if (!upiRegex.test(candidate)) {
      showStatusModal("error", t("error"), tx("enterValidUpiId", "Please enter a valid UPI ID (example: name@bank)"));
      return;
    }

    setIsSavingUpi(true);
    try {
      const res = await api.post(`/wallet/upi/add`, { upiId: candidate });
      if (res.data.success) {
        setUpiAccount(res.data.upi || null);
        setShowUpiInfo(true);
        setShowAddUpi(false);
        setUpiIdInput("");
        await persistPayoutMethod("upi");
      }
    } catch (err: any) {
      showStatusModal("error", t("error"), err.response?.data?.message || tx("error", "Failed to save UPI ID"));
    } finally {
      setIsSavingUpi(false);
    }
  };

  const settingSections: Array<{
    title: string;
    icon: string;
    color: string;
    items: Array<{
      label: string;
      desc?: string;
      value: boolean;
      onChange: (() => void) | ((value: boolean) => void);
      type: "toggle" | "radio";
    }>;
  }> = [
    {
      title: t('notifications'),
      icon: "notifications",
      color: "#FF6B6B",
      items: [
        {
          label: t('notifications'),
          desc: tx('notificationSettingsDesc', 'Receive job alerts and updates'),
          value: notifications,
          onChange: setNotifications,
          type: "toggle",
        },
        {
          label: t('emailAlerts'),
          desc: tx('emailAlertsDesc', 'Get email updates for important events'),
          value: emailAlerts,
          onChange: setEmailAlerts,
          type: "toggle",
        },
      ],
    },
    {
      title: t('language'),
      icon: "language",
      color: "#95E1D3",
      items: [
        {
          label: t('english'),
          value: language === "en",
          onChange: () => handleLanguageChange("en"),
          type: "radio",
        },
        {
          label: t('hindi'),
          value: language === "hi",
          onChange: () => handleLanguageChange("hi"),
          type: "radio",
        },
        {
          label: t('marathi'),
          value: language === "mr",
          onChange: () => handleLanguageChange("mr"),
          type: "radio",
        },
      ],
    },
  ];

  if (isLoadingPreferences) {
    return (
      <SafeAreaView style={styles.centerContainer} edges={['top', 'left', 'right']}>
        <ActivityIndicator size="large" color="#6C63FF" />
        <Text style={styles.loadingText}>{t('loading')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        showsVerticalScrollIndicator={false}
      >
      {/* Header */}
      <LinearGradient colors={["#17263A", "#243B55"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#111827" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{t('settings')}</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      {/* Settings Sections */}
      {settingSections.map((section, idx) => (
        <View key={idx} style={styles.sectionContainer}>
          <View style={styles.sectionHeader}>
            <View style={[styles.iconBg, { backgroundColor: section.color + "20" }]}>
              <MaterialIcons name={section.icon as any} size={20} color={section.color} />
            </View>
            <Text style={styles.sectionTitle}>{section.title}</Text>
          </View>

          {section.items.map((item, itemIdx) => (
            <View key={itemIdx}>
              <View style={styles.settingRow}>
                <View style={styles.settingInfo}>
                  <Text style={styles.settingLabel}>{item.label}</Text>
                  {item.desc && <Text style={styles.settingDesc}>{item.desc}</Text>}
                </View>

                {item.type === "toggle" ? (
                             <Switch
                    value={item.value}
                    onValueChange={(value) => {
                      if (typeof item.onChange === 'function') {
                        item.onChange(value);
                      }
                    }}
                    trackColor={{ false: "#D3D3D3", true: section.color + "40" }}
                    thumbColor={item.value ? section.color : "#f4f3f4"}
                  />

                ) : (
                  <TouchableOpacity
                    onPress={() => item.onChange(true)}
                    style={[styles.radioBtn, item.value && { borderColor: section.color }]}
                  >
                    {item.value && (
                      <View style={[styles.radioDot, { backgroundColor: section.color }]} />
                    )}
                  </TouchableOpacity>
                )}
              </View>
              {itemIdx < section.items.length - 1 && <View style={styles.divider} />}
            </View>
          ))}
        </View>
      ))}

      <View style={styles.actionRow}>
        <TouchableOpacity style={[styles.actionButton, styles.saveButton]} onPress={handleSave} disabled={isSavingSettings}>
          {isSavingSettings ? (
            <ActivityIndicator size="small" color="#111827" />
          ) : (
            <>
              <MaterialIcons name="save" size={18} color="#111827" />
              <Text style={styles.rowButtonText}>{tx('save', 'Save')}</Text>
            </>
          )}
        </TouchableOpacity>

        {isPayoutAllowed && (
          <TouchableOpacity
            style={[styles.actionButton, styles.paymentMethodButton, isSavingPayoutMethod && styles.buttonDisabled]}
            disabled={isSavingPayoutMethod}
            onPress={() => setShowPayoutMethodModal(true)}
          >
            <MaterialIcons name="payment" size={18} color="#111827" />
            <Text style={styles.rowButtonText} numberOfLines={1}>
              {tx("payment", "Payment")}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.accountActionsCard}>
        <TouchableOpacity
          style={[styles.deleteAccountButton, isDeletingAccount && styles.buttonDisabled]}
          onPress={() => setShowDeleteAccountModal(true)}
          disabled={isDeletingAccount}
        >
          <MaterialIcons name="delete-outline" size={18} color="#fff" />
          <Text style={styles.deleteAccountButtonText}>Delete Account</Text>
        </TouchableOpacity>
      </View>

      {isPayoutAllowed && bankAccount && showBankInfo && (
        <View style={styles.linkedCardBank}>
          <View style={styles.linkedCardHeader}>
            <Text style={styles.linkedCardTitle}>{tx("linkedBankAccount", "Linked Bank Account")}</Text>
            <TouchableOpacity onPress={() => setShowBankInfo(false)}>
              <MaterialIcons name="close" size={20} color="#333" />
            </TouchableOpacity>
          </View>
          <Text style={styles.linkedCardText}>{bankAccount.bankName}</Text>
          <Text style={styles.linkedCardText}>{bankAccount.maskedAccount}</Text>
          <Text style={{ fontSize: 11, color: bankAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {bankAccount.isVerified ? tx("verified", "Verified") : `${tx("pending", "Pending")}: ${bankAccount.verificationStatus}`}
          </Text>
          <View style={styles.linkedCardFooter}>
            <TouchableOpacity onPress={() => setShowAddBank(true)}>
              <Text style={styles.changeBankText}>{t("edit")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {isPayoutAllowed && upiAccount && showUpiInfo && (
        <View style={styles.linkedCardUpi}>
          <View style={styles.linkedCardHeader}>
            <Text style={styles.linkedCardTitle}>{tx("upiPayout", "UPI Payout")}</Text>
            <TouchableOpacity onPress={() => setShowUpiInfo(false)}>
              <MaterialIcons name="close" size={20} color="#333" />
            </TouchableOpacity>
          </View>
          <Text style={styles.linkedCardText}>{upiAccount.maskedUpiId}</Text>
          <Text style={{ fontSize: 11, color: upiAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {upiAccount.isVerified ? tx("verified", "Verified") : `${tx("pending", "Pending")}: ${upiAccount.verificationStatus}`}
          </Text>
          <View style={styles.linkedCardFooter}>
            <TouchableOpacity onPress={() => setShowAddUpi(true)}>
              <Text style={styles.changeUpiText}>{t("edit")}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ✅ Custom Alert Modal */}
      <Modal
        transparent={true}
        animationType="fade"
        visible={modalVisible}
        onRequestClose={() => setModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContainer}>
            {/* Modal Header with Icon */}
            <View style={[
              styles.modalHeader,
              {
                backgroundColor: modalType === "success" ? "#10B98120" : modalType === "error" ? "#EF444420" : "#3B82F620",
              }
            ]}>
              <View style={[
                styles.modalIconBg,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}>
                <MaterialIcons
                  name={
                    modalType === "success" ? "check-circle" :
                    modalType === "error" ? "error" :
                    "info"
                  }
                  size={32}
                  color="#fff"
                />
              </View>
            </View>

            {/* Modal Content */}
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>{modalTitle}</Text>
              <Text style={styles.modalMessage}>{modalMessage}</Text>
            </View>

            {/* Modal Footer - OK Button */}
            <TouchableOpacity
              style={[
                styles.modalButton,
                {
                  backgroundColor: modalType === "success" ? "#10B981" : modalType === "error" ? "#EF4444" : "#3B82F6",
                }
              ]}
              onPress={() => setModalVisible(false)}
            >
              <Text style={styles.modalButtonText}>OK</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showPayoutMethodModal && isPayoutAllowed} transparent animationType="fade">
        <View style={styles.backdrop}>
          <TouchableOpacity style={styles.absoluteFill} onPress={() => setShowPayoutMethodModal(false)} />
          <View style={styles.payoutModalCard}>
            <Text style={styles.payoutModalTitle}>{tx("selectPayoutMethod", "Select Payout Method")}</Text>
            <TouchableOpacity
              style={[styles.methodRow, payoutMethod === "bank" && styles.methodRowActive, isSavingPayoutMethod && styles.buttonDisabled]}
              disabled={isSavingPayoutMethod}
              onPress={async () => {
                if (isSavingPayoutMethod) return;
                setShowPayoutMethodModal(false);
                if (!bankAccount) {
                  setShowAddBank(true);
                  return;
                }
                await persistPayoutMethod("bank");
              }}
            >
              <Text style={styles.methodTitle}>{tx("bankAccount", "Bank Account")}</Text>
              <Text style={styles.methodDesc}>
                {bankAccount?.maskedAccount
                  ? `${tx("linked", "Linked")}: ${bankAccount.maskedAccount}${bankAccount?.isVerified ? ` (${tx("verified", "Verified")})` : ` (${tx("pending", "Pending")})`}`
                  : tx("noBankLinked", "No bank account linked")}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.methodRow, payoutMethod === "upi" && styles.methodRowActive, isSavingPayoutMethod && styles.buttonDisabled]}
              disabled={isSavingPayoutMethod}
              onPress={async () => {
                if (isSavingPayoutMethod) return;
                setShowPayoutMethodModal(false);
                if (!upiAccount) {
                  setShowAddUpi(true);
                  return;
                }
                await persistPayoutMethod("upi");
              }}
            >
              <Text style={styles.methodTitle}>{tx("upiId", "UPI ID")}</Text>
              <Text style={styles.methodDesc}>
                {upiAccount?.maskedUpiId
                  ? `${tx("linked", "Linked")}: ${upiAccount.maskedUpiId}${upiAccount?.isVerified ? ` (${tx("verified", "Verified")})` : ` (${tx("pending", "Pending")})`}`
                  : tx("noUpiLinked", "No UPI ID linked")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showAddUpi && isPayoutAllowed} transparent animationType="slide">
        <View style={styles.fullModal}>
          <View style={styles.fullModalHeader}>
            <Text style={styles.fullModalTitle}>{tx("addUpiId", "Add UPI ID")}</Text>
            <TouchableOpacity disabled={isSavingUpi} onPress={() => setShowAddUpi(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          <View style={styles.fullModalContent}>
            <Text style={styles.inputLabel}>{tx("upiId", "UPI ID")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="example@bank"
              autoCapitalize="none"
              autoCorrect={false}
              value={upiIdInput}
              onChangeText={setUpiIdInput}
            />
            <TouchableOpacity
              style={[styles.saveMethodBtn, isSavingUpi && styles.buttonDisabled]}
              disabled={isSavingUpi}
              onPress={handleAddUpiId}
            >
              {isSavingUpi ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.saveMethodText}>{tx("saveUpiId", "Save UPI ID")}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal visible={showAddBank && isPayoutAllowed} transparent animationType="slide">
        <View style={styles.fullModal}>
          <View style={styles.fullModalHeader}>
            <Text style={styles.fullModalTitle}>{tx("addBankAccount", "Add Bank Account")}</Text>
            <TouchableOpacity disabled={isSavingBank} onPress={() => setShowAddBank(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.fullModalContent}>
            <Text style={styles.inputLabel}>{tx("accountHolderName", "Account Holder Name")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="Full name as per bank"
              value={bankDetails.accountHolderName}
              onChangeText={(val) => setBankDetails({ ...bankDetails, accountHolderName: val })}
            />
            <Text style={styles.inputLabel}>{tx("bankName", "Bank Name")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="e.g., ICICI Bank"
              value={bankDetails.bankName}
              onChangeText={(val) => setBankDetails({ ...bankDetails, bankName: val })}
            />
            <Text style={styles.inputLabel}>{tx("accountNumber", "Account Number")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="Enter account number"
              keyboardType="number-pad"
              value={bankDetails.accountNumber}
              onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumber: val })}
            />
            <Text style={styles.inputLabel}>{tx("confirmAccountNumber", "Confirm Account Number")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="Re-enter account number"
              keyboardType="number-pad"
              value={bankDetails.accountNumberConfirm}
              onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumberConfirm: val })}
            />
            <Text style={styles.inputLabel}>{tx("ifscCode", "IFSC Code")} *</Text>
            <TextInput
              style={styles.inputField}
              placeholder="e.g., ICIC0000001"
              maxLength={11}
              value={bankDetails.ifscCode}
              onChangeText={(val) => setBankDetails({ ...bankDetails, ifscCode: val.toUpperCase() })}
            />
            <TouchableOpacity
              style={[styles.saveMethodBtn, isSavingBank && styles.buttonDisabled]}
              disabled={isSavingBank}
              onPress={handleAddBankAccount}
            >
              {isSavingBank ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.saveMethodText}>{tx("saveBankAccount", "Save Bank Account")}</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Payout Method Confirmation Modal */}
      <Modal visible={showPayoutConfirmModal} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.payoutModalCard}>
            <Text style={styles.payoutModalTitle}>{t('confirmPayoutMethod')}</Text>
            <Text style={styles.confirmModalMessage}>
              {pendingPayoutMethod === 'bank' 
                ? `Your earnings will be sent to ${bankAccount?.maskedAccount ? `****${bankAccount.maskedAccount.slice(-4)}` : 'your bank account'}.`
                : `Your earnings will be sent to ${upiAccount?.maskedUpiId || 'your UPI ID'}.`
              }
            </Text>
            <Text style={styles.confirmModalMessage}>Continue?</Text>
            <View style={styles.confirmModalButtons}>
              <TouchableOpacity 
                style={[styles.confirmModalButton, styles.cancelButton]}
                onPress={() => {
                  setShowPayoutConfirmModal(false);
                  setPendingPayoutMethod(null);
                }}
              >
                <Text style={styles.cancelButtonText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={[styles.confirmModalButton, styles.confirmButton]}
                onPress={confirmPayoutMethodChange}
              >
                <Text style={styles.confirmButtonText}>{t('ok')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={showDeleteAccountModal} transparent animationType="fade">
        <View style={styles.backdrop}>
          <View style={styles.deleteModalCard}>
            <View style={styles.deleteModalIconWrap}>
              <MaterialIcons name="delete-forever" size={28} color="#DC2626" />
            </View>
            <Text style={styles.deleteModalTitle}>Delete Account?</Text>
            <Text style={styles.deleteModalText}>
              This action is permanent. Your account and linked data will be removed from the app.
            </Text>
            <View style={styles.confirmModalButtons}>
              <TouchableOpacity
                style={[styles.confirmModalButton, styles.cancelButton]}
                onPress={() => setShowDeleteAccountModal(false)}
                disabled={isDeletingAccount}
              >
                <Text style={styles.cancelButtonText}>{t('cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.confirmModalButton, styles.deleteConfirmButton, isDeletingAccount && styles.buttonDisabled]}
                onPress={handleDeleteAccount}
                disabled={isDeletingAccount}
              >
                {isDeletingAccount ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={styles.deleteConfirmButtonText}>Delete</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <View style={styles.spacer} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#F4F6F8",
  },
  container: {
    flex: 1,
    backgroundColor: "#F4F6F8",
  },
  contentContainer: {
    paddingBottom: 84,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 16,
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
  },
  sectionContainer: {
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 16,
    borderRadius: 20,
    padding: 18,
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 16,
  },
  iconBg: {
    width: 42,
    height: 42,
    borderRadius: 14,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
    backgroundColor: "#EEF2FF",
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  sectionSubtitle: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
    lineHeight: 18,
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: "#F3F4F6",
  },
  settingInfo: {
    flex: 1,
    paddingRight: 10,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: "600",
    color: "#111827",
  },
  settingDesc: {
    fontSize: 13,
    color: "#6B7280",
    marginTop: 4,
  },
  radioBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1.5,
    borderColor: "#D3D3D3",
    justifyContent: "center",
    alignItems: "center",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#17263A",
  },
  divider: {
    height: 1,
    backgroundColor: "#F5F5F5",
    marginLeft: 56,
  },
  actionButton: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 10,
    minHeight: 50,
    marginHorizontal: 4,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  saveButton: {
    backgroundColor: "#ffffff",
  },
  verificationButton: {
    backgroundColor: "#ffffff",
  },
  paymentMethodButton: {
    backgroundColor: "#ffffff",
  },
  referralButton: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 12,
    flexDirection: "row",
    backgroundColor: "#F59E0B",
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: "space-between",
    alignItems: "center",
  },
  referralText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    marginLeft: 12,
  },
  saveText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 8,
  },
  paymentMethodText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    marginLeft: 10,
  },
  linkedCardBank: {
    marginHorizontal: 14,
    marginBottom: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#DDE7FF",
    backgroundColor: "#F7FAFF",
  },
  linkedCardUpi: {
    marginHorizontal: 14,
    marginBottom: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#D8F6E8",
    backgroundColor: "#F2FCF7",
  },
  linkedCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  linkedCardTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#1A1A1A",
  },
  linkedCardText: {
    fontSize: 14,
    color: "#333",
    marginBottom: 4,
  },
  linkedCardFooter: {
    marginTop: 8,
    alignItems: "flex-end",
  },
  changeBankText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2563EB",
  },
  changeUpiText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#16A34A",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 16,
  },
  absoluteFill: {
    ...StyleSheet.absoluteFillObject,
  },
  payoutModalCard: {
    width: "100%",
    borderRadius: 16,
    backgroundColor: "#fff",
    padding: 16,
    zIndex: 1,
  },
  deleteModalCard: {
    width: "100%",
    maxWidth: 340,
    borderRadius: 16,
    backgroundColor: "#fff",
    padding: 18,
    zIndex: 1,
  },
  deleteModalIconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "#FEE2E2",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    marginBottom: 12,
  },
  deleteModalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
    textAlign: "center",
    marginBottom: 8,
  },
  deleteModalText: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 20,
    textAlign: "center",
    marginBottom: 10,
  },
  payoutModalTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 12,
  },
  methodRow: {
    borderWidth: 1,
    borderColor: "#E5E7EB",
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
  },
  methodRowActive: {
    borderColor: "#2563EB",
    backgroundColor: "#F6F9FF",
  },
  methodTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  methodDesc: {
    fontSize: 13,
    color: "#6B7280",
  },
  fullModal: {
    flex: 1,
    backgroundColor: "#fff",
    marginTop: 40,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    overflow: "hidden",
  },
  fullModalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#E5E7EB",
  },
  fullModalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#111827",
  },
  fullModalContent: {
    padding: 16,
  },
  inputLabel: {
    fontSize: 14,
    color: "#374151",
    fontWeight: "600",
    marginBottom: 6,
  },
  inputField: {
    borderWidth: 1,
    borderColor: "#D1D5DB",
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 11,
    marginBottom: 14,
    fontSize: 15,
    color: "#111827",
    backgroundColor: "#fff",
  },
  saveMethodBtn: {
    marginTop: 8,
    backgroundColor: "#2563EB",
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 13,
  },
  saveMethodText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  spacer: {
    height: 4,
  },
  actionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginHorizontal: 16,
    marginTop: 20,
  },
  rowButton: {
    flex: 1,
  },
  rowButtonText: {
    color: "#111827",
    fontSize: 15,
    fontWeight: "700",
    marginLeft: 8,
    textAlign: "center",
  },
  accountActionsCard: {
    marginHorizontal: 16,
    marginTop: 20,
    marginBottom: 24,
    padding: 18,
    borderRadius: 16,
    backgroundColor: "#FFF7F7",
    borderWidth: 1,
    borderColor: "#F5CACA",
  },
  accountActionsTitle: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  accountActionsText: {
    fontSize: 14,
    color: "#6B7280",
    lineHeight: 20,
    marginBottom: 12,
  },
  deleteAccountButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#DC2626",
    borderRadius: 12,
    paddingVertical: 14,
  },
  deleteAccountButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "700",
    marginLeft: 8,
  },
  
  // ✅ Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 20,
  },
  
  modalContainer: {
    backgroundColor: "#fff",
    borderRadius: 16,
    overflow: "hidden",
    width: "100%",
    maxWidth: 320,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 8,
  },
  
  modalHeader: {
    paddingVertical: 24,
    alignItems: "center",
  },
  
  modalIconBg: {
    width: 64,
    height: 64,
    borderRadius: 32,
    justifyContent: "center",
    alignItems: "center",
  },
  
  modalContent: {
    paddingHorizontal: 20,
    paddingVertical: 20,
    alignItems: "center",
  },
  
  modalTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1A1A1A",
    marginBottom: 8,
    textAlign: "center",
  },
  
  modalMessage: {
    fontSize: 14,
    color: "#666",
    textAlign: "center",
    lineHeight: 20,
  },
  
  modalButton: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    marginHorizontal: 20,
    marginBottom: 20,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },

  modalButtonText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
  },
  
  confirmModalMessage: {
    fontSize: 14,
    color: "#6B7280",
    textAlign: 'center',
    marginBottom: 8,
    lineHeight: 20,
  },
  confirmModalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 20,
  },
  confirmModalButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginHorizontal: 8,
  },
  cancelButton: {
    backgroundColor: '#F3F4F6',
  },
  confirmButton: {
    backgroundColor: '#2563EB',
  },
  deleteConfirmButton: {
    backgroundColor: '#DC2626',
  },
  cancelButtonText: {
    color: '#374151',
    fontSize: 16,
    fontWeight: '600',
  },
  confirmButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  deleteConfirmButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: "#F8F9FA",
  },
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: "#666",
    textAlign: 'center',
  },
});
