import React, { useState } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { MaterialIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_BASE } from "../utils/config";

interface PremiumPlansModalProps {
  visible: boolean;
  onClose: () => void;
  onPlanSelected: (planId: string) => void;
}

export default function PremiumPlansModal({
  visible,
  onClose,
  onPlanSelected,
}: PremiumPlansModalProps) {
  const [subscribing, setSubscribing] = useState(false);
  const [error, setError] = useState("");
  const [walletBalance, setWalletBalance] = React.useState(0);

  // Fetch wallet balance when modal opens
  React.useEffect(() => {
    if (visible) {
      fetchWalletBalance();
    }
  }, [visible]);

  const fetchWalletBalance = async () => {
    try {
      const token = await AsyncStorage.getItem("token");
      const res = await fetch(`${API_BASE}/wallet/balance`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.balance !== undefined) {
        setWalletBalance(data.balance);
      }
    } catch (err) {
      console.log("Could not fetch wallet balance:", err);
    }
  };

  const plans = [
    {
      id: "basic",
      name: "Basic",
      price: 399,
      features: [
        "🔥 Bulk Hiring",
        "⚡ 24/7 Instant",
        "📊 Leaderboard",
      ],
      popular: false,
    },
    {
      id: "pro",
      name: "Pro",
      price: 699,
      features: [
        "🔥 Bulk Hiring",
        "⚡ 24/7 Instant",
        "📊 Leaderboard",
        "✨ Custom Add-ons",
      ],
      popular: true,
    },
  ];

  const handleSubscribe = async (planId: string) => {
    try {
      setError("");
      setSubscribing(true);
      const token = await AsyncStorage.getItem("token");

      const res = await fetch(`${API_BASE}/premium/subscribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ planId, customAddons: [] }),
      });

      const data = await res.json();

      if (data.success) {
        onPlanSelected(planId);
        onClose();
      } else {
        setError(data.message || "Subscription failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubscribing(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View
        style={{
          flex: 1,
          backgroundColor: "rgba(0,0,0,0.7)",
          justifyContent: "flex-end",
        }}
      >
        <View
          style={{
            backgroundColor: "#fff",
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            paddingTop: 20,
            maxHeight: "85%",
          }}
        >
          {/* Header */}
          <View style={{ paddingHorizontal: 20, marginBottom: 15 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ fontSize: 20, fontWeight: "bold", color: "#333" }}>
                  Choose Plan
                </Text>
                <Text style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  Wallet Balance: ₹{walletBalance}
                </Text>
              </View>
              <TouchableOpacity onPress={onClose}>
                <MaterialIcons name="close" size={24} color="#666" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Error Message */}
          {error && (
            <View
              style={{
                backgroundColor: "#ffebee",
                borderLeftWidth: 4,
                borderLeftColor: "#d32f2f",
                padding: 12,
                marginHorizontal: 15,
                marginBottom: 12,
                borderRadius: 4,
              }}
            >
              <Text style={{ color: "#d32f2f", fontSize: 13, fontWeight: "500" }}>
                {error}
              </Text>
            </View>
          )}

          {/* Add Test Balance Button */}
          <TouchableOpacity
            onPress={async () => {
              try {
                const token = await AsyncStorage.getItem("token");
                const res = await fetch(`${API_BASE}/wallet/add-test-balance`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${token}`,
                  },
                  body: JSON.stringify({ amount: 1000 }),
                });
                const data = await res.json();
                if (data.success) {
                  setWalletBalance(data.newBalance);
                  setError("");
                }
              } catch (err) {
                console.error("Error adding test balance:", err);
              }
            }}
            style={{
              backgroundColor: "#e3f2fd",
              borderWidth: 1,
              borderColor: "#2196F3",
              paddingVertical: 10,
              paddingHorizontal: 15,
              marginHorizontal: 15,
              marginBottom: 12,
              borderRadius: 6,
            }}
          >
            <Text style={{ color: "#2196F3", fontSize: 13, fontWeight: "600", textAlign: "center" }}>
              + Add ₹1000 Test Balance
            </Text>
          </TouchableOpacity>

          {/* Plans */}
          <ScrollView style={{ paddingHorizontal: 15 }}>
            {plans.map((plan) => (
              <LinearGradient
                key={plan.id}
                colors={plan.popular ? ["#2E8B57", "#1a4d2e"] : ["#f5f5f5", "#fff"]}
                style={{
                  borderRadius: 12,
                  marginBottom: 12,
                  overflow: "hidden",
                  borderWidth: plan.popular ? 0 : 1,
                  borderColor: "#ddd",
                }}
              >
                <View style={{ padding: 15 }}>
                  {/* Popular Badge */}
                  {plan.popular && (
                    <View
                      style={{
                        backgroundColor: "#FFD700",
                        paddingHorizontal: 8,
                        paddingVertical: 4,
                        borderRadius: 4,
                        alignSelf: "flex-start",
                        marginBottom: 10,
                      }}
                    >
                      <Text style={{ fontSize: 10, fontWeight: "bold", color: "#333" }}>
                        POPULAR
                      </Text>
                    </View>
                  )}

                  {/* Plan Name & Price */}
                  <View style={{ flexDirection: "row", alignItems: "baseline", marginBottom: 10 }}>
                    <Text
                      style={{
                        fontSize: 22,
                        fontWeight: "bold",
                        color: plan.popular ? "#fff" : "#333",
                      }}
                    >
                      {plan.name}
                    </Text>
                    <Text
                      style={{
                        fontSize: 26,
                        fontWeight: "bold",
                        color: plan.popular ? "#FFD700" : "#2E8B57",
                        marginLeft: 10,
                      }}
                    >
                      ₹{plan.price}
                    </Text>
                  </View>

                  {/* Features */}
                  <View style={{ marginBottom: 12 }}>
                    {plan.features.map((feature, idx) => (
                      <Text
                        key={idx}
                        style={{
                          fontSize: 13,
                          color: plan.popular ? "#ddd" : "#666",
                          marginVertical: 4,
                        }}
                      >
                        {feature}
                      </Text>
                    ))}
                  </View>

                  {/* Subscribe Button */}
                  <TouchableOpacity
                    onPress={() => handleSubscribe(plan.id)}
                    disabled={subscribing}
                    style={{
                      backgroundColor: plan.popular ? "#FFD700" : "#2E8B57",
                      paddingVertical: 10,
                      borderRadius: 6,
                      opacity: subscribing ? 0.6 : 1,
                    }}
                  >
                    {subscribing ? (
                      <ActivityIndicator
                        color={plan.popular ? "#333" : "#fff"}
                        size="small"
                      />
                    ) : (
                      <Text
                        style={{
                          textAlign: "center",
                          fontWeight: "bold",
                          color: plan.popular ? "#333" : "#fff",
                        }}
                      >
                        Choose Plan
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </LinearGradient>
            ))}

            {/* Close Button */}
            <TouchableOpacity
              onPress={onClose}
              style={{
                paddingVertical: 12,
                marginBottom: 20,
                borderTopWidth: 1,
                borderTopColor: "#eee",
                marginTop: 10,
              }}
            >
              <Text
                style={{
                  textAlign: "center",
                  color: "#2E8B57",
                  fontWeight: "bold",
                  fontSize: 14,
                }}
              >
                Cancel
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
