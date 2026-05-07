import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons, Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import api from "../utils/api";

interface Transaction {
  id: string;
  type: "credit" | "debit" | "refund";
  description: string;
  amount: number;
  date: string;
  status: "completed" | "pending" | "failed";
}

type FilterType = "all" | "credit" | "debit" | "refund";

export default function PaymentHistoryScreen(): React.ReactElement {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterType>("all");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const isFetchingRef = useRef(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);

  // Fetch when screen gains focus (covers initial mount and returning to screen)
  useFocusEffect(
    useCallback(() => {
      setPage(1);
      setHasMore(true);
      fetchTransactions(1, false);
    }, [])
  );

  const fetchTransactions = async (pageToLoad = 1, append = false) => {
    if (isFetchingRef.current) return;
    isFetchingRef.current = true;
    if (pageToLoad === 1) {
      setLoading(true);
      setError("");
    }
    try {
      // basic pagination query params; backend may ignore if not supported
      const res = await api.get(`/wallet/transactions?page=${pageToLoad}&limit=20`);
      const data = res.data;
      if (data.success && Array.isArray(data.transactions)) {
        if (append) {
          setTransactions((prev) => {
            const next = [...prev, ...data.transactions];
            return JSON.stringify(prev) !== JSON.stringify(next) ? next : prev;
          });
        } else {
          setTransactions(data.transactions);
        }
        // simple hasMore detection
        setHasMore((data.transactions.length || 0) >= 20);
        setPage(pageToLoad);
      } else {
        setError("Failed to load transactions");
      }
    } catch (err) {
      console.error("Failed to fetch transactions:", err);
      setError("Unable to fetch transactions. Please try again.");
    } finally {
      isFetchingRef.current = false;
      setLoading(false);
    }
  };

  const typeConfig = {
    credit: { icon: "arrow-downward", color: "#2ECC71", label: "Credited" },
    debit: { icon: "arrow-upward", color: "#FF6B6B", label: "Debited" },
    refund: { icon: "undo", color: "#4ECDC4", label: "Refunded" },
  };

  const parseTransactionDate = (raw: string): Date | null => {
    if (!raw) return null;

    const direct = new Date(raw);
    if (!Number.isNaN(direct.getTime())) {
      return direct;
    }

    const match = raw.match(
      /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
    );
    if (!match) return null;

    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    let hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    const meridiem = (match[7] || "").toUpperCase();

    if (meridiem === "PM" && hour < 12) hour += 12;
    if (meridiem === "AM" && hour === 12) hour = 0;

    const parsed = new Date(year, month, day, hour, minute, second);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  const formatTransactionDateTime = (raw: string): string => {
    const parsed = parseTransactionDate(raw);
    if (!parsed) return raw || "-";

    const date = parsed.toLocaleDateString("en-IN");
    const hasTime = /\d{1,2}:\d{2}|T|AM|PM/i.test(String(raw));
    if (!hasTime) return date;

    const time = parsed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    return `${date} • ${time}`;
  };

  const getTransactionDescription = (raw: string): string => {
    const description = String(raw || "").trim();
    if (!description) return "Transaction";

    const normalized = description.toLowerCase();
    if (/(deposit|cash deposit|wallet topup|wallet credit|pocket balance)/.test(normalized)) {
      return "Pocket balance deposit";
    }
    if (/(withdrawal|debited|payment|paid)/.test(normalized)) {
      return "Wallet transaction";
    }
    return description;
  };

  // ✅ Fix: Memoize filtered & reversed transactions (avoid mutating state)
  const filteredTransactions = useMemo(() => {
    return [...transactions]
      .filter((t) => (filter === "all" ? true : t.type === filter))
      .reverse(); // Show recent transactions at top
  }, [transactions, filter]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <LinearGradient colors={["#17263A", "#243B55"]} style={[styles.header, { paddingTop: 10 }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Transaction History</Text>
        <View style={{ width: 40 }} />
      </LinearGradient>

      {/* Filter Tabs */}
      <View style={styles.filterContainer}>
        {(["all", "credit", "debit", "refund"] as FilterType[]).map((f) => (
          <TouchableOpacity
            key={f}
            style={[
              styles.filterTab,
              filter === f && styles.filterTabActive,
            ]}
            onPress={() => setFilter(f)}
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

      {/* ✅ Fix: Replace ScrollView with FlatList for performance */}
      <FlatList
        style={styles.content}
        data={filteredTransactions}
        keyExtractor={(item, index) => item.id || index.toString()}
        renderItem={({ item: transaction }) => {
          const config = typeConfig[transaction.type];
          const isPositive = transaction.type === "credit" || transaction.type === "refund";

          return (
            <View style={styles.transactionCard}>
              <View style={[styles.iconBg, { backgroundColor: config.color + "20" }]}>
                <MaterialIcons name={config.icon as any} size={20} color={config.color} />
              </View>

              <View style={styles.transactionInfo}>
                <Text style={styles.description}>{getTransactionDescription(transaction.description)}</Text>
                <Text style={styles.date}>
                  {formatTransactionDateTime(transaction.date)}
                </Text>
              </View>

              <View style={styles.amountContainer}>
                <Text
                  style={[
                    styles.amount,
                    { color: isPositive ? "#2ECC71" : "#FF6B6B" },
                  ]}
                >
                  {new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(transaction.amount)}
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
        }}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#17263A" />
            </View>
          ) : error ? (
            <View style={styles.emptyContainer}>
              <MaterialIcons name="error-outline" size={48} color="#FF6B6B" />
              <Text style={styles.emptyText}>{error}</Text>
              <TouchableOpacity onPress={() => fetchTransactions(1, false)} style={{ marginTop: 12 }}>
                <Text style={{ color: '#17263A', fontWeight: '700' }}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyContainer}>
              <MaterialIcons name="receipt" size={48} color="#CCC" />
              <Text style={styles.emptyText}>No transactions yet</Text>
            </View>
          )
        }
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (!loading && hasMore) fetchTransactions(page + 1, true);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F4F6F8",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingBottom: 18,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 24,
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.14)",
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
    paddingVertical: 14,
    backgroundColor: "#fff",
    marginHorizontal: 16,
    marginTop: 14,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#E8EDF3",
  },
  filterTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: "center",
    borderRadius: 12,
  },
  filterTabActive: {
    backgroundColor: "#17263A",
  },
  filterText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#6B7280",
  },
  filterTextActive: {
    color: "#FFFFFF",
  },
  content: {
    flex: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  transactionCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#E8EDF3",
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
    fontWeight: "700",
    color: "#111827",
  },
  date: {
    fontSize: 12,
    color: "#6B7280",
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
