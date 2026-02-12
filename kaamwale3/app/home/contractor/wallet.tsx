// ContractorWalletAttendance.tsx
import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  Alert,
  TextInput,
  Modal,
  Pressable
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { MaterialIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import axios from "axios";
import { useFocusEffect } from "@react-navigation/native"; // ✅ ADDED for closing modals on tab blur
import { SERVER_URL, API_BASE } from "../../../utils/config";
import styles from "../../../styles/ContractorWalletStyles";
import { socket } from "../../../utils/socket";
import { useLanguage } from "../../../context/LanguageContext";
import { useAuth } from "../../../context/AuthContext";
import api from "../../../utils/api";

// Wallet cards data
const walletCards = [
  { id: 1, title: "Payout", amount: 0, date: "3 Nov - 9 Nov", icon: null },
  { id: 2, title: "Deductions", amount: null, date: "3 Nov - 9 Nov", icon: "attach-money" },
  { id: 3, title: "Payout", amount: 0, date: "3 Nov - 9 Nov", icon: "payments" },
  { id: 4, title: "Payout", amount: null, date: "3 Nov - 9 Nov", icon: "account-balance-wallet" },
];

interface Job {
  _id: string; // MongoDB ObjectId
  id?: string; // Legacy - no longer used
  title: string;
  description: string;
  amount: number;
  acceptedBy?: string;
  contractorName: string;
  status: string;
  timestamp: string;
  attendanceStatus?: "Present" | "Absent" | null;
  paymentStatus?: "Paid" | null;
  rating?: {
    stars: number;
    feedback: string;
    ratedAt: string;
  };
}

export default function ContractorWalletAttendance() {
  const [activeTab, setActiveTab] = useState<"Wallet" | "Attendance">("Wallet");
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [contractorName, setContractorName] = useState<string>("");
  const [walletBalance, setWalletBalance] = useState<number>(0);

  const [depositAmount, setDepositAmount] = useState<string>("");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");

  // NEW UI states
  const [showDepositInput, setShowDepositInput] = useState<boolean>(false);
  const [showWithdrawInput, setShowWithdrawInput] = useState<boolean>(false);
  const [payOptionsJobId, setPayOptionsJobId] = useState<string | null>(null);

  // Rating states
  const [ratingModalVisible, setRatingModalVisible] = useState(false);
  const [selectedJobForRating, setSelectedJobForRating] = useState<Job | null>(null);
  const [ratingStars, setRatingStars] = useState(5);
  const [ratingFeedback, setRatingFeedback] = useState("");
  const [submittingRating, setSubmittingRating] = useState(false);

  // ✅ Razorpay payment states
  const [razorpayModalVisible, setRazorpayModalVisible] = useState(false);
  const [razorpayHtml, setRazorpayHtml] = useState("");
  const [currentPaymentJobId, setCurrentPaymentJobId] = useState<string | null>(null);

  // ✅ Pagination state for attendance cards
  const [displayedCount, setDisplayedCount] = useState(5); // Show 5 cards initially

  // ✅ Razorpay deposit states
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [depositModalHtml, setDepositModalHtml] = useState("");
  const [currentDepositAmount, setCurrentDepositAmount] = useState(0);
  const [currentDepositOrderId, setCurrentDepositOrderId] = useState("");

  // ✅ Bank account states
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showBankInfo, setShowBankInfo] = useState(true);
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: "",
    accountNumber: "",
    accountNumberConfirm: "",
    ifscCode: "",
    bankName: "",
    accountType: "savings"
  });

  // ✅ Close all modals when wallet tab loses focus (not visible in other tabs)
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        // When this component loses focus, close all modals
        setShowAddBank(false);
        setShowDepositInput(false);
        setShowWithdrawInput(false);
        setDepositModalVisible(false);
        setRazorpayModalVisible(false);
        setRatingModalVisible(false);
        console.log('✅ Contractor wallet modals closed (tab unfocused)');
      };
    }, [])
  );

  // Load contractor name & token from AuthContext (migrated from AsyncStorage)
  useEffect(() => {
    (async () => {
      try {
        const userStr = authUser ? JSON.stringify(authUser) : null;

        if (userStr) {
          const user = JSON.parse(userStr);
          if (user?.name) setContractorName(user.name);
        }

        if (accessToken) {
          fetchWallet(accessToken);
          fetchBankAccount();
        }
      } catch (err) {
        console.error('Failed to load user or token', err);
      }
    })();
  }, [accessToken, authUser]);

  // Fetch Jobs
  const fetchJobs = async () => {
    if (!contractorName || !accessToken) return;

    setLoading(true);
    try {
      const res = await api.get(`/jobs`);
      const data: Job[] = res.data;

      const myJobs = data
        .filter(j => j.contractorName === contractorName && j.status === "accepted")
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      console.log(`📥 Fetched ${data.length} total jobs, filtered to ${myJobs.length} accepted jobs for contractor: ${contractorName}`);

      setJobs(
        myJobs.map(j => ({
          ...j,
          attendanceStatus: j.attendanceStatus || null,
          paymentStatus: j.paymentStatus || null,
        }))
      );
    } catch (err) {
      console.error("Job fetch error:", err);
    } finally {
      setLoading(false);
    }
  };

  // SOCKET LISTENER FOR REALTIME UPDATES
  useEffect(() => {
    fetchJobs();

    socket.on("jobUpdated", fetchJobs);
    // ✅ Handle both number (from old emit) and object (from new emit)
    socket.on("walletUpdated", (data: number | any) => {
      if (typeof data === 'number') {
        setWalletBalance(data);
      } else if (data && typeof data === 'object' && data.balance) {
        // If it's an object with balance property, extract it
        setWalletBalance(data.balance);
      }
    });

    return () => {
      socket.off("jobUpdated", fetchJobs);
      socket.off("walletUpdated");
    };
  }, [contractorName, accessToken]);

  // Mark attendance
  const markAttendance = async (jobId: string, status: "Present" | "Absent") => {
    try {
      await api.post(`/jobs/attendance/${jobId}`, { status });

      setJobs(prev => prev.map(job => (job._id === jobId ? { ...job, attendanceStatus: status } : job)));
      socket.emit("jobUpdated");
    } catch (err) {
      console.error("Failed to mark attendance:", err);
    }
  };

  // PAY WORKER
  // Pay worker - supports mode: "Cash" | "Online" (keeps existing logic)
  const payWorker = async (jobId: string, mode: string = "Cash") => {
    try {
      const res = await api.post(`/jobs/pay/${jobId}`, { mode });
      const data = res.data;

      if (data.success) {
        Alert.alert(t('success'), t('paymentSuccessful'));
        setJobs(prev => prev.map(job => (job._id === jobId ? { ...job, paymentStatus: "Paid" } : job)));
        socket.emit("jobUpdated");
        socket.emit("walletUpdated", walletBalance);
      } else {
        Alert.alert(t('error'), data.message || t('paymentFailed'));
      }
    } catch (err) {
      console.error("Payment failed:", err);
    }
  };

  const handlePayOption = (jobId: string, option: "Cash" | "Online") => {
    setPayOptionsJobId(null);
    if (option === "Cash") {
      // preserve existing cash flow
      payWorker(jobId, "Cash");
    } else {
      // Open Razorpay for online payment
      initiateRazorpayPayment(jobId);
    }
  };

  // ✅ Initiate Razorpay Payment
  const initiateRazorpayPayment = async (jobId: string) => {
    try {
      const job = jobs.find(j => j._id === jobId);
      if (!job) return Alert.alert(t('error'), t('jobNotFound'));

      // Step 1: Create order on backend
      const orderRes = await api.post(`/api/payment/create-order`, {
        jobId: job._id,
        amount: job.amount,
        workerPhone: job.acceptedBy,
        workerName: job.acceptedBy
      });

      if (!orderRes.data.success) {
        return Alert.alert(t('error'), t('failedCreatePayment'));
      }

      // Step 2: Create Razorpay checkout HTML
      const razorpayHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
          <style>
            body { margin: 0; padding: 0; background: #f5f5f5; }
            #checkout-container { display: flex; justify-content: center; align-items: center; height: 100vh; }
          </style>
        </head>
        <body>
          <div id="checkout-container">
            <p>Opening Razorpay Checkout...</p>
          </div>
          <script>
            var options = {
              "key": "${orderRes.data.key_id}",
              "amount": ${orderRes.data.amount},
              "currency": "INR",
              "name": "Kaamwale",
              "description": "Payment for job: ${job.title}",
              "order_id": "${orderRes.data.orderId}",
              "handler": function (response){
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'payment_success',
                  paymentId: response.razorpay_payment_id,
                  orderId: response.razorpay_order_id,
                  signature: response.razorpay_signature
                }));
              },
              "prefill": {
                "name": "Test",
                "email": "test@example.com",
                "contact": "9999999999"
              },
              "theme": {
                "color": "#1a2f4d"
              }
            };
            var rzp1 = new Razorpay(options);
            rzp1.open();
            
            rzp1.on('payment.failed', function (response){
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'payment_failed',
                error: response.error.description
              }));
            });
          </script>
        </body>
        </html>
      `;

      setRazorpayHtml(razorpayHtml);
      setCurrentPaymentJobId(jobId);
      setRazorpayModalVisible(true);
    } catch (error) {
      Alert.alert(t('error'), t('failedPayment'));
      console.error("Payment initiation failed:", error);
    }
  };

  // ✅ Handle Razorpay WebView messages
  const handleRazorpayMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'payment_success') {
        await verifyRazorpayPayment(data);
      } else if (data.type === 'payment_failed') {
        setRazorpayModalVisible(false);
        Alert.alert(t('error'), data.error || t('paymentCancelled'));
      }
    } catch (error) {
      console.error("Error handling Razorpay response:", error);
    }
  };

  // ✅ Verify Razorpay Payment
  const verifyRazorpayPayment = async (data: any) => {
    if (!currentPaymentJobId) return;

    try {
      const job = jobs.find(j => j._id === currentPaymentJobId);
      if (!job) return;

      const verifyRes = await api.post(`/api/payment/verify-payment`, {
        orderId: data.orderId,
        paymentId: data.paymentId,
        signature: data.signature,
        jobId: job._id,
        amount: job.amount,
        workerPhone: job.acceptedBy
      });

      const verifyData = verifyRes.data;

      setRazorpayModalVisible(false);

      // Check response success flag
      if (verifyData.success) {
        Alert.alert(t('success'), t('paymentSuccessful') + "! " + t('paymentSuccessful'));
        setJobs(prev => prev.map(j => (j._id === currentPaymentJobId ? { ...j, paymentStatus: "Paid" } : j)));
        
        // ✅ Emit events to notify worker
        const job = jobs.find(j => j._id === currentPaymentJobId);
        if (job) {
          socket.emit("walletRefresh", { phone: job.acceptedBy, amount: job.amount });
          socket.emit("notificationRefresh", { phone: job.acceptedBy });
        }
        
        socket.emit("jobUpdated");
        socket.emit("walletUpdated", walletBalance);
        setCurrentPaymentJobId(null);
      } else {
        Alert.alert(t('error'), verifyData.message || t('paymentFailed'));
      }
    } catch (error) {
      setRazorpayModalVisible(false);
      Alert.alert(t('error'), t('paymentFailed'));
      console.error("Verification error:", error);
    }
  };

  const handleOpenRatingModal = (job: Job) => {
    setSelectedJobForRating(job);
    setRatingStars(5);
    setRatingFeedback("");
    setRatingModalVisible(true);
  };

  const handleSubmitRating = async () => {
    if (!selectedJobForRating || !accessToken) return;

    setSubmittingRating(true);
    try {
      const res = await api.post(`/jobs/rate/${selectedJobForRating._id}`, {
        stars: ratingStars,
        feedback: ratingFeedback,
      });

      const data = res.data;

      if (data.success) {
        Alert.alert(t('success'), t('ratingSubmitted'));
        setRatingModalVisible(false);
        // Update the job in state to reflect the rating
        setJobs(prev => prev.map(job => 
          job._id === selectedJobForRating._id 
            ? { ...job, rating: { stars: ratingStars, feedback: ratingFeedback, ratedAt: new Date().toISOString() } } 
            : job
        ));
      } else {
        Alert.alert(t('error'), data.message || t('failedSubmitRating'));
      }
    } catch (error) {
      Alert.alert(t('error'), t('failedSubmitRating'));
      console.error(error);
    } finally {
      setSubmittingRating(false);
    }
  };

  // WALLET
  const fetchWallet = async (accessTkn?: string) => {
    const tkn = accessTkn || accessToken;
    if (!tkn) return;
    try {
      const res = await api.get(`/wallet`);
      const data = res.data;

      if (data && data.success) {
        setWalletBalance(data.wallet.balance);
        socket.emit("walletUpdated", data.wallet.balance);
      }
    } catch (err) {
      console.error("Wallet fetch failed:", err);
    }
  };

  // DEPOSIT
  const handleDeposit = async () => {
    const amt = Number(depositAmount);
    if (!amt || amt <= 0) return Alert.alert(t('error'), t('enterValidDeposit'));

    try {
      const res = await api.post(`/wallet/deposit`, { amount: amt });
      const data = res.data;

      if (data && data.success) {
        Alert.alert(t('success'), t('depositSuccessful'));
        setWalletBalance(data.wallet.balance);
        setDepositAmount("");
        setShowDepositInput(false);
        socket.emit("walletUpdated", data.wallet.balance);
      }
    } catch (err) {
      Alert.alert(t('error'), t('depositFailed'));
    }
  };

  // WITHDRAW
  const handleWithdraw = async () => {
    const amt = Number(withdrawAmount);
    if (!amt || amt <= 0) return Alert.alert(t('error'), t('enterValidWithdraw'));
    if (amt > walletBalance) return Alert.alert(t('error'), t('insufficientBalance'));

    try {
      const res = await api.post(`/wallet/withdraw`, { amount: amt });
      const data = res.data;

      if (data && data.success) {
        Alert.alert(t('success'), t('withdrawSuccessful'));
        setWalletBalance(data.wallet.balance);
        setWithdrawAmount("");
        setShowWithdrawInput(false);
        socket.emit("walletUpdated", data.wallet.balance);
      }
    } catch (err) {
      Alert.alert(t('error'), t('withdrawFailed'));
    }
  };

  // ✅ Fetch bank account
  const fetchBankAccount = async () => {
    try {
      const res = await api.get(`/wallet/bank-account`);

      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
      }
    } catch (err) {
      console.error("Error fetching bank account:", err);
    }
  };

  // ✅ Add/Update bank account
  const handleAddBankAccount = async () => {
    // Validation
    if (!bankDetails.accountHolderName.trim()) {
      Alert.alert(t('error'), t('enterAccountHolderName'));
      return;
    }

    if (bankDetails.accountNumber.length < 9 || bankDetails.accountNumber.length > 18) {
      Alert.alert(t('error'), t('invalidAccountNumber'));
      return;
    }

    if (bankDetails.accountNumber !== bankDetails.accountNumberConfirm) {
      Alert.alert(t('error'), t('accountMismatch'));
      return;
    }

    if (bankDetails.ifscCode.length !== 11) {
      Alert.alert(t('error'), t('invalidIFSC'));
      return;
    }

    if (!bankDetails.bankName.trim()) {
      Alert.alert(t('error'), t('enterBankName'));
      return;
    }

    try {
      const res = await api.post(`/wallet/bank-account/add`, bankDetails);

      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
        setBankDetails({
          accountHolderName: "",
          accountNumber: "",
          accountNumberConfirm: "",
          ifscCode: "",
          bankName: "",
          accountType: "savings"
        });
        setShowAddBank(false);
        setShowBankInfo(true);
        // Show success message with custom modal instead of Alert
        Alert.alert(
          "✅ Success",
          "Bank account added! Waiting for verification.",
          [
            {
              text: "OK",
              onPress: () => {
                fetchBankAccount();
              },
            },
          ],
          { cancelable: false }
        );
      }
    } catch (err: any) {
      Alert.alert(t('error'), err.response?.data?.message || t('failedAddBank'));
    }
  };

  // ✅ Confirm Deposit with Razorpay
  const confirmDeposit = async () => {
    if (!depositAmount || Number(depositAmount) <= 0) {
      Alert.alert(t('error'), t('enterValidAmount'));
      return;
    }
    
    if (Number(depositAmount) < 100) {
      Alert.alert(t('error'), t('minimumDeposit'));
      return;
    }

    try {
      // Step 1: Create deposit order
      const orderRes = await api.post(`/wallet/deposit/create-order`, {
        amount: Number(depositAmount)
      });

      if (!orderRes.data.success) {
        Alert.alert(t('error'), t('failedCreateOrder'));
        return;
      }

      const { orderId, key_id } = orderRes.data;

      // Step 2: Create Razorpay checkout HTML
      const razorpayHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
          <style>
            body { margin: 0; padding: 0; background: #f5f5f5; }
            #checkout-container { display: flex; justify-content: center; align-items: center; height: 100vh; }
          </style>
        </head>
        <body>
          <div id="checkout-container">
            <p>Opening Razorpay Checkout...</p>
          </div>
          <script>
            var options = {
              "key": "${key_id}",
              "amount": ${Number(depositAmount) * 100},
              "currency": "INR",
              "name": "Kaamwale Wallet",
              "description": "Wallet Deposit",
              "order_id": "${orderId}",
              "handler": function (response){
                window.ReactNativeWebView.postMessage(JSON.stringify({
                  type: 'deposit_success',
                  paymentId: response.razorpay_payment_id,
                  orderId: response.razorpay_order_id,
                  signature: response.razorpay_signature
                }));
              },
              "prefill": {
                "name": "User",
                "email": "user@example.com",
                "contact": "9999999999"
              },
              "theme": {
                "color": "#1a2f4d"
              }
            };
            var rzp1 = new Razorpay(options);
            rzp1.open();
            
            rzp1.on('payment.failed', function (response){
              window.ReactNativeWebView.postMessage(JSON.stringify({
                type: 'deposit_failed',
                error: response.error.description
              }));
            });
          </script>
        </body>
        </html>
      `;

      setDepositModalHtml(razorpayHtml);
      setDepositModalVisible(true);
      setCurrentDepositAmount(Number(depositAmount));
      setCurrentDepositOrderId(orderId);
    } catch (err: any) {
      Alert.alert(t('error'), err.response?.data?.message || t('failedInitiateDeposit'));
    }
  };

  // Handle Razorpay deposit response
  const handleDepositMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === "deposit_success") {
        // Verify deposit on backend
        await verifyDeposit(data);
      } else if (data.type === "deposit_failed") {
        setDepositModalVisible(false);
        Alert.alert(t('error'), data.error || t('depositCancelled'));
      }
    } catch (error) {
      console.error("Error handling deposit response:", error);
    }
  };

  // Verify deposit payment
  const verifyDeposit = async (data: any) => {
    try {
      const res = await api.post(`/wallet/deposit/verify`, {
        orderId: data.orderId,
        paymentId: data.paymentId,
        signature: data.signature,
        amount: currentDepositAmount
      });

      setDepositModalVisible(false);

      if (res.data.success) {
        setWalletBalance(res.data.walletBalance);
        Alert.alert(t('success'), `₹${currentDepositAmount} ` + t('deposited'));
        setDepositAmount("");
        setShowDepositInput(false);
        
        // Refresh wallet
        if (accessToken) fetchWallet(accessToken);
      } else {
        Alert.alert(t('error'), res.data.message || t('depositVerificationFailed'));
      }
    } catch (err: any) {
      setDepositModalVisible(false);
      Alert.alert(t('error'), err.response?.data?.message || t('depositVerificationFailed'));
    }
  };

  // ✅ Confirm Withdraw
  const confirmWithdraw = async () => {
    if (!withdrawAmount || Number(withdrawAmount) <= 0) {
      Alert.alert(t('error'), t('enterValidWithdrawAmount'));
      return;
    }

    if (Number(withdrawAmount) < 100) {
      Alert.alert(t('error'), t('minimumWithdraw'));
      return;
    }

    if (Number(withdrawAmount) > walletBalance) {
      Alert.alert("Error", "Insufficient balance");
      return;
    }

    // Check if bank account is linked
    if (!bankAccount) {
      Alert.alert(
        "Bank Account Required",
        "Please add your bank account details before withdrawing",
        [
          { text: "Cancel", onPress: () => {} },
          { text: "Add Bank Account", onPress: () => setShowAddBank(true) }
        ]
      );
      return;
    }

    try {
      const res = await api.post(`/wallet/withdraw`, {
        amount: Number(withdrawAmount)
      });

      if (res.data.success) {
        setWalletBalance(res.data.walletBalance);
        Alert.alert(t('success'), t('withdrawalInitiated') + "!\n\n" + t('amountTransferred'));
        setWithdrawAmount("");
        setShowWithdrawInput(false);
        
        // Refresh wallet
        if (accessToken) fetchWallet(accessToken);
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || t('withdrawFailed');
      Alert.alert(t('error'), errorMsg);
    }
  };

  // Render job card
  const renderJob = ({ item }: { item: Job }) => (
    <View style={styles.attendanceCard}>
      <Text style={styles.jobTitle}>{item.title}</Text>
      <Text style={styles.jobDescription}>{item.description}</Text>
      <Text style={styles.jobAmount}>Amount: ₹{item.amount}</Text>
      <Text style={styles.workerName}>Worker: {item.acceptedBy}</Text>

      {item.attendanceStatus === null ? (
        <View style={styles.attendanceButtons}>
          <TouchableOpacity
            style={[styles.presentButton, { backgroundColor: "#2ecc71" }]}
            onPress={() => markAttendance(item._id, "Present")}
          >
            <Text style={styles.buttonText}>Present</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.absentButton, { backgroundColor: "#e74c3c" }]}
            onPress={() => markAttendance(item._id, "Absent")}
          >
            <Text style={styles.buttonText}>Absent</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          <Text
            style={{
              marginTop: 8,
              fontWeight: "700",
              color: item.attendanceStatus === "Present" ? "#2ecc71" : "#e74c3c",
            }}
          >
          {/* Pay options modal (centered) */}
          <Modal visible={payOptionsJobId !== null} transparent animationType="fade">
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }}>
              {/* Backdrop - closes when tapped outside modal */}
              <TouchableOpacity
                activeOpacity={1}
                onPress={() => setPayOptionsJobId(null)}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              />

              <View style={{ width: '90%', backgroundColor: '#fff', borderRadius: 12, padding: 18, elevation: 6 }}>
                <Text style={{ fontWeight: '700', fontSize: 16, marginBottom: 12 }}>Choose payment method</Text>

                <TouchableOpacity
                  style={{ padding: 12, borderRadius: 8, backgroundColor: '#f3f4f6', marginBottom: 8 }}
                  onPress={() => payOptionsJobId && handlePayOption(payOptionsJobId, 'Cash')}
                >
                  <Text style={{ fontWeight: '600' }}>Pay via Cash</Text>
                  <Text style={{ color: '#666', marginTop: 4 }}>Worker will be paid cash on site</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{ padding: 12, borderRadius: 8, backgroundColor: '#e6f7ff' }}
                  onPress={() => payOptionsJobId && handlePayOption(payOptionsJobId, 'Online')}
                >
                  <Text style={{ fontWeight: '600' }}>Pay via Online</Text>
                  <Text style={{ color: '#666', marginTop: 4 }}>Use online wallet / UPI</Text>
                </TouchableOpacity>
              </View>
            </View>
          </Modal>
            {item.attendanceStatus}
          </Text>

          {item.attendanceStatus === "Present" && item.paymentStatus !== "Paid" && (
            <TouchableOpacity
              style={{
                marginTop: 15,
                backgroundColor: "#1a2f4d",
                padding: 12,
                borderRadius: 8,
              }}
              onPress={() => setPayOptionsJobId(item._id)}
            >
              <Text style={{ color: "#fff", fontWeight: "600", textAlign: "center" }}>
                Pay Now
              </Text>
            </TouchableOpacity>
          )}

          {item.paymentStatus === "Paid" && !item.rating && (
            <TouchableOpacity
              style={{
                marginTop: 15,
                backgroundColor: "#FF9500",
                padding: 12,
                borderRadius: 8,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              onPress={() => handleOpenRatingModal(item)}
            >
              <MaterialIcons name="star-outline" size={18} color="#fff" />
              <Text style={{ color: "#fff", fontWeight: "600", textAlign: "center" }}>
                Rate Worker
              </Text>
            </TouchableOpacity>
          )}

          {item.rating && (
            <View
              style={{
                marginTop: 15,
                backgroundColor: "#ebeff6c4",
                borderLeftWidth: 4,
                borderLeftColor: "#FF9500",
                padding: 12,
                borderRadius: 6,
              }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: "#333" }}>Your Rating:</Text>
                <Text style={{ fontSize: 16 }}>{"⭐".repeat(item.rating.stars)}</Text>
              </View>
              {item.rating.feedback && (
                <Text style={{ fontSize: 12, color: "#666", fontStyle: "italic" }}>"{item.rating.feedback}"</Text>
              )}
            </View>
          )}
        </>
      )}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: "#f5f5f5", paddingTop: 40 }}>
      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "Wallet" && styles.activeTab]}
          onPress={() => setActiveTab("Wallet")}
        >
          <Text style={styles.tabText}>Wallet</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === "Attendance" && styles.activeTab]}
          onPress={() => setActiveTab("Attendance")}
        >
          <Text style={styles.tabText}>Attendance</Text>
        </TouchableOpacity>
      </View>

      {/* Wallet Tab */}
      {activeTab === "Wallet" && (
        <ScrollView style={{ flex: 1 }}>
          <View style={styles.balanceContainer}>
            <Text style={styles.balanceTitle}>Pocket Balance</Text>
            <Text style={styles.balanceAmount}>₹{walletBalance}</Text>
          </View>

          {/* Deposit + Withdraw Buttons in one line */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 15 }}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: "#1a2f4d", flex: 1, marginRight: 5 }]}
              onPress={() => {
                setShowDepositInput(!showDepositInput);
                setShowWithdrawInput(false);
              }}
            >
              <Text style={styles.buttonText}>Deposit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: "#2ecc71", flex: 1, marginLeft: 5 }]}
              onPress={() => {
                setShowWithdrawInput(!showWithdrawInput);
                setShowDepositInput(false);
              }}
            >
              <Text style={styles.buttonText}>Withdraw</Text>
            </TouchableOpacity>
          </View>

          {/* Conditional Input Fields */}
          {showDepositInput && (
            <View style={styles.buttonRow}>
              <TextInput
                placeholder="Enter deposit amount"
                style={styles.input}
                value={depositAmount}
                onChangeText={setDepositAmount}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: "#1a2f4d" }]}
                onPress={confirmDeposit}
              >
                <Text style={styles.buttonText}>Submit</Text>
              </TouchableOpacity>
            </View>
          )}

          {showWithdrawInput && (
            <View style={styles.buttonRow}>
              <TextInput
                placeholder="Enter withdraw amount"
                style={styles.input}
                value={withdrawAmount}
                onChangeText={setWithdrawAmount}
                keyboardType="numeric"
              />
              <TouchableOpacity
                style={[styles.actionButton, { backgroundColor: "#2ecc71" }]}
                onPress={confirmWithdraw}
              >
                <Text style={styles.buttonText}>Submit</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Cards */}
          <View style={styles.cardsRow}>
            {walletCards.map(card => (
              <TouchableOpacity
                key={card.id}
                style={styles.cardContainer}
                onPress={() => console.log("Card clicked", card.title)}
              >
                {card.amount !== null ? (
                  <Text style={styles.cardAmount}>₹{card.amount}</Text>
                ) : (
                  <MaterialIcons name={card.icon as any} size={28} color="#1a2f4d" />
                )}
                <Text style={styles.cardTitle}>{card.title}</Text>
                <Text style={styles.cardDate}>{card.date}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>
      )}

      {/* Attendance Tab */}
      {activeTab === "Attendance" && (
        <>
          {loading ? (
            <ActivityIndicator size="large" color="#1a2f4d" style={{ marginTop: 20 }} />
          ) : (
            <View style={{ flex: 1 }}>
              <FlatList
                data={jobs.slice(0, displayedCount)} // ✅ Show only up to displayedCount
                keyExtractor={item => item._id.toString()}
                renderItem={renderJob}
                contentContainerStyle={{ paddingBottom: 20 }}
              />
              
              {/* ✅ See More Button - Show only if there are more items */}
              {displayedCount < jobs.length && (
                <TouchableOpacity
                  style={{ 
                    marginHorizontal: 16, 
                    marginBottom: 20, 
                    paddingVertical: 12, 
                    backgroundColor: '#1a2f4d', 
                    borderRadius: 8, 
                    alignItems: 'center' 
                  }}
                  onPress={() => setDisplayedCount(prev => prev + 5)} // ✅ Load 5 more cards
                >
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>See More</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </>
      )}

      {/* Rating Modal */}
      <Modal visible={ratingModalVisible} animationType="slide" transparent>
        <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" }}>
          <View style={{ backgroundColor: "#fff", borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 30 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16, paddingTop: 20, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: "#F0F0F0" }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: "#1A1A1A" }}>Rate {selectedJobForRating?.acceptedBy}</Text>
              <TouchableOpacity onPress={() => setRatingModalVisible(false)}>
                <MaterialIcons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#666", marginBottom: 16 }}>Job: {selectedJobForRating?.title}</Text>

              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 10 }}>Your Rating:</Text>
                <View style={{ flexDirection: "row", gap: 10 }}>
                  {[1, 2, 3, 4, 5].map((star) => (
                    <TouchableOpacity
                      key={star}
                      onPress={() => setRatingStars(star)}
                      style={{ padding: 8 }}
                    >
                      <Text style={{ fontSize: 32 }}>
                        {star <= ratingStars ? "⭐" : "☆"}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Feedback (Optional):</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, fontSize: 14, color: "#333", minHeight: 80, textAlignVertical: "top", marginBottom: 20 }}
                placeholder="Share your feedback about this worker..."
                placeholderTextColor="#999"
                multiline
                maxLength={200}
                value={ratingFeedback}
                onChangeText={setRatingFeedback}
              />

              <View style={{ flexDirection: "row", gap: 12 }}>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: "#F0F0F0", alignItems: "center" }}
                  onPress={() => setRatingModalVisible(false)}
                >
                  <Text style={{ color: "#666", fontSize: 14, fontWeight: "600" }}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: "#FF9500", alignItems: "center" }}
                  onPress={handleSubmitRating}
                  disabled={submittingRating}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                    {submittingRating ? "Submitting..." : "Submit Rating"}
                  </Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* ✅ Razorpay Payment Modal */}
      <Modal visible={razorpayModalVisible} transparent animationType="slide">
        <View style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: "#DDD" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>Payment</Text>
            <TouchableOpacity onPress={() => setRazorpayModalVisible(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          {razorpayHtml ? (
            <WebView
              source={{ html: razorpayHtml }}
              onMessage={handleRazorpayMessage}
              javaScriptEnabled={true}
              domStorageEnabled={true}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <ActivityIndicator size="large" color="#1a2f4d" />
              <Text style={{ marginTop: 12, color: "#666" }}>Loading payment...</Text>
            </View>
          )}
        </View>
      </Modal>

      {/* ✅ Razorpay Deposit Modal */}
      <Modal visible={depositModalVisible} transparent animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#DDD" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>Wallet Deposit</Text>
            <TouchableOpacity onPress={() => setDepositModalVisible(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          {depositModalHtml ? (
            <WebView
              source={{ html: depositModalHtml }}
              onMessage={handleDepositMessage}
              javaScriptEnabled={true}
              domStorageEnabled={true}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <Text>Loading...</Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* ✅ Bank Account Modal */}
      {/* ✅ Bank Account Modal - Only visible in Wallet tab */}
      <Modal visible={showAddBank && activeTab === "Wallet"} transparent animationType="slide">
        <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
          <ScrollView style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#EEE" }}>
              <Text style={{ fontSize: 18, fontWeight: "700", color: "#333" }}>Add Bank Account</Text>
              <TouchableOpacity onPress={() => setShowAddBank(false)}>
                <MaterialIcons name="close" size={28} color="#333" />
              </TouchableOpacity>
            </View>

            <View style={{ padding: 16 }}>
              {/* Account Holder Name */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Account Holder Name *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder="Full name as per bank"
                value={bankDetails.accountHolderName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountHolderName: val })}
              />

              {/* Bank Name */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Bank Name *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder="e.g., ICICI Bank, HDFC Bank"
                value={bankDetails.bankName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, bankName: val })}
              />

              {/* Account Type */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Account Type *</Text>
              <View style={{ flexDirection: 'row', marginBottom: 16 }}>
                <TouchableOpacity
                  style={{
                    flex: 1,
                    padding: 12,
                    borderWidth: 2,
                    borderColor: bankDetails.accountType === 'savings' ? '#1a2f4d' : '#DDD',
                    borderRadius: 8,
                    marginRight: 8,
                    alignItems: 'center'
                  }}
                  onPress={() => setBankDetails({ ...bankDetails, accountType: 'savings' })}
                >
                  <Text style={{ fontWeight: bankDetails.accountType === 'savings' ? '700' : '600', color: bankDetails.accountType === 'savings' ? '#1a2f4d' : '#666' }}>Savings</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={{
                    flex: 1,
                    padding: 12,
                    borderWidth: 2,
                    borderColor: bankDetails.accountType === 'current' ? '#1a2f4d' : '#DDD',
                    borderRadius: 8,
                    alignItems: 'center'
                  }}
                  onPress={() => setBankDetails({ ...bankDetails, accountType: 'current' })}
                >
                  <Text style={{ fontWeight: bankDetails.accountType === 'current' ? '700' : '600', color: bankDetails.accountType === 'current' ? '#1a2f4d' : '#666' }}>Current</Text>
                </TouchableOpacity>
              </View>

              {/* Account Number */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Account Number *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder="Enter account number"
                keyboardType="number-pad"
                value={bankDetails.accountNumber}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumber: val })}
              />

              {/* Confirm Account Number */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>Confirm Account Number *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder="Re-enter account number"
                keyboardType="number-pad"
                value={bankDetails.accountNumberConfirm}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumberConfirm: val })}
              />

              {/* IFSC Code */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>IFSC Code *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 24, fontSize: 14 }}
                placeholder="e.g., ICIC0000001"
                maxLength={11}
                value={bankDetails.ifscCode}
                onChangeText={(val) => setBankDetails({ ...bankDetails, ifscCode: val.toUpperCase() })}
              />

              {/* Submit Button */}
              <TouchableOpacity
                style={{ backgroundColor: "#1a2f4d", padding: 16, borderRadius: 8, alignItems: 'center', marginBottom: 32 }}
                onPress={handleAddBankAccount}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>Save Bank Account</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* ✅ Bank Account Info Display */}
      {bankAccount && showBankInfo && (
        <View style={{ padding: 16, backgroundColor: "#f0f8ff", marginTop: 16, marginHorizontal: 16, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: "#1a2f4d" }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333" }}>💳 Linked Bank Account</Text>
            <TouchableOpacity onPress={() => setShowBankInfo(false)}>
              <MaterialIcons name="close" size={20} color="#333" />
            </TouchableOpacity>
          </View>

          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.bankName}</Text>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.maskedAccount}</Text>
          <Text style={{ fontSize: 11, color: bankAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {bankAccount.isVerified ? "✅ Verified" : `⏳ ${bankAccount.verificationStatus}`} 
          </Text>

          <View style={{ marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={() => setShowAddBank(true)}>
              <Text style={{ color: "#1a2f4d", fontWeight: "600" }}>Change</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}
