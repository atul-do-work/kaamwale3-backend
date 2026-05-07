import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Linking,
  LayoutAnimation,
  Platform,
  UIManager,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MaterialIcons } from "@expo/vector-icons";

// ✅ Enable layout animations for Android
if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}
import { useRouter } from "expo-router";

interface FAQItem {
  id: string;
  category: string;
  question: string;
  answer: string;
}

const faqData: FAQItem[] = [
  // General
  {
    id: "1",
    category: "General",
    question: "What is IndianWorker?",
    answer: "IndianWorker is a platform connecting contractors with workers for short-term job postings and task completion.",
  },
  {
    id: "2",
    category: "General",
    question: "How do I create an account?",
    answer: "Download the app, enter your phone number, verify with OTP, choose your role (Contractor/Worker), and complete your profile.",
  },
  {
    id: "3",
    category: "General",
    question: "Is there a registration fee?",
    answer: "No, registration is completely free. You only pay when you use premium features or post jobs.",
  },

  // For Contractors
  {
    id: "4",
    category: "Contractors",
    question: "How do I post a job?",
    answer: "Go to Dashboard → Post Job → Enter job details, location, budget, duration → Submit. Workers in your area will see it immediately.",
  },
  {
    id: "5",
    category: "Contractors",
    question: "What is the posting fee?",
    answer: "Standard posts are free. Premium features like featured posting cost ₹25-40 depending on the tier.",
  },
  {
    id: "6",
    category: "Contractors",
    question: "How do I select a worker?",
    answer: "After posting, workers will apply. Review their profile, ratings, and past work. Click 'Accept' to confirm.",
  },
  {
    id: "7",
    category: "Contractors",
    question: "Can I cancel a job?",
    answer: "Yes, you can cancel before a worker accepts. After acceptance, cancellation fees apply as per policy.",
  },

  // For Workers
  {
    id: "8",
    category: "Workers",
    question: "How do I find jobs?",
    answer: "Open Jobs tab → Browse available positions near you → Click to view details → Apply to jobs you're interested in.",
  },
  {
    id: "10",
    category: "Workers",
    question: "How do I get paid?",
    answer: "Payment is credited to your wallet after job completion and contractor confirmation. Minimum withdrawal: ₹100.",
  },
  {
    id: "11",
    category: "Workers",
    question: "What if I decline a job?",
    answer: "You can decline without penalty. However, declining frequently may lower your visibility to contractors.",
  },

  // Payment & Wallet
  {
    id: "12",
    category: "Payments",
    question: "How do I add money to wallet?",
    answer: "Go to Wallet → Deposit → Enter amount → Choose payment method (UPI/Card/NetBanking) → Confirm transaction.",
  },
  {
    id: "13",
    category: "Payments",
    question: "Is it safe to use the wallet?",
    answer: "Yes, all transactions are encrypted and secured. We use industry-standard security protocols.",
  },
  {
    id: "14",
    category: "Payments",
    question: "Can I withdraw money?",
    answer: "Yes, go to Wallet → Withdraw → Enter amount (minimum ₹100) → Select bank account → Confirm. Usually processes in 24 hours.",
  },
  {
    id: "15",
    category: "Payments",
    question: "What are transaction fees?",
    answer: "Deposits are free. Withdrawals have a small fee (2-3%) depending on your withdrawal method.",
  },
];

