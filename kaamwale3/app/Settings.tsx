import React, { useState } from "react";
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
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useLanguage } from "../context/LanguageContext";
import { Language } from "../constants/translations";
import api from "../utils/api";

export default function SettingsScreen(): React.ReactElement {
  const router = useRouter();
  const { language: appLanguage, setLanguage, t } = useLanguage();
  const [notifications, setNotifications] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [upiAccount, setUpiAccount] = useState<any>(null);
  const [payoutMethod, setPayoutMethod] = useState<"bank" | "upi">("bank");
  const [showPayoutMethodModal, setShowPayoutMethodModal] = useState(false);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showAddUpi, setShowAddUpi] = useState(false);
  const [showBankInfo, setShowBankInfo] = useState(true);
  const [showUpiInfo, setShowUpiInfo] = useState(true);
  const [upiIdInput, setUpiIdInput] = useState("");
  const [isSavingBank, setIsSavingBank] = useState(false);
  const [isSavingUpi, setIsSavingUpi] = useState(false);
  const [isSavingPayoutMethod, setIsSavingPayoutMethod] = useState(false);
  const [isPayoutAllowed, setIsPayoutAllowed] = useState(true);
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: "",
    accountNumber: "",
    accountNumberConfirm: "",
    ifscCode: "",
    bankName: "",
    accountType: "savings",
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

  const handleLanguageChange = async (lang: Language) => {
    await setLanguage(lang);
  };

  const handleSave = () => {
    showStatusModal("success", t("success"), t("settingsSaved"));
  };

  React.useEffect(() => {
    fetchBankAccount();
    fetchUpiAccount();
    fetchPayoutMethod();
  }, []);

  const fetchBankAccount = async () => {
    try {
      const res = await api.get(`/wallet/bank-account`);
      if (res.data.success) setBankAccount(res.data.bankAccount);
    } catch (err: any) {
      if (err?.response?.status === 403) setIsPayoutAllowed(false);
      console.error("Error fetching bank account:", err);
    }
  };

  const fetchUpiAccount = async () => {
    try {
      const res = await api.get(`/wallet/upi`);
      if (res.data.success) setUpiAccount(res.data.upi || null);
    } catch (err: any) {
      if (err?.response?.status === 403) setIsPayoutAllowed(false);
      console.error("Error fetching UPI details:", err);
    }
  };

  const fetchPayoutMethod = async () => {
    try {
      const res = await api.get(`/wallet/payout-method`);
      if (res.data?.success && ["bank", "upi"].includes(res.data.payoutMethod)) {
        setPayoutMethod(res.data.payoutMethod);
      }
      setIsPayoutAllowed(true);
    } catch (err: any) {
      if (err?.response?.status === 403) {
        setIsPayoutAllowed(false);
        return;
      }
      console.error("Error fetching payout method:", err);
    }
  };

  const persistPayoutMethod = async (method: "bank" | "upi") => {
    setIsSavingPayoutMethod(true);
    try {
      const res = await api.post(`/wallet/payout-method`, { method });
      if (res.data?.success) {
        setPayoutMethod(res.data.payoutMethod || method);
      }
      return true;
    } catch (err: any) {
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
      const res = await api.post(`/wallet/bank-account/add`, bankDetails);
      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
        setPayoutMethod("bank");
        setShowAddBank(false);
        setShowBankInfo(true);
        setBankDetails({
          accountHolderName: "",
          accountNumber: "",
          accountNumberConfirm: "",
          ifscCode: "",
          bankName: "",
          accountType: "savings",
        });
        await persistPayoutMethod("bank");
        showStatusModal("success", t("success"), tx("bankSaved", "Bank account saved"));
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
    const upiRegex = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;
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
        setPayoutMethod("upi");
        setShowUpiInfo(true);
        setShowAddUpi(false);
        setUpiIdInput("");
        await persistPayoutMethod("upi");
        showStatusModal("success", t("success"), res.data.message || tx("success", "UPI ID saved successfully"));
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
          desc: "Receive job alerts and updates",
          value: notifications,
          onChange: setNotifications,
          type: "toggle",
        },
        {
          label: "Email Alerts",
          desc: "Get email updates for important events",
          value: emailAlerts,
          onChange: setEmailAlerts,
          type: "toggle",
        },
      ],
    },
    {
      title: "Display",
      icon: "brightness-4",
      color: "#4ECDC4",
      items: [
        {
          label: "Dark Mode",
          desc: "Easy on the eyes",
          value: darkMode,
          onChange: setDarkMode,
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
          value: appLanguage === "en",
          onChange: () => handleLanguageChange("en"),
          type: "radio",
        },
        {
          label: t('hindi'),
          value: appLanguage === "hi",
          onChange: () => handleLanguageChange("hi"),
          type: "radio",
        },
        {
          label: t('marathi'),
          value: appLanguage === "mr",
          onChange: () => handleLanguageChange("mr"),
          type: "radio",
        },
      ],
    },
  ];

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#6C63FF", "#A78BFA"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
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
  onValueChange={(value) => item.onChange(value)}
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

      {/* Verification Button */}
      <TouchableOpacity 
        style={styles.verificationButton} 
        onPress={() => router.push("/Verification" as any)}
      >
        <MaterialIcons name="verified-user" size={20} color="#fff" />
        <Text style={styles.verificationText}>Verification & KYC</Text>
        <MaterialIcons name="arrow-forward" size={20} color="#fff" />
      </TouchableOpacity>

      {/* Save Button */}
      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <MaterialIcons name="save" size={20} color="#fff" />
        <Text style={styles.saveText}>{t('save')} Settings</Text>
      </TouchableOpacity>

      {isPayoutAllowed && (
        <TouchableOpacity
          style={[styles.paymentMethodButton, isSavingPayoutMethod && styles.buttonDisabled]}
          disabled={isSavingPayoutMethod}
          onPress={() => setShowPayoutMethodModal(true)}
        >
          <MaterialIcons name="payment" size={20} color="#fff" />
          <Text style={styles.paymentMethodText}>
            {tx("paymentMethods", "Payment Methods")} ({payoutMethod === "bank" ? tx("bankAccount", "Bank") : tx("upiId", "UPI")})
          </Text>
          {isSavingPayoutMethod ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <MaterialIcons name="arrow-forward" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      )}

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
                setPayoutMethod("bank");
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
                setPayoutMethod("upi");
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

      <View style={styles.spacer} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 40,
    paddingBottom: 20,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.2)",
    justifyContent: "center",
    alignItems: "center",
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
    borderRadius: 12,
    overflow: "hidden",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  iconBg: {
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  settingRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  settingInfo: {
    flex: 1,
  },
  settingLabel: {
    fontSize: 15,
    fontWeight: "500",
    color: "#333",
  },
  settingDesc: {
    fontSize: 12,
    color: "#999",
    marginTop: 4,
  },
  radioBtn: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: "#D3D3D3",
    justifyContent: "center",
    alignItems: "center",
  },
  radioDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  divider: {
    height: 1,
    backgroundColor: "#F5F5F5",
    marginLeft: 68,
  },
  verificationButton: {
    marginHorizontal: 16,
    marginTop: 24,
    marginBottom: 12,
    flexDirection: "row",
    backgroundColor: "#10B981",
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: "space-between",
    alignItems: "center",
  },
  verificationText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    marginLeft: 12,
  },
  // ✅ Referral Button Styles
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
  saveButton: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 24,
    backgroundColor: "#6C63FF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    borderRadius: 12,
  },
  saveText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "600",
    marginLeft: 8,
  },
  paymentMethodButton: {
    marginHorizontal: 16,
    marginBottom: 12,
    flexDirection: "row",
    backgroundColor: "#2563EB",
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    justifyContent: "space-between",
    alignItems: "center",
  },
  paymentMethodText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    flex: 1,
    marginLeft: 12,
  },
  linkedCardBank: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#DDE7FF",
    backgroundColor: "#F7FAFF",
  },
  linkedCardUpi: {
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 14,
    borderRadius: 12,
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
    fontSize: 13,
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
    fontSize: 14,
    fontWeight: "700",
    color: "#111827",
    marginBottom: 4,
  },
  methodDesc: {
    fontSize: 12,
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
    fontSize: 13,
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
    fontSize: 14,
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
    height: 20,
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
});
