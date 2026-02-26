// ContractorWalletAttendance.tsx
import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  FlatList,
  ActivityIndicator,
  TextInput,
  Modal,
  Pressable,
  Alert
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
import ReferralModal from "../../../components/ReferralModal";

// Wallet cards data
const walletCards = [
  { id: 1, title: "Wallet Summary", amount: 0, date: "This Week", icon: null },
  { id: 2, title: "Transactions", amount: null, date: "This Week", icon: "account-balance-wallet" },
];

interface Job {
  _id: string; // MongoDB ObjectId
  id?: string; // Legacy - no longer used
  rootJobId?: string;
  workerPhone?: string;
  isBulkWorkerEntry?: boolean;
  title: string;
  description: string;
  amount: number;
  acceptedBy: string;
  acceptedWorkers?: Array<{
    phone?: string;
    name?: string;
    acceptedAt?: string;
    attendanceStatus?: "Present" | "Absent" | null;
    paymentStatus?: "Paid" | null;
    rating?: {
      stars: number;
      feedback: string;
      ratedAt: string;
    };
  }>;
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

type AppModalVariant = "success" | "error" | "info";
type AppModalAction = {
  text: string;
  onPress?: () => void;
  style?: "default" | "cancel" | "destructive";
};

export default function ContractorWalletAttendance() {
  const [activeTab, setActiveTab] = useState<"Wallet" | "Attendance">("Wallet");
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [contractorName, setContractorName] = useState<string>("");
  const [walletBalance, setWalletBalance] = useState<number>(0);
  const [availableBalance, setAvailableBalance] = useState<number>(0);
  const [pocketBalance, setPocketBalance] = useState<number>(0);

  const [depositAmount, setDepositAmount] = useState<string>("");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");

  // NEW UI states
  const [showDepositInput, setShowDepositInput] = useState<boolean>(false);
  const [showWithdrawInput, setShowWithdrawInput] = useState<boolean>(false);
  const [payOptionsTarget, setPayOptionsTarget] = useState<{ jobId: string; workerPhone?: string } | null>(null);

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
  const [currentPaymentWorkerPhone, setCurrentPaymentWorkerPhone] = useState<string | null>(null);

  // ✅ Pagination state for attendance cards
  const [displayedCount, setDisplayedCount] = useState(5); // Show 5 cards initially
  const [walletDisplayedCount] = useState(2);
  const [referralModalVisible, setReferralModalVisible] = useState(false);

  // ✅ Razorpay deposit states
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [depositModalHtml, setDepositModalHtml] = useState("");
  const [currentDepositAmount, setCurrentDepositAmount] = useState(0);
  const [currentDepositOrderId, setCurrentDepositOrderId] = useState("");
  const [depositLoading, setDepositLoading] = useState(false);

  // ✅ Bank account states
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [upiAccount, setUpiAccount] = useState<any>(null);
  const [payoutMethod, setPayoutMethod] = useState<"bank" | "upi">("bank");
  const [showPayoutMethodModal, setShowPayoutMethodModal] = useState(false);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showAddUpi, setShowAddUpi] = useState(false);
  const [showBankInfo, setShowBankInfo] = useState(true);
  const [showUpiInfo, setShowUpiInfo] = useState(true);
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: "",
    accountNumber: "",
    accountNumberConfirm: "",
    ifscCode: "",
    bankName: "",
    accountType: "savings"
  });
  const [upiIdInput, setUpiIdInput] = useState("");

  const showAppModal = (
    _variant: AppModalVariant,
    title: string,
    message: string,
    actions: AppModalAction[] = [{ text: "OK" }]
  ) => {
    Alert.alert(title, message, actions.length ? actions : [{ text: "OK" }]);
  };

  const showAlert = (
    title: string,
    message: string,
    actions: AppModalAction[] = [{ text: "OK" }]
  ) => {
    Alert.alert(title, message, actions.length ? actions : [{ text: "OK" }]);
  };

  const withdrawableBalance = pocketBalance;


  // ✅ Close all modals when wallet tab loses focus (not visible in other tabs)
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        // When this component loses focus, close all modals
        setShowAddBank(false);
        setShowAddUpi(false);
        setShowPayoutMethodModal(false);
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
          fetchUpiAccount();
        }
      } catch (err) {
        console.error('Failed to load user or token', err);
      }
    })();
  }, [accessToken, authUser]);



  // ✅ Memoize fetchJobs to prevent re-creation on every render
  const fetchJobs = React.useCallback(async () => {
    if (!contractorName || !accessToken) return;

    setLoading(true);
    try {
      const res = await api.get(`/jobs`);
      const data: Job[] = res.data;

      const attendanceStatuses = new Set(["offered", "accepted", "in_progress", "completed"]);
      const myJobs = data
        .filter(j => {
          const isMineByPhone = !!authUser?.phone && (j as any).contractorPhone === authUser.phone;
          const isMineByName = !authUser?.phone && j.contractorName === contractorName;
          const hasAnyAcceptedWorker = !!j.acceptedBy || (Array.isArray(j.acceptedWorkers) && j.acceptedWorkers.length > 0);
          return (isMineByPhone || isMineByName) && attendanceStatuses.has(j.status) && hasAnyAcceptedWorker;
        })
        .sort((a, b) => {
          const aTime = new Date((a as any).timestamp || (a as any).updatedAt || (a as any).createdAt || 0).getTime();
          const bTime = new Date((b as any).timestamp || (b as any).updatedAt || (b as any).createdAt || 0).getTime();
          return bTime - aTime;
        });

      console.log(`📥 Fetched ${data.length} total jobs, filtered to ${myJobs.length} attendance jobs for contractor: ${contractorName}`);

      const expandedJobs: Job[] = myJobs.flatMap((j): Job[] => {
        const bulkWorkers = Array.isArray(j.acceptedWorkers) ? j.acceptedWorkers : [];
        if (bulkWorkers.length > 0) {
          return bulkWorkers
            .filter((w) => !!w?.phone)
            .map((w) => ({
              ...j,
              _id: `${j._id}:${w.phone}`,
              rootJobId: j._id,
              acceptedBy: (w.name || w.phone || "").trim(),
              workerPhone: w.phone || undefined,
              isBulkWorkerEntry: true,
              attendanceStatus: w.attendanceStatus ?? null,
              paymentStatus: w.paymentStatus ?? null,
              rating: w.rating ?? undefined,
            }));
        }

        return [
          {
            ...j,
            rootJobId: j._id,
            acceptedBy: (j.acceptedBy || "").trim(),
            workerPhone: j.acceptedBy || undefined,
            isBulkWorkerEntry: false,
            attendanceStatus: j.attendanceStatus || null,
            paymentStatus: j.paymentStatus || null,
          },
        ];
      });

      setJobs(expandedJobs);
    } catch (err) {
      console.error("Job fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [contractorName, accessToken, authUser?.phone]);

  // SOCKET LISTENER FOR REALTIME UPDATES
  useEffect(() => {
    fetchJobs();

    // ✅ Use named handlers for safe cleanup
    const handleJobUpdated = () => fetchJobs();
    const handleWalletUpdated = (data: number | any) => {
      // 🔐 SECURITY: Only update wallet if this event is for the current user
      if (data && typeof data === 'object') {
        // If phone doesn't match current user, ignore the event
        if (data.phone && data.phone !== authUser?.phone) {
          console.warn(`⚠️ Ignoring walletUpdated for different user: ${data.phone} (current: ${authUser?.phone})`);
          return;
        }
        // Safe to update - event is for current user
        setWalletBalance(data.balance);
        setAvailableBalance(Number(data.availableBalance ?? data.balance ?? 0));
        setPocketBalance(Number(data.pocketBalance || 0));
      } else if (typeof data === 'number') {
        setWalletBalance(data);
        setAvailableBalance(data);
      }
    };

    socket.on("jobUpdated", handleJobUpdated);
    socket.on("walletUpdated", handleWalletUpdated);

    return () => {
      // ✅ Remove listeners with handler references (screen-safe cleanup)
      socket.off("jobUpdated", handleJobUpdated);
      socket.off("walletUpdated", handleWalletUpdated);
    };
  }, [fetchJobs, accessToken, authUser?.phone]);

  // Mark attendance
  const markAttendance = async (jobId: string, status: "Present" | "Absent", workerPhone?: string) => {
    try {
      await api.post(`/jobs/attendance/${jobId}`, { status, workerPhone });
      // ✅ DON'T update state optimistically - let backend emit jobUpdated
      // Backend will broadcast updated job with attendanceStatus, triggering fetchJobs
    } catch (err) {
      console.error("Failed to mark attendance:", err);
    }
  };

  const buildPaymentIdempotencyKey = (jobId: string, workerPhone?: string, mode: string = "Cash") => {
    return `pay:${jobId}:${workerPhone || "single"}:${String(mode).toLowerCase()}`;
  };

  // PAY WORKER
  // Pay worker - supports mode: "Cash" | "Online" (keeps existing logic)
  const payWorker = async (jobId: string, mode: string = "Cash", workerPhone?: string) => {
    try {
      const res = await api.post(
        `/jobs/pay/${jobId}`,
        { mode, workerPhone, idempotencyKey: buildPaymentIdempotencyKey(jobId, workerPhone, mode) },
        {
          headers: {
            "X-Idempotency-Key": buildPaymentIdempotencyKey(jobId, workerPhone, mode),
          },
        }
      );
      const data = res.data;

      if (data.success) {
        showAppModal("success", t('success'), t('paymentSuccessful'));
        // Keep UI responsive even if socket update is delayed.
        await fetchJobs();
      } else {
        showAppModal("error", t('error'), data.message || t('paymentFailed'));
      }
    } catch (err) {
      console.error("Payment failed:", err);
      showAppModal("error", t('error'), t('paymentFailed'));
    }
  };

  const handlePayOption = (jobId: string, option: "Cash" | "Online", workerPhone?: string) => {
    setPayOptionsTarget(null);
    if (option === "Cash") {
      // preserve existing cash flow
      payWorker(jobId, "Cash", workerPhone);
    } else {
      // Open Razorpay for online payment
      initiateRazorpayPayment(jobId, workerPhone);
    }
  };

  // ✅ Initiate Razorpay Payment
  const initiateRazorpayPayment = async (jobId: string, workerPhone?: string) => {
    try {
      const job = jobs.find((j) => (j.rootJobId || j._id) === jobId && (!workerPhone || j.workerPhone === workerPhone)) || jobs.find(j => (j.rootJobId || j._id) === jobId);
      if (!job) return showAppModal("error", t('error'), t('jobNotFound'));

      // Step 1: Create order on backend
      const orderRes = await api.post(`/api/payment/create-order`, {
        jobId,
        amount: job.amount,
        workerPhone: workerPhone || job.workerPhone || job.acceptedBy,
        workerName: job.acceptedBy
      });

      if (!orderRes.data.success) {
        return showAppModal("error", t('error'), t('failedCreatePayment'));
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
      setCurrentPaymentWorkerPhone((workerPhone || job.workerPhone || job.acceptedBy || null) as string | null);
      setRazorpayModalVisible(true);
    } catch (error) {
      showAppModal("error", t('error'), t('failedPayment'));
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
        // Fallback sync in case gateway callback reports failure but webhook has already settled.
        await Promise.allSettled([fetchJobs(), fetchWallet()]);
        const settledAsPaid = await checkJobPaidOnServer(currentPaymentJobId, currentPaymentWorkerPhone || undefined);
        if (settledAsPaid) {
          showAppModal("success", t('success'), "Payment was completed successfully. Status has been synced.");
          setCurrentPaymentJobId(null);
          setCurrentPaymentWorkerPhone(null);
          return;
        }
        showAppModal("error", t('error'), data.error || t('paymentCancelled'));
      }
    } catch (error) {
      console.error("Error handling Razorpay response:", error);
    }
  };

  const checkJobPaidOnServer = async (jobId: string | null, workerPhone?: string): Promise<boolean> => {
    if (!jobId) return false;
    try {
      const res = await api.get(`/jobs`);
      const allJobs: any[] = Array.isArray(res?.data) ? res.data : [];
      const job = allJobs.find((j) => String(j?._id) === String(jobId));
      if (!job) return false;

      if (workerPhone && Array.isArray(job.acceptedWorkers) && job.acceptedWorkers.length > 0) {
        const workerEntry = job.acceptedWorkers.find((w: any) => String(w?.phone) === String(workerPhone));
        if (workerEntry) {
          return String(workerEntry?.paymentStatus || '').toLowerCase() === 'paid';
        }
      }

      return String(job?.paymentStatus || '').toLowerCase() === 'paid';
    } catch (err) {
      console.error("Paid-status reconciliation check failed:", err);
      return false;
    }
  };

  // ✅ Verify Razorpay Payment
  const verifyRazorpayPayment = async (data: any) => {
    if (!currentPaymentJobId) return;

    try {
      const job =
        jobs.find((j) => (j.rootJobId || j._id) === currentPaymentJobId && (!currentPaymentWorkerPhone || j.workerPhone === currentPaymentWorkerPhone)) ||
        jobs.find((j) => (j.rootJobId || j._id) === currentPaymentJobId);
      if (!job) return;

      const verifyRes = await api.post(`/api/payment/verify-payment`, {
        orderId: data.orderId,
        paymentId: data.paymentId,
        signature: data.signature,
        jobId: currentPaymentJobId,
        workerPhone: currentPaymentWorkerPhone || job.workerPhone || job.acceptedBy
      });

      const verifyData = verifyRes.data;

      setRazorpayModalVisible(false);

      // Check response success flag
      if (verifyData.success) {
        const successMessage = verifyData?.isDuplicate
          ? 'Payment was already processed. Latest status has been synced.'
          : t('paymentSuccessful') + "! " + t('paymentSuccessful');
        showAppModal("success", t('success'), successMessage);
        // Keep UI responsive even if socket update is delayed.
        await Promise.allSettled([fetchJobs(), fetchWallet()]);
        setCurrentPaymentJobId(null);
        setCurrentPaymentWorkerPhone(null);
      } else {
        const settledAsPaid = await checkJobPaidOnServer(currentPaymentJobId, currentPaymentWorkerPhone || undefined);
        if (settledAsPaid) {
          showAppModal("success", t('success'), "Payment was completed successfully. Status has been synced.");
          await Promise.allSettled([fetchJobs(), fetchWallet()]);
          setCurrentPaymentJobId(null);
          setCurrentPaymentWorkerPhone(null);
          return;
        }
        showAppModal("error", t('error'), verifyData.message || t('paymentFailed'));
      }
    } catch (error) {
      setRazorpayModalVisible(false);
      // Network error can happen even after successful server/webhook processing.
      await Promise.allSettled([fetchJobs(), fetchWallet()]);
      const settledAsPaid = await checkJobPaidOnServer(currentPaymentJobId, currentPaymentWorkerPhone || undefined);
      if (settledAsPaid) {
        showAppModal("success", t('success'), "Payment was completed successfully. Status has been synced.");
        setCurrentPaymentJobId(null);
        setCurrentPaymentWorkerPhone(null);
        return;
      }
      showAppModal("error", t('error'), `${t('paymentFailed')}. If amount was deducted, status will auto-sync shortly.`);
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
      const targetJobId = selectedJobForRating.rootJobId || selectedJobForRating._id;
      const res = await api.post(`/jobs/rate/${targetJobId}`, {
        stars: ratingStars,
        feedback: ratingFeedback,
        workerPhone: selectedJobForRating.workerPhone || selectedJobForRating.acceptedBy,
      });

      const data = res.data;

      if (data.success) {
        showAppModal("success", t('success'), t('ratingSubmitted'));
        setRatingModalVisible(false);
        // ✅ DON'T update state optimistically - let backend emit jobUpdated with rating
        // Backend fetches from DB and broadcasts authoritative job state
      } else {
        showAppModal("error", t('error'), data.message || t('failedSubmitRating'));
      }
    } catch (error) {
      showAppModal("error", t('error'), t('failedSubmitRating'));
      console.error(error);
    } finally {
      setSubmittingRating(false);
    }
  };

  // ✅ Fetch wallet on mount
  const fetchWallet = async (accessTkn?: string) => {
    const tkn = accessTkn || accessToken;
    if (!tkn) return;
    try {
      const res = await api.get(`/wallet`);
      const data = res.data;

      if (data && data.success) {
        const nextAvailable = Number(data.wallet.availableBalance ?? data.wallet.balance ?? 0);
        const nextPocket = Number(data.wallet.pocketBalance || 0);
        setWalletBalance(Number(data.wallet.balance || 0));
        setAvailableBalance(nextAvailable);
        setPocketBalance(nextPocket);
      }
    } catch (err) {
      console.error("Wallet fetch failed:", err);
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

  const fetchUpiAccount = async () => {
    try {
      const res = await api.get(`/wallet/upi`);
      if (res.data.success) {
        setUpiAccount(res.data.upi || null);
      }
    } catch (err) {
      console.error("Error fetching UPI details:", err);
    }
  };

  // ✅ Add/Update bank account
  const handleAddBankAccount = async () => {
    // Validation
    if (!bankDetails.accountHolderName.trim()) {
      showAppModal("error", t('error'), t('enterAccountHolderName'));
      return;
    }

    if (bankDetails.accountNumber.length < 9 || bankDetails.accountNumber.length > 18) {
      showAppModal("error", t('error'), t('invalidAccountNumber'));
      return;
    }

    if (bankDetails.accountNumber !== bankDetails.accountNumberConfirm) {
      showAppModal("error", t('error'), t('accountMismatch'));
      return;
    }

    if (bankDetails.ifscCode.length !== 11) {
      showAppModal("error", t('error'), t('invalidIFSC'));
      return;
    }

    if (!bankDetails.bankName.trim()) {
      showAppModal("error", t('error'), t('enterBankName'));
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
        showAppModal("success", "Success", "Bank account added! Waiting for verification.", [
          {
            text: "OK",
            onPress: () => fetchBankAccount(),
          },
        ]);
      }
    } catch (err: any) {
      showAppModal("error", t('error'), err.response?.data?.message || t('failedAddBank'));
    }
  };

  const handleAddUpiId = async () => {
    const candidate = upiIdInput.trim().toLowerCase();
    const upiRegex = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

    if (!candidate) {
      showAppModal("error", "Error", "Please enter a UPI ID");
      return;
    }
    if (!upiRegex.test(candidate)) {
      showAppModal("error", "Error", "Please enter a valid UPI ID (example: name@bank)");
      return;
    }

    try {
      const res = await api.post(`/wallet/upi/add`, { upiId: candidate });
      if (res.data.success) {
        setUpiAccount(res.data.upi || null);
        setUpiIdInput("");
        setShowAddUpi(false);
        setPayoutMethod("upi");
        setShowUpiInfo(true);
        showAppModal("success", "Success", res.data.message || "UPI ID saved successfully");
      }
    } catch (err: any) {
      showAppModal("error", "Error", err.response?.data?.message || "Failed to save UPI ID");
    }
  };

  // ✅ Confirm Deposit with Razorpay
  const confirmDeposit = async () => {
    if (depositLoading) return; // ✅ Prevent double-submission
    
    if (!depositAmount || Number(depositAmount) <= 0) {
      showAppModal("error", t('error'), t('enterValidAmount'));
      return;
    }
    
    if (Number(depositAmount) < 100) {
      showAppModal("error", t('error'), t('minimumDeposit'));
      return;
    }

    setDepositLoading(true);
    try {
      // Step 1: Create deposit order
      const orderRes = await api.post(`/wallet/deposit/create-order`, {
        amount: Number(depositAmount)
      });

      if (!orderRes.data.success) {
        showAppModal("error", t('error'), t('failedCreateOrder'));
        return;
      }

      // ✅ SECURITY: Get amount from backend response, NOT frontend calculation
      const { orderId, key_id, amount } = orderRes.data;

      // Step 2: Create Razorpay checkout HTML
      // ✅ SECURITY: Use real authenticated user data + amount from backend
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
              "amount": ${amount},
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
                "name": "${authUser?.name || ''}",
                "email": "${authUser?.email || ''}",
                "contact": "${authUser?.phone || ''}"
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
      showAppModal("error", t('error'), err.response?.data?.message || t('failedInitiateDeposit'));
    } finally {
      setDepositLoading(false);
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
        // ✅ Offer retry instead of just closing
        showAlert(
          t('error'),
          data.error || t('depositCancelled'),
          [
            { text: "Close", onPress: () => {} },
            { text: "Try Again", onPress: () => {
              setDepositModalVisible(true);
            }, style: "default" }
          ]
        );
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
        signature: data.signature
      });

      // ✅ Close modal first before any state updates
      setDepositModalVisible(false);
      setDepositModalHtml('');

      if (res.data.success) {
        // ✅ Delay alert to ensure modal is fully closed
        setTimeout(() => {
          showAlert(
            t('success'),
            `₹${currentDepositAmount} deposited successfully!`,
            [{ text: 'OK', onPress: () => {} }]
          );
        }, 300);
        
        setDepositAmount("");
        setShowDepositInput(false);
        // ✅ Fallback: Fetch wallet if socket fails
        await fetchWallet();
      } else {
        // ✅ Offer retry for verification failures
        setTimeout(() => {
          showAlert(
            t('error'),
            res.data.message || 'Deposit verification failed',
            [
              { text: "Close", onPress: () => {} },
              { text: "Retry", onPress: () => verifyDeposit(data), style: "default" }
            ]
          );
        }, 300);
      }
    } catch (err: any) {
      // ✅ Close modal first
      setDepositModalVisible(false);
      setDepositModalHtml('');
      
      const errorMsg = err.response?.data?.message || 'Deposit verification failed';
      
      // ✅ Delay alert to ensure modal is fully closed
      setTimeout(() => {
        showAlert(
          t('error'),
          errorMsg,
          [
            { text: "Close", onPress: () => {  
              // ✅ Even if user closes error, try to fetch wallet as fallback
              fetchWallet();
            } },
            { text: "Retry", onPress: () => verifyDeposit(data), style: "default" }
          ]
        );
      }, 300);
    }
  };

  // ✅ Confirm Withdraw
  const confirmWithdraw = async () => {
    if (!withdrawAmount || Number(withdrawAmount) <= 0) {
      showAlert(t('error'), t('enterValidWithdrawAmount'));
      return;
    }

    if (Number(withdrawAmount) < 100) {
      showAlert(t('error'), t('minimumWithdraw'));
      return;
    }

    if (Number(withdrawAmount) > withdrawableBalance) {
      showAlert("Error", "Insufficient balance");
      return;
    }

    if (payoutMethod === "bank" && !bankAccount) {
      setShowPayoutMethodModal(true);
      return;
    }
    if (payoutMethod === "bank" && bankAccount && !bankAccount.isVerified) {
      showAlert("Bank Verification Pending", `Status: ${bankAccount.verificationStatus || "pending"}`);
      return;
    }

    if (payoutMethod === "upi" && !upiAccount) {
      setShowPayoutMethodModal(true);
      return;
    }
    if (payoutMethod === "upi" && upiAccount && !upiAccount.isVerified) {
      showAlert("UPI Verification Pending", `Status: ${upiAccount.verificationStatus || "pending"}`);
      return;
    }

    try {
      const res = await api.post(`/wallet/withdraw`, {
        amount: Number(withdrawAmount),
        payoutMethod,
      });

      if (res.data.success) {
        // ✅ Server-authoritative: socket.on('walletUpdated') will update balance
        showAlert(t('success'), t('withdrawalInitiated') + "!\n\n" + t('amountTransferred'));
        setWithdrawAmount("");
        setShowWithdrawInput(false);
        
      }
    } catch (err: any) {
      const response = err.response?.data;
      const errorMsg = response?.message || t('withdrawFailed');
      if (response?.requiresBankAccount) {
        setShowPayoutMethodModal(true);
        return;
      }
      if (response?.requiresUpi) {
        setShowPayoutMethodModal(true);
        return;
      }
      showAlert(t('error'), errorMsg);
    }
  };

  // ✅ Memoize renderJob to stabilize FlatList rendering
  const renderJob = React.useCallback(
    ({ item }: { item: Job }) => (
    <View style={styles.attendanceCard}>
      <Text style={styles.jobTitle}>{item.title}</Text>
      <Text style={styles.jobDescription}>{item.description}</Text>
      <Text style={styles.jobAmount}>Amount: ₹{item.amount}</Text>
      <Text style={styles.workerName}>Worker: {item.acceptedBy}</Text>

      {item.attendanceStatus === null ? (
        <View style={styles.attendanceButtons}>
          <TouchableOpacity
            style={[styles.presentButton, { backgroundColor: "#2ecc71" }]}
            onPress={() => markAttendance(item.rootJobId || item._id, "Present", item.workerPhone)}
          >
            <Text style={styles.buttonText}>Present</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.absentButton, { backgroundColor: "#e74c3c" }]}
            onPress={() => markAttendance(item.rootJobId || item._id, "Absent", item.workerPhone)}
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
              onPress={() => setPayOptionsTarget({ jobId: item.rootJobId || item._id, workerPhone: item.workerPhone })}
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
    ),
    [markAttendance, setPayOptionsTarget, handleOpenRatingModal]
  );

  // ✅ Reset pagination when jobs data changes
  useEffect(() => {
    setDisplayedCount(5);
  }, [jobs]);

  useEffect(() => {
    if (upiAccount?.isVerified) {
      setPayoutMethod("upi");
      return;
    }
    if (bankAccount) {
      setPayoutMethod("bank");
    }
  }, [bankAccount, upiAccount]);

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#f5f5f5",
        paddingTop: 40,
        paddingBottom: 8,
      }}
    >
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
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingBottom: 16 }}
        >
          <View style={styles.balanceContainer}>
            <Text style={styles.balanceTitle}>Pocket Balance</Text>
            <Text style={styles.balanceAmount}>₹{pocketBalance}</Text>
          </View>

          {/* Deposit + Withdraw Buttons in one line */}
          <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 15 }}>
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: "#1a2f4d", flex: 1, marginRight: 5, opacity: depositLoading ? 0.6 : 1 }]}
              onPress={() => {
                setShowDepositInput(!showDepositInput);
                setShowWithdrawInput(false);
              }}
              disabled={depositLoading}
            >
              <Text style={styles.buttonText}>Deposit</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: "#2ecc71", flex: 1, marginLeft: 5 }]}
              onPress={() => {
                if (!bankAccount && !upiAccount) {
                  setShowPayoutMethodModal(true);
                  return;
                }
                setShowWithdrawInput(!showWithdrawInput);
                setShowDepositInput(false);
              }}
            >
              <Text style={styles.buttonText}>Withdraw</Text>
            </TouchableOpacity>
          </View>

          {/* Conditional Input Fields */}
          {showDepositInput && (
            <View>
              <View style={styles.buttonRow}>
                <TextInput
                  placeholder="Enter deposit amount"
                  style={styles.input}
                  value={depositAmount}
                  onChangeText={setDepositAmount}
                  keyboardType="numeric"
                  editable={!depositLoading}
                />
                <TouchableOpacity
                  style={[styles.actionButton, { backgroundColor: "#1a2f4d", opacity: depositLoading ? 0.6 : 1 }]}
                  onPress={confirmDeposit}
                  disabled={depositLoading}
                >
                  <Text style={styles.buttonText}>{depositLoading ? "Processing..." : "Submit"}</Text>
                </TouchableOpacity>
              </View>
              {/* ✅ Deposit Summary UI */}
              {depositAmount && Number(depositAmount) > 0 && (
                <View style={{ marginTop: 12, padding: 12, backgroundColor: "#f0f8ff", borderRadius: 8, borderLeftWidth: 4, borderLeftColor: "#1a2f4d" }}>
                  <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>Deposit Summary</Text>
                  <Text style={{ fontSize: 14, fontWeight: "600", color: "#1a2f4d" }}>You will deposit: ₹{Number(depositAmount)}</Text>
                  <Text style={{ fontSize: 11, color: "#999", marginTop: 6 }}>Minimum: ₹100 | No hidden charges</Text>
                </View>
              )}
            </View>
          )}

          {showWithdrawInput && (
            <View>
              <TouchableOpacity
                style={{
                  marginHorizontal: 16,
                  marginBottom: 10,
                  paddingVertical: 10,
                  paddingHorizontal: 12,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: "#d1d5db",
                  backgroundColor: "#fff",
                  flexDirection: "row",
                  justifyContent: "space-between",
                  alignItems: "center",
                }}
                onPress={() => setShowPayoutMethodModal(true)}
              >
                <Text style={{ color: "#111827", fontWeight: "600" }}>
                  Payout Method: {payoutMethod === "bank" ? "Bank Account" : "UPI"}
                </Text>
                <Text style={{ color: "#1a2f4d", fontWeight: "700" }}>Change</Text>
              </TouchableOpacity>
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
            </View>
          )}

          <TouchableOpacity
            style={{
              marginHorizontal: 16,
              marginTop: 12,
              marginBottom: 12,
              backgroundColor: "#6C63FF",
              borderRadius: 10,
              paddingVertical: 14,
              paddingHorizontal: 14,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
            onPress={() => setReferralModalVisible(true)}
          >
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              <MaterialIcons name="card-giftcard" size={20} color="#fff" />
              <Text style={{ color: "#fff", fontSize: 15, fontWeight: "700", marginLeft: 10 }}>
                Refer & Earn
              </Text>
            </View>
            <MaterialIcons name="arrow-forward" size={20} color="#fff" />
          </TouchableOpacity>

          {/* Cards */}
          <View style={styles.cardsRow}>
            {walletCards.slice(0, walletDisplayedCount).map(card => (
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
                contentContainerStyle={{ paddingBottom: 16 }}
                initialNumToRender={5}
                maxToRenderPerBatch={5}
                windowSize={5}
                removeClippedSubviews={true}
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

      {/* ✅ Razorpay Deposit Modal with Security */}
      <Modal visible={depositModalVisible} transparent animationType="slide" onDismiss={() => {
        // ✅ Handle manual close/cancel - clear HTML and fallback fetch
        setDepositModalVisible(false);
        setDepositModalHtml('');
        // ✅ Fallback wallet sync in case socket missed update
        fetchWallet();
      }}>
        <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 12, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#DDD" }}>
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>Wallet Deposit</Text>
            <TouchableOpacity onPress={() => {
              setDepositModalVisible(false);
              setDepositModalHtml('');
              showAlert(
                "Deposit in Progress?",
                "If you just completed payment, it may take a moment to process. Don't close the app.",
                [{ text: "OK", onPress: () => {
                  // ✅ Fallback fetch wallet in case socket failed
                  fetchWallet();
                } }]
              );
            }}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          {depositModalHtml ? (
            <WebView
              source={{ html: depositModalHtml }}
              onMessage={handleDepositMessage}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              startInLoadingState={true}
              originWhitelist={['*']}
              onShouldStartLoadWithRequest={(request) => {
                // ✅ SECURITY: Only allow Razorpay checkout domain
                const isRazorpayURL = request.url.startsWith('https://checkout.razorpay.com') ||
                                      request.url.startsWith('https://api.razorpay.com') ||
                                      request.url.startsWith('data:');
                if (!isRazorpayURL) {
                  console.warn(`⚠️ Blocked navigation to: ${request.url}`);
                }
                return isRazorpayURL;
              }}
            />
          ) : (
            <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
              <ActivityIndicator size="large" color="#1a2f4d" />
              <Text style={{ marginTop: 12, color: "#666" }}>Loading payment gateway...</Text>
            </View>
          )}
        </SafeAreaView>
      </Modal>

      {/* Payout Method Selection Modal */}
      <Modal visible={showPayoutMethodModal && activeTab === "Wallet"} transparent animationType="fade">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0,0,0,0.4)" }}>
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => setShowPayoutMethodModal(false)}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
          />
          <View style={{ width: "90%", backgroundColor: "#fff", borderRadius: 12, padding: 16 }}>
            <Text style={{ fontSize: 16, fontWeight: "700", color: "#111827", marginBottom: 12 }}>
              Select Payout Method
            </Text>

            <TouchableOpacity
              style={{
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: payoutMethod === "bank" ? "#1a2f4d" : "#e5e7eb",
                marginBottom: 8,
              }}
              onPress={() => {
                setPayoutMethod("bank");
                setShowPayoutMethodModal(false);
                if (!bankAccount) setShowAddBank(true);
              }}
            >
              <Text style={{ fontWeight: "700", color: "#111827" }}>Bank Account</Text>
              <Text style={{ color: "#6b7280", marginTop: 2 }}>
                {bankAccount?.maskedAccount
                  ? `Linked: ${bankAccount.maskedAccount}${bankAccount?.isVerified ? " (Verified)" : " (Pending)"}`
                  : "No bank account linked"}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{
                padding: 12,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: payoutMethod === "upi" ? "#1a2f4d" : "#e5e7eb",
              }}
              onPress={() => {
                setPayoutMethod("upi");
                setShowPayoutMethodModal(false);
                if (!upiAccount) setShowAddUpi(true);
              }}
            >
              <Text style={{ fontWeight: "700", color: "#111827" }}>UPI ID</Text>
              <Text style={{ color: "#6b7280", marginTop: 2 }}>
                {upiAccount?.maskedUpiId
                  ? `Linked: ${upiAccount.maskedUpiId}${upiAccount?.isVerified ? " (Verified)" : " (Pending)"}`
                  : "No UPI ID linked"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* UPI Modal */}
      <Modal visible={showAddUpi && activeTab === "Wallet"} transparent animationType="slide">
        <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#EEE" }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: "#333" }}>Add UPI ID</Text>
            <TouchableOpacity onPress={() => setShowAddUpi(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>UPI ID *</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 8, fontSize: 14 }}
              placeholder="example@bank"
              autoCapitalize="none"
              autoCorrect={false}
              value={upiIdInput}
              onChangeText={setUpiIdInput}
            />
            <Text style={{ fontSize: 12, color: "#666", marginBottom: 18 }}>
              Withdrawals will be sent to this UPI ID.
            </Text>
            <TouchableOpacity
              style={{ backgroundColor: "#1a2f4d", padding: 14, borderRadius: 8, alignItems: "center" }}
              onPress={handleAddUpiId}
            >
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>Save UPI ID</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>

      {/* ✅ Bank Account Modal */}
      {/* ✅ Bank Account Modal - Only visible in Wallet tab */}
      <Modal visible={showAddBank && activeTab === "Wallet"} transparent animationType="slide">
        <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: "#fff" }}>
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

      {upiAccount && showUpiInfo && (
        <View style={{ padding: 16, backgroundColor: "#f5f3ff", marginTop: 10, marginHorizontal: 16, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: "#6d28d9" }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333" }}>UPI Payout</Text>
            <TouchableOpacity onPress={() => setShowUpiInfo(false)}>
              <MaterialIcons name="close" size={20} color="#333" />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{upiAccount.maskedUpiId}</Text>
          <Text style={{ fontSize: 11, color: upiAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {upiAccount.isVerified ? "✅ Verified" : `⏳ ${upiAccount.verificationStatus}`}
          </Text>
          <View style={{ marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end' }}>
            <TouchableOpacity onPress={() => setShowAddUpi(true)}>
              <Text style={{ color: "#6d28d9", fontWeight: "600" }}>Change</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ✅ Pay Options Modal - Moved outside FlatList for safety & performance */}
      <Modal visible={payOptionsTarget !== null} transparent animationType="fade">
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }}>
          {/* Backdrop - closes when tapped outside modal */}
          <TouchableOpacity
            activeOpacity={1}
            onPress={() => setPayOptionsTarget(null)}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
          />

          <View style={{ width: '90%', backgroundColor: '#fff', borderRadius: 12, padding: 18, elevation: 6 }}>
            <Text style={{ fontWeight: '700', fontSize: 16, marginBottom: 12 }}>Choose payment method</Text>

            <TouchableOpacity
              style={{ padding: 12, borderRadius: 8, backgroundColor: '#f3f4f6', marginBottom: 8 }}
              onPress={() => payOptionsTarget && handlePayOption(payOptionsTarget.jobId, 'Cash', payOptionsTarget.workerPhone)}
            >
              <Text style={{ fontWeight: '600' }}>Pay via Cash</Text>
              <Text style={{ color: '#666', marginTop: 4 }}>Worker will be paid cash on site</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ padding: 12, borderRadius: 8, backgroundColor: '#e6f7ff' }}
              onPress={() => payOptionsTarget && handlePayOption(payOptionsTarget.jobId, 'Online', payOptionsTarget.workerPhone)}
            >
              <Text style={{ fontWeight: '600' }}>Pay via Online</Text>
              <Text style={{ color: '#666', marginTop: 4 }}>Use online wallet / UPI</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <ReferralModal
        visible={referralModalVisible}
        onClose={() => setReferralModalVisible(false)}
        workerName={contractorName || "Contractor"}
        workerPhone={authUser?.phone || ""}
      />
    </View>
  );
}