export default function HelpCentre() {
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("All");

  // ✅ Fix: Stable category order with sort
  const categories = [
    "All",
    ...Array.from(new Set(faqData.map((item) => item.category))).sort(),
  ];

  // ✅ Optimize: Memoize filtered results to avoid re-filtering on every render
  const filteredFAQ = useMemo(() => {
    return faqData.filter((item) => {
      const matchesSearch =
        item.question.toLowerCase().includes(searchText.toLowerCase()) ||
        item.answer.toLowerCase().includes(searchText.toLowerCase());
      const matchesCategory = selectedCategory === "All" || item.category === selectedCategory;
      return matchesSearch && matchesCategory;
    });
  }, [searchText, selectedCategory]);

  const handleContactSupport = () => {
    router.push("/SupportTickets" as any);
  };

  // ✅ Fix: Add error handling for Linking.openURL
  const handleCallSupport = async () => {
    const url = "tel:+919876543210";
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        console.warn("Phone dialer not available");
      }
    } catch (err) {
      console.error("Error opening phone dialer:", err);
    }
  };

  const handleEmailSupport = async () => {
    const url = "mailto:support@kaamwale.com";
    try {
      const supported = await Linking.canOpenURL(url);
      if (supported) {
        await Linking.openURL(url);
      } else {
        console.warn("Email client not available");
      }
    } catch (err) {
      console.error("Error opening email client:", err);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
        {/* Header with rounded corners and dark blue */}
        <View style={styles.headerWrapper}>
          <View style={styles.header}>
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.back()}
            >
              <MaterialIcons name="arrow-back" size={24} color="#fff" />
            </TouchableOpacity>
            <View style={styles.headerContent}>
              <Text style={styles.headerTitle}>Help Centre</Text>
              <Text style={styles.headerSubtitle}>Answers & support</Text>
            </View>
          </View>
        </View>

      <Text style={styles.sectionTitle}>Quick Support</Text>
      <View style={styles.quickSupportContainer}>
        <TouchableOpacity style={[styles.quickCard, styles.quickCardPrimary]} onPress={handleCallSupport}>
          <MaterialIcons name="phone" size={26} color="#fff" />
          <Text style={styles.quickCardText}>Call Us</Text>
          <Text style={styles.quickCardSub}>+91 9876 543210</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.quickCard, styles.quickCardSecondary]} onPress={handleEmailSupport}>
          <MaterialIcons name="email" size={26} color="#fff" />
          <Text style={styles.quickCardText}>Email</Text>
          <Text style={styles.quickCardSub}>support@kaamwale.com</Text>
        </TouchableOpacity>

        <TouchableOpacity style={[styles.quickCard, styles.quickCardTertiary]} onPress={handleContactSupport}>
          <MaterialIcons name="chat" size={26} color="#fff" />
          <Text style={styles.quickCardText}>Support Ticket</Text>
          <Text style={styles.quickCardSub}>Chat with us</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <MaterialIcons name="search" size={20} color="#667eea" />
        <TextInput
          placeholder="Search FAQs, topics or guides"
          style={styles.searchInput}
          value={searchText}
          onChangeText={setSearchText}
          placeholderTextColor="#999"
        />
        {searchText !== "" && (
          <TouchableOpacity onPress={() => setSearchText("")}>
            <MaterialIcons name="close" size={20} color="#667eea" />
          </TouchableOpacity>
        )}
      </View>

      {/* Category Filter */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.categoriesScroll}
      >
        {categories.map((category) => (
          <TouchableOpacity
            key={category}
            style={[
              styles.categoryBadge,
              selectedCategory === category && styles.categoryBadgeActive,
            ]}
            onPress={() => setSelectedCategory(category)}
          >
            <Text
              style={[
                styles.categoryText,
                selectedCategory === category && styles.categoryTextActive,
              ]}
            >
              {category}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* FAQ List */}
      <View style={styles.faqContainer}>
        {filteredFAQ.length > 0 ? (
          filteredFAQ.map((item) => (
            <View key={item.id} style={styles.faqItem}>
              <TouchableOpacity
                style={styles.faqQuestion}
                onPress={() => {
                  // ✅ Add: Layout animation for smooth expansion
                  LayoutAnimation.configureNext(
                    LayoutAnimation.Presets.easeInEaseOut
                  );
                  setExpandedId(expandedId === item.id ? null : item.id);
                }}
              >
                <View style={styles.questionContent}>
                  <Text style={styles.categoryLabel}>{item.category}</Text>
                  <Text style={styles.questionText}>{item.question}</Text>
                </View>
                <MaterialIcons
                  name={expandedId === item.id ? "expand-less" : "expand-more"}
                  size={24}
                  color="#1a2f4d"
                />
              </TouchableOpacity>

              {expandedId === item.id && (
                <View style={styles.faqAnswer}>
                  <Text style={styles.answerText}>{item.answer}</Text>
                </View>
              )}
            </View>
          ))
        ) : (
          <View style={styles.noResults}>
            <MaterialIcons name="search-off" size={48} color="#ccc" />
            <Text style={styles.noResultsText}>No results found</Text>
            <Text style={styles.noResultsSub}>Try searching with different keywords</Text>
          </View>
        )}
      </View>

      {/* Still Need Help Section */}
      <View style={styles.stillNeedHelp}>
        <Text style={styles.stillNeedHelpTitle}>Still need help?</Text>
        <Text style={styles.stillNeedHelpSub}>
          Contact our support team for immediate assistance
        </Text>

        <TouchableOpacity style={styles.contactButton} onPress={handleContactSupport}>
          <View style={styles.contactButtonContent}>
            <MaterialIcons name="support-agent" size={20} color="#fff" />
            <Text style={styles.contactButtonText}>Contact Support</Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Footer */}
      <View style={styles.footer}>
        <View style={styles.footerRow}>
          <MaterialIcons name="schedule" size={20} color="#667eea" />
          <View style={styles.footerText}>
            <Text style={styles.footerLabel}>Support Hours</Text>
            <Text style={styles.footerValue}>Mon-Sun, 9AM - 9PM IST</Text>
          </View>
        </View>

        <View style={styles.footerRow}>
          <MaterialIcons name="policy" size={20} color="#667eea" />
          <View style={styles.footerText}>
            <Text style={styles.footerLabel}>Community Guidelines</Text>
            <Text style={styles.footerValue}>Follow our code of conduct</Text>
          </View>
        </View>

        <View style={styles.footerRow}>
          <MaterialIcons name="security" size={20} color="#667eea" />
          <View style={styles.footerText}>
            <Text style={styles.footerLabel}>Safety & Security</Text>
            <Text style={styles.footerValue}>Your safety is our priority</Text>
          </View>
        </View>
      </View>

      <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F1F5F9",
  },
  headerWrapper: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 16,
    backgroundColor: "#F1F5F9",
  },
  header: {
    backgroundColor: "#1a2f4d",
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
  },
  backButton: {
    marginRight: 12,
    padding: 6,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 2,
  },
  headerSubtitle: {
    fontSize: 13,
    color: "rgba(255,255,255,0.8)",
  },
  sectionTitle: {
    marginTop: 18,
    marginHorizontal: 16,
    fontSize: 16,
    fontWeight: "700",
    color: "#1a2f4d",
    marginBottom: 14,
  },
  quickSupportContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginBottom: 20,
    gap: 12,
  },
  quickCard: {
    flex: 1,
    minHeight: 120,
    borderRadius: 16,
    padding: 16,
    alignItems: "flex-start",
    justifyContent: "space-between",
    shadowColor: "#000",
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 12,
    elevation: 4,
  },
  quickCardPrimary: {
    backgroundColor: "#3b82f6",
  },
  quickCardSecondary: {
    backgroundColor: "#10b981",
  },
  quickCardTertiary: {
    backgroundColor: "#8b5cf6",
    marginRight: 0,
  },
  quickCardText: {
    fontSize: 14,
    fontWeight: "700",
    color: "#fff",
    marginTop: 12,
  },
  quickCardSub: {
    fontSize: 11,
    color: "rgba(255,255,255,0.85)",
    marginTop: 4,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginBottom: 18,
    shadowColor: "#000",
    shadowOpacity: 0.06,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  searchInput: {
    flex: 1,
    marginHorizontal: 12,
    fontSize: 15,
    color: "#333",
  },
  categoriesScroll: {
    paddingHorizontal: 16,
    marginBottom: 18,
  },
  categoryBadge: {
    backgroundColor: "#fff",
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginRight: 10,
    borderWidth: 1,
    borderColor: "#E5E7EB",
  },
  categoryBadgeActive: {
    backgroundColor: "#1a2f4d",
    borderColor: "#1a2f4d",
  },
  categoryText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666",
  },
  categoryTextActive: {
    color: "#fff",
  },
  faqContainer: {
    paddingHorizontal: 16,
    marginBottom: 22,
  },
  faqItem: {
    backgroundColor: "#fff",
    borderRadius: 14,
    marginBottom: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  faqQuestion: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  questionContent: {
    flex: 1,
    marginRight: 14,
  },
  categoryLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#667eea",
    marginBottom: 4,
    textTransform: "uppercase",
  },
  questionText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#1a2f4d",
    lineHeight: 20,
  },
  faqAnswer: {
    backgroundColor: "#f8f9fa",
    borderTopWidth: 1,
    borderTopColor: "#E5E7EB",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  answerText: {
    fontSize: 14,
    color: "#555",
    lineHeight: 22,
  },
  noResults: {
    alignItems: "center",
    paddingVertical: 40,
  },
  noResultsText: {
    fontSize: 18,
    fontWeight: "600",
    color: "#999",
    marginTop: 12,
  },
  noResultsSub: {
    fontSize: 13,
    color: "#bbb",
    marginTop: 6,
  },
  stillNeedHelp: {
    marginHorizontal: 16,
    marginBottom: 22,
    backgroundColor: "#fff",
    borderRadius: 16,
    padding: 20,
    alignItems: "center",
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  stillNeedHelpTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a2f4d",
    marginBottom: 8,
  },
  stillNeedHelpSub: {
    fontSize: 13,
    color: "#666",
    marginBottom: 16,
    textAlign: "center",
    lineHeight: 20,
  },
  contactButton: {
    width: "100%",
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#1a2f4d",
  },
  contactButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    gap: 10,
  },
  contactButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
  footer: {
    marginHorizontal: 16,
    marginBottom: 22,
    gap: 12,
  },
  footerRow: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    alignItems: "flex-start",
    gap: 14,
    shadowColor: "#000",
    shadowOpacity: 0.04,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 8,
    elevation: 2,
  },
  footerText: {
    flex: 1,
  },
  footerLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1a2f4d",
    marginBottom: 3,
  },
  footerValue: {
    fontSize: 12,
    color: "#888",
    lineHeight: 18,
  },
});
