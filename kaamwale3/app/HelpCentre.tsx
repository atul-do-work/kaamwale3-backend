import React, { useState } from "react";
import {
  View,
  Text,
  ScrollView,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Image,
  Linking,
  Alert,
} from "react-native";
import { MaterialIcons, FontAwesome5 } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
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
    question: "What is Kaamwale?",
    answer: "Kaamwale is a platform connecting contractors with workers for short-term job postings and task completion.",
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
    answer: "Standard posts are free. Premium features like featured posting cost ₹50-100 depending on the tier.",
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
    id: "9",
    category: "Workers",
    question: "How are workers rated?",
    answer: "After job completion, contractors rate your work 1-5 stars with feedback. This affects your ranking.",
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

  // Support & Issues
  {
    id: "16",
    category: "Support",
    question: "How do I report a problem?",
    answer: "Go to Settings → Support Tickets → Submit New Ticket → Describe the issue with screenshots if needed.",
  },
  {
    id: "17",
    category: "Support",
    question: "What is the response time for support?",
    answer: "We respond to all tickets within 24 hours. Critical issues are handled within 2-4 hours.",
  },
  {
    id: "18",
    category: "Support",
    question: "How do I dispute a rating?",
    answer: "If you believe a rating is unfair, file a support ticket with evidence. Our team will review and take action if needed.",
  },
  {
    id: "19",
    category: "Support",
    question: "What should I do if I have a safety concern?",
    answer: "Immediately contact support with details. We have a dedicated safety team that responds to all concerns urgently.",
  },
];

export default function HelpCentre() {
  const router = useRouter();
  const [searchText, setSearchText] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState("All");

  const categories = ["All", ...new Set(faqData.map((item) => item.category))];

  const filteredFAQ = faqData.filter((item) => {
    const matchesSearch =
      item.question.toLowerCase().includes(searchText.toLowerCase()) ||
      item.answer.toLowerCase().includes(searchText.toLowerCase());
    const matchesCategory = selectedCategory === "All" || item.category === selectedCategory;
    return matchesSearch && matchesCategory;
  });

  const handleContactSupport = () => {
    router.push("/SupportTickets" as any);
  };

  const handleCallSupport = () => {
    Linking.openURL("tel:+919876543210");
  };

  const handleEmailSupport = () => {
    Linking.openURL("mailto:support@kaamwale.com");
  };

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false}>
      {/* Header with Gradient */}
      <LinearGradient
        colors={["#1a2f4d", "#2d5a8c"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.header}
      >
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
        >
          <MaterialIcons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <View style={styles.headerContent}>
          <Text style={styles.headerTitle}>Help Centre</Text>
          <Text style={styles.headerSubtitle}>We're here to help you succeed</Text>
        </View>
      </LinearGradient>

      {/* Quick Support Cards */}
      <View style={styles.quickSupportContainer}>
        <TouchableOpacity style={styles.quickCard} onPress={handleCallSupport}>
          <MaterialIcons name="phone" size={28} color="#fff" />
          <Text style={styles.quickCardText}>Call Us</Text>
          <Text style={styles.quickCardSub}>+91 9876 543210</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.quickCard} onPress={handleEmailSupport}>
          <MaterialIcons name="email" size={28} color="#fff" />
          <Text style={styles.quickCardText}>Email</Text>
          <Text style={styles.quickCardSub}>support@kaamwale.com</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.quickCard} onPress={handleContactSupport}>
          <MaterialIcons name="chat" size={28} color="#fff" />
          <Text style={styles.quickCardText}>Chat</Text>
          <Text style={styles.quickCardSub}>Support Ticket</Text>
        </TouchableOpacity>
      </View>

      {/* Search Bar */}
      <View style={styles.searchContainer}>
        <MaterialIcons name="search" size={22} color="#888" />
        <TextInput
          placeholder="Search FAQs..."
          style={styles.searchInput}
          value={searchText}
          onChangeText={setSearchText}
          placeholderTextColor="#999"
        />
        {searchText !== "" && (
          <TouchableOpacity onPress={() => setSearchText("")}>
            <MaterialIcons name="close" size={22} color="#888" />
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
                onPress={() =>
                  setExpandedId(expandedId === item.id ? null : item.id)
                }
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

        <LinearGradient
          colors={["#667eea", "#764ba2"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.contactButton}
        >
          <TouchableOpacity onPress={handleContactSupport}>
            <View style={styles.contactButtonContent}>
              <MaterialIcons name="support-agent" size={20} color="#fff" />
              <Text style={styles.contactButtonText}>Contact Support</Text>
            </View>
          </TouchableOpacity>
        </LinearGradient>
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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#F8F9FA",
  },
  header: {
    paddingTop: 40,
    paddingBottom: 30,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  backButton: {
    marginRight: 16,
    marginTop: 4,
  },
  headerContent: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
    marginBottom: 6,
  },
  headerSubtitle: {
    fontSize: 14,
    color: "rgba(255,255,255,0.8)",
  },
  quickSupportContainer: {
    flexDirection: "row",
    paddingHorizontal: 16,
    marginTop: -25,
    marginBottom: 20,
    gap: 12,
  },
  quickCard: {
    flex: 1,
    backgroundColor: "#667eea",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
    shadowColor: "#667eea",
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 5,
  },
  quickCardText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#fff",
    marginTop: 8,
  },
  quickCardSub: {
    fontSize: 10,
    color: "rgba(255,255,255,0.7)",
    marginTop: 2,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginBottom: 16,
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  searchInput: {
    flex: 1,
    marginHorizontal: 10,
    fontSize: 16,
    color: "#333",
  },
  categoriesScroll: {
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  categoryBadge: {
    backgroundColor: "#fff",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginRight: 8,
    borderWidth: 1,
    borderColor: "#ddd",
  },
  categoryBadgeActive: {
    backgroundColor: "#1a2f4d",
    borderColor: "#1a2f4d",
  },
  categoryText: {
    fontSize: 13,
    fontWeight: "500",
    color: "#666",
  },
  categoryTextActive: {
    color: "#fff",
  },
  faqContainer: {
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  faqItem: {
    backgroundColor: "#fff",
    borderRadius: 12,
    marginBottom: 12,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 2 },
    shadowRadius: 4,
    elevation: 2,
  },
  faqQuestion: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  questionContent: {
    flex: 1,
    marginRight: 12,
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
    borderTopColor: "#eee",
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
    marginBottom: 20,
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 20,
    alignItems: "center",
  },
  stillNeedHelpTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#1a2f4d",
    marginBottom: 6,
  },
  stillNeedHelpSub: {
    fontSize: 13,
    color: "#666",
    marginBottom: 16,
    textAlign: "center",
  },
  contactButton: {
    width: "100%",
    borderRadius: 12,
    overflow: "hidden",
  },
  contactButtonContent: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    gap: 8,
  },
  contactButtonText: {
    fontSize: 15,
    fontWeight: "600",
    color: "#fff",
  },
  footer: {
    marginHorizontal: 16,
    marginBottom: 20,
    gap: 14,
  },
  footerRow: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    alignItems: "flex-start",
    gap: 12,
  },
  footerText: {
    flex: 1,
  },
  footerLabel: {
    fontSize: 13,
    fontWeight: "600",
    color: "#1a2f4d",
    marginBottom: 2,
  },
  footerValue: {
    fontSize: 12,
    color: "#888",
  },
});
