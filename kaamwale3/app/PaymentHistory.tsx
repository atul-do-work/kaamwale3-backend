import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useAuth } from "../context/AuthContext";
import api from "../utils/api";

interface Transaction {
  id: string;
  type: "credit" | "debit" | "refund";
  description: string;
  amount: number;
  date: string;
  status: "completed" | "pending" | "failed";
}

export default function PaymentHistoryScreen(): React.ReactElement {
  const router = useRouter();
  const { accessToken } = useAuth();
  const [filter, setFilter] = useState<"all" | "credit" | "debit" | "refund">("all");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTransactions();
  }, []);

  const fetchTransactions = async () => {
    try {
      const res = await api.get(`/wallet/transactions`);
      const data = res.data;
      if (data.success && data.transactions) {
        setTransactions(data.transactions);
      }
    } catch (err) {
      console.error("Failed to fetch transactions:", err);
    } finally {
      setLoading(false);
    }
  };

  const typeConfig = {
    credit: { icon: "arrow-downward", color: "#2ECC71", label: "Credited" },
    debit: { icon: "arrow-upward", color: "#FF6B6B", label: "Debited" },
    refund: { icon: "undo", color: "#4ECDC4", label: "Refunded" },
  };

  const filteredTransactions = transactions
    .filter((t) => (filter === "all" ? true : t.type === filter))
    .reverse(); // ✅ Show recent transactions at top

  return (
    <View style={styles.container}>
      {/* Header */}
      <LinearGradient colors={["#6C63FF", "#A78BFA"]} style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Transaction History</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      {/* Filter Tabs */}
      <View style={styles.filterContainer}>
        {["all", "credit", "debit", "refund"].map((f) => (
          <TouchableOpacity
            key={f}
            style={[
              styles.filterTab,
              filter === f && styles.filterTabActive,
            ]}
            onPress={() => setFilter(f as any)}
          >
            <Text
              style={[
                styles.filterText,
                filter === f && styles.filterTextActive,
              ]}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Transactions List */}
      <ScrollView style={styles.content}>
        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6C63FF" />
          </View>
        ) : filteredTransactions.length === 0 ? (
          <View style={styles.emptyContainer}>
            <MaterialIcons name="receipt" size={48} color="#CCC" />
            <Text style={styles.emptyText}>No transactions yet</Text>
          </View>
        ) : (
          filteredTransactions.map((transaction) => {
            const config = typeConfig[transaction.type];
            const isPositive = transaction.type === "credit" || transaction.type === "refund";

            return (
              <View key={transaction.id} style={styles.transactionCard}>
                <View style={[styles.iconBg, { backgroundColor: config.color + "20" }]}>
                  <MaterialIcons name={config.icon as any} size={20} color={config.color} />
                </View>

                <View style={styles.transactionInfo}>
                  <Text style={styles.description}>{transaction.description}</Text>
                  <Text style={styles.date}>{transaction.date}</Text>
                </View>

                <View style={styles.amountContainer}>
                  <Text
                    style={[
                      styles.amount,
                      { color: isPositive ? "#2ECC71" : "#FF6B6B" },
                    ]}
                  >
                    {isPositive ? "+" : "-"}₹{Math.abs(transaction.amount).toFixed(2)}
                  </Text>
                  <View
                    style={[
                      styles.statusDot,
                      {
                        backgroundColor:
                          transaction.status === "completed"
                            ? "#2ECC71"
                            : transaction.status === "pending"
                            ? "#F39C12"
                            : "#FF6B6B",
                      },
                    ]}
                  />
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </View>
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
  balanceCard: {
    marginHorizontal: 16,
    marginTop: 16,
    marginBottom: 20,
    borderRadius: 16,
    overflow: "hidden",
  },
  balanceGradient: {
    paddingHorizontal: 20,
    paddingVertical: 24,
  },
  balanceLabel: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
    marginBottom: 8,
  },
  balanceAmount: {
    fontSize: 32,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 20,
  },
  balanceFooter: {
    flexDirection: "row",
    gap: 30,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.2)",
  },
  balanceInfo: {
    flex: 1,
  },
  balanceSmall: {
    fontSize: 12,
    color: "rgba(255,255,255,0.7)",
  },
  balanceSmallAmount: {
    fontSize: 16,
    fontWeight: "700",
    color: "#fff",
    marginTop: 4,
  },
  filterContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: "#fff",
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  filterTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  filterTabActive: {
    borderBottomColor: "#6C63FF",
  },
  filterText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#999",
  },
  filterTextActive: {
    color: "#6C63FF",
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  transactionCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 10,
  },
  iconBg: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  transactionInfo: {
    flex: 1,
  },
  description: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1A1A1A",
  },
  date: {
    fontSize: 13,
    color: "#555",
    marginTop: 6,
    fontWeight: "500",
  },
  amountContainer: {
    alignItems: "flex-end",
    gap: 6,
  },
  amount: {
    fontSize: 15,
    fontWeight: "700",
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 40,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingVertical: 60,
  },
  emptyText: {
    fontSize: 16,
    color: "#999",
    marginTop: 12,
  },
});
