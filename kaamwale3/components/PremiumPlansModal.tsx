import React, { useRef, useState } from "react";
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
import { useAuth } from "../context/AuthContext";
import api from "../utils/api";
import { premiumCacheManager } from "../utils/premiumCacheManager";

interface PremiumPlansModalProps {
  visible: boolean;
  onClose: () => void;
  onPlanSelected: (planId: string) => void | Promise<void>;
}

export default function PremiumPlansModal({
  visible,
  onClose,
  onPlanSelected,
}: PremiumPlansModalProps) {
  const { updateUserPremium } = useAuth();
  const [subscribing, setSubscribing] = useState(false);
  const [subscribingPlanId, setSubscribingPlanId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [plansLoading, setPlansLoading] = React.useState(false);
  const [walletBalance, setWalletBalance] = React.useState(0);
  const [plans, setPlans] = React.useState<Array<{ id: string; name: string; price: number; features: string[]; popular?: boolean }>>([]);
  const subscribeInFlightRef = useRef(false);

  // Fetch wallet balance when modal opens
  React.useEffect(() => {
    if (visible) {
      setError("");
      fetchWalletBalance();
      fetchPlans();
    }
  }, [visible]);

  const fetchWalletBalance = async () => {
    try {
      const res = await api.get(`/wallet/balance`);
      const data = res.data;
      if (data.balance !== undefined) {
        setWalletBalance(data.balance);
      }
    } catch (err) {
      console.log("Could not fetch wallet balance:", err);
    }
  };

  const fetchPlans = async () => {
    try {
      setPlansLoading(true);
      const res = await api.get(`/premium/plans`);
      const data = res.data;
      if (data?.success && Array.isArray(data.plans) && data.plans.length > 0) {
        setPlans(data.plans);
        return;
      }
      setPlans([]);
      setError("No premium plans available right now. Please try again.");
    } catch (err) {
      setPlans([]);
      setError("Unable to load premium plans. Please check connection and retry.");
    } finally {
      setPlansLoading(false);
    }
  };

  const handleSubscribe = async (planId: string) => {
    if (subscribeInFlightRef.current || subscribing) return;

    try {
      subscribeInFlightRef.current = true;
      setError("");
      setSubscribing(true);
      setSubscribingPlanId(planId);
      const idempotencyKey = `premium:${planId}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

      const res = await api.post(`/premium/subscribe`, { planId, autoRenew: false, idempotencyKey });
      const data = res.data;

      if (data.success) {
        // ✅ CLEAR CACHE IMMEDIATELY after successful purchase
        premiumCacheManager.invalidate();
        console.log('🗑️ Premium cache cleared after successful subscription');

        // ✅ Keep auth context in sync immediately after successful subscription.
        if (data.premiumPlan) {
          await updateUserPremium(data.premiumPlan);
          console.log("✅ Premium activated instantly:", data.premiumPlan);
        }

        await onPlanSelected(planId);
        onClose();
      } else {
        setError(data.message || "Subscription failed");
      }
    } catch (err: any) {
      const apiError = err?.response?.data?.message;
      setError(apiError || (err instanceof Error ? err.message : "Network error"));
    } finally {
      subscribeInFlightRef.current = false;
      setSubscribing(false);
      setSubscribingPlanId(null);
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
          <View style={{ paddingHorizontal: 20, marginBottom: 15 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <View>
                <Text style={{ fontSize: 20, fontWeight: "bold", color: "#333" }}>Choose Plan</Text>
                <Text style={{ fontSize: 12, color: "#666", marginTop: 4 }}>Wallet Balance: {"\u20B9"}{walletBalance}</Text>
              </View>
              <TouchableOpacity onPress={onClose} disabled={subscribing}>
                <MaterialIcons name="close" size={24} color="#666" />
              </TouchableOpacity>
            </View>
          </View>

          {error ? (
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
              <Text style={{ color: "#d32f2f", fontSize: 13, fontWeight: "500" }}>{error}</Text>
            </View>
          ) : null}

          <ScrollView style={{ paddingHorizontal: 15 }}>
            {plansLoading ? (
              <View style={{ paddingVertical: 24, alignItems: "center" }}>
                <ActivityIndicator size="small" color="#2E8B57" />
                <Text style={{ marginTop: 10, color: "#666", fontSize: 13 }}>Loading plans...</Text>
              </View>
            ) : null}

            {!plansLoading && plans.length === 0 ? (
              <View style={{ paddingVertical: 16 }}>
                <Text style={{ color: "#666", textAlign: "center", marginBottom: 10 }}>
                  No plans to show right now.
                </Text>
                <TouchableOpacity
                  onPress={fetchPlans}
                  style={{
                    alignSelf: "center",
                    backgroundColor: "#2E8B57",
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 6,
                  }}
                >
                  <Text style={{ color: "#fff", fontWeight: "700" }}>Retry</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {plans.map((plan) => {
              const hasSufficientBalance = walletBalance >= plan.price;
              return (
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
                  {plan.popular ? (
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
                      <Text style={{ fontSize: 10, fontWeight: "bold", color: "#333" }}>POPULAR</Text>
                    </View>
                  ) : null}

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
                      {"\u20B9"}{plan.price}
                    </Text>
                  </View>

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

                  <TouchableOpacity
                    onPress={() => handleSubscribe(plan.id)}
                    disabled={subscribing || plansLoading || !hasSufficientBalance}
                    style={{
                      backgroundColor: plan.popular ? "#FFD700" : "#2E8B57",
                      paddingVertical: 10,
                      borderRadius: 6,
                      opacity: subscribing || plansLoading || !hasSufficientBalance ? 0.6 : 1,
                    }}
                  >
                    {subscribing && subscribingPlanId === plan.id ? (
                      <ActivityIndicator color={plan.popular ? "#333" : "#fff"} size="small" />
                    ) : (
                      <Text
                        style={{
                          textAlign: "center",
                          fontWeight: "bold",
                          color: !hasSufficientBalance ? "#f8f8f8" : plan.popular ? "#333" : "#fff",
                        }}
                      >
                        {hasSufficientBalance ? "Choose Plan" : "Insufficient Wallet Balance"}
                      </Text>
                    )}
                  </TouchableOpacity>
                </View>
              </LinearGradient>
              );
            })}

            <TouchableOpacity
              onPress={onClose}
              disabled={subscribing}
              style={{
                paddingVertical: 12,
                marginBottom: 20,
                borderTopWidth: 1,
                borderTopColor: "#eee",
                marginTop: 10,
                opacity: subscribing ? 0.6 : 1,
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



