import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  Switch,
  StyleSheet,
  Alert,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import ReferralModal from "../components/ReferralModal";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useLanguage } from "../context/LanguageContext";
import { Language } from "../constants/translations";

export default function SettingsScreen(): React.ReactElement {
  const router = useRouter();
  const { language: appLanguage, setLanguage, t } = useLanguage();
  const [notifications, setNotifications] = useState(true);
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [darkMode, setDarkMode] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState("upi");
  const [referralModalVisible, setReferralModalVisible] = useState(false);
  const [workerName, setWorkerName] = useState("Worker");
  const [workerPhone, setWorkerPhone] = useState("9876543210");

  React.useEffect(() => {
    (async () => {
      const userStr = await AsyncStorage.getItem("user");
      if (userStr) {
        const user = JSON.parse(userStr);
        setWorkerName(user.name || "Worker");
        setWorkerPhone(user.phone || "9876543210");
      }
    })();
  }, []);

  const handleLanguageChange = async (lang: Language) => {
    await setLanguage(lang);
  };

  const handleSave = () => {
    Alert.alert(t('success'), t('settingsSaved'));
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
    {
      title: "Payment Methods",
      icon: "payment",
      color: "#2ECC71",
      items: [
        {
          label: "UPI",
          value: selectedPayment === "upi",
          onChange: () => setSelectedPayment("upi"),
          type: "radio",
        },
        {
          label: "Bank Transfer",
          value: selectedPayment === "bank",
          onChange: () => setSelectedPayment("bank"),
          type: "radio",
        },
        {
          label: t('wallet'),
          value: selectedPayment === "wallet",
          onChange: () => setSelectedPayment("wallet"),
          type: "radio",
        },
      ],
    },
  ];

  const handleVerification = () => {
    router.push("/Verification" as any);
  };

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

      {/* ✅ Referral Button */}
      <TouchableOpacity 
        style={styles.referralButton} 
        onPress={() => setReferralModalVisible(true)}
      >
        <MaterialIcons name="card-giftcard" size={20} color="#fff" />
        <Text style={styles.referralText}>Refer & Earn ₹50</Text>
        <MaterialIcons name="arrow-forward" size={20} color="#fff" />
      </TouchableOpacity>

      {/* Save Button */}
      <TouchableOpacity style={styles.saveButton} onPress={handleSave}>
        <MaterialIcons name="save" size={20} color="#fff" />
        <Text style={styles.saveText}>{t('save')} Settings</Text>
      </TouchableOpacity>

      {/* ✅ Referral Modal */}
      <ReferralModal
        visible={referralModalVisible}
        onClose={() => setReferralModalVisible(false)}
        workerName={workerName}
        workerPhone={workerPhone}
      />

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
  spacer: {
    height: 20,
  },
});
