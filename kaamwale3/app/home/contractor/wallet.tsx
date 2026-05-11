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
  Alert,
  Image,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";
import { MaterialIcons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import axios from "axios";
import { useFocusEffect, useIsFocused } from "@react-navigation/native"; // ✅ ADDED for closing modals on tab blur
import { SERVER_URL, API_BASE } from "../../../utils/config";
import styles from "../../../styles/ContractorWalletStyles";
import { socket } from "../../../utils/socket";
import { useLanguage } from "../../../context/LanguageContext";
import { useAuth } from "../../../context/AuthContext";
import api from "../../../utils/api";
import ReferralModal from "../../../components/ReferralModal";
import { useWalletBalance } from "../../../hooks/useWalletBalance"; // ✅ Smart caching hook

// Wallet cards data
const walletCards = [
  { id: 1, titleKey: "walletSummary", amount: 0, dateKey: "thisWeek", icon: null },
  { id: 2, titleKey: "transactions", amount: null, dateKey: "thisWeek", icon: "account-balance-wallet" },
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
  workerName?: string;
  profilePhoto?: string;
  mainSkill?: string;
  acceptedWorkers?: Array<{
    phone?: string;
    name?: string;
    acceptedAt?: string;
    attendanceStatus?: "Present" | "Absent" | null;
    paymentStatus?: "paid" | null;
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
  paymentStatus?: "paid" | null;
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
  const isFocused = useIsFocused();
  const [activeTab, setActiveTab] = useState<"Wallet" | "Attendance">("Wallet");
  const { t } = useLanguage();
  const { accessToken, user: authUser } = useAuth();
  const { balance: walletBalance, refresh: refreshWallet, loading: walletLoading } = useWalletBalance();
  const [jobs, setJobs] = useState<Job[]>([]);

  const fetchWallet = async () => {
    await refreshWallet();
  };
  const [loading, setLoading] = useState(true);
  const [contractorName, setContractorName] = useState<string>("");
  const [availableBalance, setAvailableBalance] = useState<number>(0);
  const [pocketBalance, setPocketBalance] = useState<number>(0);

  useEffect(() => {
    if (typeof walletBalance === "number") {
      setPocketBalance(walletBalance);
    }
  }, [walletBalance]);

  const [depositAmount, setDepositAmount] = useState<string>("");
  const [withdrawAmount, setWithdrawAmount] = useState<string>("");

  // NEW UI states
  const [showDepositInput, setShowDepositInput] = useState<boolean>(false);
  const [showWithdrawInput, setShowWithdrawInput] = useState<boolean>(false);
  const [recentWithdrawal, setRecentWithdrawal] = useState<any>(null);
  const [withdrawStatus, setWithdrawStatus] = useState<any>(null);
  const [withdrawBlockedMessage, setWithdrawBlockedMessage] = useState<string>('');
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
          // ✅ Wallet balance now auto-fetched by useWalletBalance hook
          fetchBankAccount();
          fetchUpiAccount();
        }
      } catch (err) {
        console.error('Failed to load user or token', err);
      }
    })();
  }, [accessToken, authUser]);

  const formatDateTime = (date: Date) => {
    return date.toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getWithdrawBlockInfo = () => {
    if (!recentWithdrawal) {
      return { isBlocked: false, message: '' };
    }

    if (String(recentWithdrawal.status || '').toLowerCase() !== 'success') {
      return {
        isBlocked: true,
        message: 'Please wait until your previous withdrawal is completed before requesting a new one.',
      };
    }

    const lastCreated = new Date(recentWithdrawal.createdAt || recentWithdrawal.updatedAt || recentWithdrawal.created_at || 0);
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (lastCreated >= oneWeekAgo) {
      const nextAvailable = new Date(lastCreated.getTime() + 7 * 24 * 60 * 60 * 1000);
      return {
        isBlocked: true,
        message: `Only one withdrawal is allowed per week. Next withdrawal available after ${formatDateTime(nextAvailable)}.`,
      };
    }

    return { isBlocked: false, message: '' };
  };

  const fetchRecentWithdrawal = async () => {
    if (!accessToken) return;

    try {
      const res = await api.get('/wallet/withdraw/status');
      if (res.data?.success) {
        setRecentWithdrawal(res.data.recentWithdrawal || null);
        setWithdrawStatus(res.data.withdrawStatus || null);
      }
    } catch (err) {
      console.error('Failed to load recent withdrawal:', err);
    }
  };

  useEffect(() => {
    if (accessToken) {
      fetchRecentWithdrawal();
    }
  }, [accessToken]);

  useEffect(() => {
    const blockInfo = withdrawStatus?.blocked
      ? { message: withdrawStatus.message }
      : getWithdrawBlockInfo();
    setWithdrawBlockedMessage(blockInfo.message);
  }, [recentWithdrawal, withdrawStatus]);


  // ✅ Memoize fetchJobs to prevent re-creation on every render
  const fetchJobs = React.useCallback(async () => {
    if (!accessToken) return;
    // Allow fetching jobs for real-time updates even when not on Attendance tab
    if (!isFocused) return;

    setLoading(true);
    try {
      const res = await api.get(`/jobs`);
      const raw = res.data;
      const data: Job[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.jobs)
        ? raw.jobs
        : Array.isArray(raw?.data)
        ? raw.data
        : Array.isArray(raw?.gigs)
        ? raw.gigs
        : [];
      console.log("RAW JOB RESPONSE:", raw);
      console.log("NORMALIZED JOB ARRAY:", data.length);

      const resolveWorkerPhone = (worker: any): string => {
        if (!worker) return "";
        if (typeof worker === "string") return worker.trim();
        return String(worker.phone || worker.workerPhone || worker.acceptedBy || "").trim();
      };

      const myJobs = data
        .filter(j => {
          const hasBulkAccepted = Array.isArray(j.acceptedWorkers) && j.acceptedWorkers.some((w: any) => !!resolveWorkerPhone(w));
          const hasAnyAcceptedWorker = !!String(j.acceptedBy || "").trim() || hasBulkAccepted;
          const isCancelled =
            String(j.status || "").toLowerCase() === "cancelled" || (j as any).isCancelled === true;
          return hasAnyAcceptedWorker && !isCancelled;
        })
        .sort((a, b) => {
          const aTime = new Date((a as any).timestamp || (a as any).updatedAt || (a as any).createdAt || 0).getTime();
          const bTime = new Date((b as any).timestamp || (b as any).updatedAt || (b as any).createdAt || 0).getTime();
          return bTime - aTime;
        });

      console.log(`📥 Fetched ${data.length} total jobs, filtered to ${myJobs.length} attendance jobs`);

      const expandedJobs: Job[] = myJobs.flatMap((j): Job[] => {
        const bulkWorkers = Array.isArray(j.acceptedWorkers) ? j.acceptedWorkers : [];
        const normalizedBulkWorkers = bulkWorkers
          .map((w: any) => (typeof w === "string" ? { phone: w, name: w } : (w || {})))
          .map((w: any) => {
            const workerPhone = resolveWorkerPhone(w);
            return {
              ...w,
              phone: workerPhone,
              name: String(w.name || workerPhone || "").trim(),
            };
          })
          .filter((w: any) => !!w.phone);

        if (normalizedBulkWorkers.length > 0) {
          return bulkWorkers
            .map((w: any) => (typeof w === "string" ? { phone: w, name: w } : (w || {})))
            .map((w: any) => {
              const workerPhone = resolveWorkerPhone(w);
              return {
                ...w,
                phone: workerPhone,
                name: String(w.name || workerPhone || "").trim(),
              };
            })
            .filter((w: any) => !!w.phone)
            .map((w) => ({
              ...j,
              _id: `${j._id}:${w.phone}`,
              rootJobId: j._id,
              acceptedBy: (w.name || w.phone || "").trim(),
              workerName: String(w.name || "").trim() || undefined,
              workerPhone: w.phone || undefined,
              isBulkWorkerEntry: true,
              attendanceStatus: w.attendanceStatus ?? null,
              paymentStatus: w.paymentStatus ?? null,
              rating: w.rating ?? undefined,
            }));
        }

        const singleWorkerName = (
          Array.isArray(j.acceptedWorkers) && j.acceptedWorkers[0]
            ? String((j.acceptedWorkers[0] as any).name || (j.acceptedWorkers[0] as any).workerName || "").trim()
            : ""
        ) || String((j as any).acceptedWorker?.name || (j as any).workerName || j.acceptedBy || "").trim();

        return [
          {
            ...j,
            rootJobId: j._id,
            acceptedBy: singleWorkerName || (j.acceptedBy || "").trim(),
            workerName: singleWorkerName || undefined,
            workerPhone: j.acceptedBy || undefined,
            isBulkWorkerEntry: false,
            attendanceStatus: j.attendanceStatus || null,
            paymentStatus: j.paymentStatus || null,
          },
        ];
      });
      console.log(`🧩 Expanded attendance cards: ${expandedJobs.length}`);

      setJobs(expandedJobs);
    } catch (err) {
      console.error("Job fetch error:", err);
    } finally {
      setLoading(false);
    }
  }, [accessToken, activeTab, authUser?.phone, isFocused]);

  // SOCKET LISTENER FOR REALTIME UPDATES
  useEffect(() => {
    if (!isFocused) return;

    // ✅ Use named handlers for safe cleanup
    const handleJobUpdated = () => {
      if (isFocused) fetchJobs();
    };
    const handleJobAccepted = () => {
      if (isFocused) fetchJobs();
    };
    const handleJobCancelled = () => {
      if (isFocused) fetchJobs();
    };
    
    // ✅ Handle cash payment real-time updates
    const handleCashPaymentCreated = (data: any) => {
      if (isFocused) {
        console.log("Cash payment created notification received:", data);
        fetchJobs();
      }
    };
    
    const handleCashDepositCreated = (data: any) => {
      if (isFocused) {
        console.log("Cash deposit created notification received:", data);
        fetchJobs();
      }
    };

    socket.on("jobUpdated", handleJobUpdated);
    socket.on("jobAccepted", handleJobAccepted);
    socket.on("jobCancelled", handleJobCancelled);
    socket.on("cashPaymentCreated", handleCashPaymentCreated);
    socket.on("cashDepositCreated", handleCashDepositCreated);
    // ✅ walletUpdated now handled by useWalletBalance hook

    return () => {
      // ✅ Remove listeners with handler references (screen-safe cleanup)
      socket.off("jobUpdated", handleJobUpdated);
      socket.off("jobAccepted", handleJobAccepted);
      socket.off("jobCancelled", handleJobCancelled);
      socket.off("cashPaymentCreated", handleCashPaymentCreated);
      socket.off("cashDepositCreated", handleCashDepositCreated);
    };
  }, [fetchJobs, isFocused]);

  // Refresh attendance list whenever user opens the Attendance tab.
  useEffect(() => {
    if (activeTab === "Attendance" && isFocused) {
      fetchJobs();
    }
  }, [activeTab, fetchJobs, isFocused]);

  // Refresh on screen focus as fallback when socket event is missed.
  useFocusEffect(
    React.useCallback(() => {
      // Always fetch jobs when screen becomes focused for real-time updates
      if (isFocused) {
        fetchJobs();
      }
      return () => {};
    }, [fetchJobs, isFocused])
  );

  // Mark attendance
  const [attendanceSubmitting, setAttendanceSubmitting] = useState<Record<string, boolean>>({});

  const markAttendance = async (jobId: string, status: "Present" | "Absent", workerPhone?: string) => {
    if (!jobId) {
      console.warn('Skipping attendance mark: missing jobId');
      return;
    }
    if (attendanceSubmitting[jobId]) return;

    try {
      setAttendanceSubmitting((prev) => ({ ...prev, [jobId]: true }));
      await api.post(`/jobs/attendance/${jobId}`, { status, workerPhone });
      // ✅ DON'T update state optimistically - let backend emit jobUpdated
      // Backend will broadcast updated job with attendanceStatus, triggering fetchJobs
    } catch (err) {
      console.error("Failed to mark attendance:", err);
    } finally {
      setAttendanceSubmitting((prev) => ({ ...prev, [jobId]: false }));
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
        console.error("Payment error response:", data.message);
        showAppModal("error", t('error'), data.message || t('paymentFailed'));
        // Even on error, refresh jobs in case payment actually succeeded but response failed
        await fetchJobs();
      }
    } catch (err: any) {
      console.error("Payment failed:", err?.response?.data || err?.message || err);
      const errorMsg = err?.response?.data?.message || err?.message || t('paymentFailed');
      showAppModal("error", t('error'), errorMsg);
      // Even on network error, refresh jobs in case payment actually succeeded
      await fetchJobs();
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
        await Promise.allSettled([fetchJobs(), refreshWallet()]);
        const settledAsPaid = await checkJobPaidOnServer(currentPaymentJobId, currentPaymentWorkerPhone || undefined);
        if (settledAsPaid) {
          showAppModal("success", t('success'), t('paymentSyncedSuccessfully'));
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
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const qs = workerPhone ? `?workerPhone=${encodeURIComponent(workerPhone)}` : "";
        const statusRes = await api.get(`/api/payment/payment-status/${jobId}${qs}`);
        if (statusRes?.data?.success && statusRes?.data?.isPaid) {
          return true;
        }
        // webhook may settle milliseconds after callback failure; short backoff avoids false "failed" modal.
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
      }
      return false;
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
          ? 'Deposit already processed successfully.'
          : `${t('paymentSuccessful')}!`;
        showAppModal("success", t('success'), successMessage);
        // Keep UI responsive even if socket update is delayed.
        await Promise.allSettled([fetchJobs(), fetchWallet()]);
        setCurrentPaymentJobId(null);
        setCurrentPaymentWorkerPhone(null);
      } else {
        const settledAsPaid = await checkJobPaidOnServer(currentPaymentJobId, currentPaymentWorkerPhone || undefined);
        if (settledAsPaid) {
          showAppModal("success", t('success'), t('paymentSyncedSuccessfully'));
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
        showAppModal("success", t('success'), t('paymentSyncedSuccessfully'));
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
        // Even on error, refresh jobs in case rating actually succeeded but response failed
        await fetchJobs();
      }
    } catch (error) {
      // Even on network error, refresh jobs in case rating actually succeeded
      await fetchJobs();
      showAppModal("error", t('error'), t('failedSubmitRating'));
      console.error(error);
    } finally {
      setSubmittingRating(false);
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
        showAppModal("success", t('success'), t('bankAddedWaitingVerification'), [
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
      showAppModal("error", t('error'), t('enterUpiId'));
      return;
    }
    if (!upiRegex.test(candidate)) {
      showAppModal("error", t('error'), t('enterValidUpiId'));
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
        showAppModal("success", t('success'), res.data.message || t('upiSavedSuccessfully'));
      }
    } catch (err: any) {
      showAppModal("error", t('error'), err.response?.data?.message || t('failedSaveUpiId'));
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
    if (withdrawStatus?.blocked) {
      showAlert(t('error'), withdrawStatus.message || 'Withdrawal is temporarily unavailable.');
      return;
    }

    const blockInfo = getWithdrawBlockInfo();
    if (blockInfo.isBlocked) {
      showAlert(t('error'), blockInfo.message || 'Withdrawal is temporarily unavailable.');
      return;
    }

    if (!withdrawAmount || Number(withdrawAmount) <= 0) {
      showAlert(t('error'), t('enterValidWithdrawAmount'));
      return;
    }

    if (Number(withdrawAmount) < 100) {
      showAlert(t('error'), t('minimumWithdraw'));
      return;
    }

    if (Number(withdrawAmount) > withdrawableBalance) {
      showAlert(t('error'), t('insufficientBalance'));
      return;
    }

    if (payoutMethod === "bank" && !bankAccount) {
      setShowPayoutMethodModal(true);
      return;
    }
    if (payoutMethod === "bank" && bankAccount && !bankAccount.isVerified) {
      showAlert(t('bankVerificationPending'), `${t('status')}: ${bankAccount.verificationStatus || t('pending')}`);
      return;
    }

    if (payoutMethod === "upi" && !upiAccount) {
      setShowPayoutMethodModal(true);
      return;
    }
    if (payoutMethod === "upi" && upiAccount && !upiAccount.isVerified) {
      showAlert(t('upiVerificationPending'), `${t('status')}: ${upiAccount.verificationStatus || t('pending')}`);
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
        await fetchRecentWithdrawal();
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
    ({ item }: { item: Job }) => {
      const skillLabel = item.mainSkill || item.description;
      const titleAndSkill = [item.title, skillLabel]
        .filter(Boolean)
        .join(' · ') || 'Job';

      const showDescription = Boolean(
        item.description &&
        item.title &&
        item.description !== skillLabel &&
        item.description !== item.title
      );

      return (
        <View style={styles.attendanceCard}>
          <View style={styles.workerHeader}>
            <View style={styles.workerProfileRow}>
              {item.profilePhoto ? (
                <Image source={{ uri: item.profilePhoto }} style={styles.workerAvatar} />
              ) : (
                <Image source={require("../../../assets/avatar1.png")} style={styles.workerAvatar} />
              )}
              <View style={styles.workerIdentityText}>
                <Text style={styles.workerName}>{item.workerName || item.acceptedBy || 'Worker'}</Text>
                <Text style={styles.jobTitleSmall}>{titleAndSkill}</Text>
              </View>
            </View>

            {item.attendanceStatus ? (
          <View style={[
            styles.statusBadge,
            item.attendanceStatus === 'Present' ? styles.statusBadgePresent : styles.statusBadgeAbsent,
          ]}>
            <Text style={styles.statusBadgeText}>{item.attendanceStatus.toUpperCase()}</Text>
          </View>
        ) : null}
      </View>
      {showDescription ? <Text style={styles.jobDescription}>{item.description}</Text> : null}
      <Text style={styles.jobAmount}>Amount: ₹{item.amount}</Text>

      {item.attendanceStatus === null ? (
        <View style={styles.attendanceButtons}>
          <TouchableOpacity
            style={[
              styles.presentButton,
              { backgroundColor: "#2ecc71", opacity: attendanceSubmitting[item._id] ? 0.6 : 1 },
            ]}
            onPress={() => markAttendance(item.rootJobId || item._id, "Present", item.workerPhone)}
            disabled={attendanceSubmitting[item._id]}
          >
            <Text style={styles.buttonText}>{attendanceSubmitting[item._id] ? 'Marking...' : 'Present'}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[
              styles.absentButton,
              { backgroundColor: "#e74c3c", opacity: attendanceSubmitting[item._id] ? 0.6 : 1 },
            ]}
            onPress={() => markAttendance(item.rootJobId || item._id, "Absent", item.workerPhone)}
            disabled={attendanceSubmitting[item._id]}
          >
            <Text style={styles.buttonText}>{attendanceSubmitting[item._id] ? 'Please wait' : 'Absent'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
          {item.attendanceStatus === "Present" && item.paymentStatus !== "paid" && (
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

          {item.paymentStatus === "paid" && !item.rating && (
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
                <Text style={{ fontSize: 12, color: "#666", fontStyle: "italic" }}>{"\""}{item.rating.feedback}{"\""}</Text>
              )}
            </View>
          )}
        </>
      )}
    </View>
      );
    },
    [markAttendance, setPayOptionsTarget, handleOpenRatingModal, attendanceSubmitting]
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
        backgroundColor: "#F4F6F8",
        paddingTop: 32,
        paddingBottom: 8,
      }}
    >
      {/* Tabs */}
      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabButton, activeTab === "Wallet" && styles.activeTab]}
          onPress={() => setActiveTab("Wallet")}
        >
          <Text style={[styles.tabText, activeTab === "Wallet" && styles.activeTabText]}>{t('wallet')}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tabButton, activeTab === "Attendance" && styles.activeTab]}
          onPress={() => setActiveTab("Attendance")}
        >
          <Text style={[styles.tabText, activeTab === "Attendance" && styles.activeTabText]}>{t('attendance')}</Text>
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
                onPress={() => {
                  if (payoutMethod === "upi" && upiAccount) {
                    setShowAddUpi(true);
                    return;
                  }
                  setShowPayoutMethodModal(true);
                }}
              >
                <Text style={{ color: "#111827", fontWeight: "600" }}>
                  Payout Method: {payoutMethod === "bank" ? "Bank Account" : "UPI"}
                </Text>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {payoutMethod === "upi" && upiAccount ? (
                    <MaterialIcons name="edit" size={20} color="#1a2f4d" />
                  ) : null}
                  <Text style={{ color: "#1a2f4d", fontWeight: "700", marginLeft: 6 }}>
                    {payoutMethod === "upi" && upiAccount ? "Edit" : "Change"}
                  </Text>
                </View>
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
              {recentWithdrawal && (
                <View style={{ marginHorizontal: 16, marginTop: 12, backgroundColor: "#fff7e6", borderRadius: 10, padding: 12, borderWidth: 1, borderColor: "#f5c260" }}>
                  <Text style={{ fontSize: 13, fontWeight: "700", color: "#7a4b00", marginBottom: 4 }}>Recent Withdrawal</Text>
                  <Text style={{ fontSize: 13, color: "#4a2d00" }}>
                    Amount: ₹{recentWithdrawal.amount || recentWithdrawal.withdrawAmount || "--"}
                  </Text>
                  <Text style={{ fontSize: 13, color: "#4a2d00", marginTop: 4 }}>
                    Status: {String(recentWithdrawal.status || recentWithdrawal.paymentStatus || "Pending").toUpperCase()}
                  </Text>
                  {getWithdrawBlockInfo().isBlocked && (
                    <Text style={{ marginTop: 6, fontSize: 12, color: "#7a4b00" }}>
                      {getWithdrawBlockInfo().message}
                    </Text>
                  )}
                </View>
              )}
              {withdrawStatus?.isRequestPending && (
                <View style={{ marginHorizontal: 16, marginTop: 12, padding: 10, borderRadius: 10, backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bfdbfe' }}>
                  <Text style={{ fontSize: 12, color: '#1d4ed8' }}>
                    One withdrawal per week is allowed. Your current withdrawal request is still in progress, so please wait until it is completed before requesting again.
                  </Text>
                </View>
              )}
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
                {t('referAndEarn')}
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
                onPress={() => console.log("Card clicked", card.titleKey)}
              >
                {card.amount !== null ? (
                  <Text style={styles.cardAmount}>₹{card.amount}</Text>
                ) : (
                  <MaterialIcons name={card.icon as any} size={28} color="#1a2f4d" />
                )}
                <Text style={styles.cardTitle}>{t(card.titleKey as any)}</Text>
                <Text style={styles.cardDate}>{t(card.dateKey as any)}</Text>
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
                ListEmptyComponent={
                  <View style={{ paddingHorizontal: 16, paddingTop: 24 }}>
                    <Text style={{ color: "#6b7280", textAlign: "center" }}>
                      {t('noAttendanceJobsYet')}
                    </Text>
                  </View>
                }
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
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{t('seeMore')}</Text>
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
              <Text style={{ fontSize: 18, fontWeight: "700", color: "#1A1A1A" }}>{t('rateWorker')} {selectedJobForRating?.acceptedBy}</Text>
              <TouchableOpacity onPress={() => setRatingModalVisible(false)}>
                <MaterialIcons name="close" size={24} color="#333" />
              </TouchableOpacity>
            </View>

            <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#666", marginBottom: 16 }}>{t('jobLabel')}: {selectedJobForRating?.title}</Text>

              <View style={{ marginBottom: 20 }}>
                <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 10 }}>{t('yourRating')}:</Text>
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

              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('feedbackOptional')}:</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, fontSize: 14, color: "#333", minHeight: 80, textAlignVertical: "top", marginBottom: 20 }}
                placeholder={t('feedbackPlaceholderWorker')}
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
                  <Text style={{ color: "#666", fontSize: 14, fontWeight: "600" }}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={{ flex: 1, paddingVertical: 12, borderRadius: 8, backgroundColor: "#FF9500", alignItems: "center" }}
                  onPress={handleSubmitRating}
                  disabled={submittingRating}
                >
                  <Text style={{ color: "#fff", fontSize: 14, fontWeight: "600" }}>
                    {submittingRating ? t('submitting') : t('submitRating')}
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
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>{t('payment')}</Text>
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
              <Text style={{ marginTop: 12, color: "#666" }}>{t('loadingPayment')}</Text>
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
            <Text style={{ fontSize: 16, fontWeight: "600", color: "#333" }}>{t('walletDeposit')}</Text>
            <TouchableOpacity onPress={() => {
              setDepositModalVisible(false);
              setDepositModalHtml('');
              showAlert(
                t('depositInProgressTitle'),
                t('depositInProgressMessage'),
                [{ text: t('ok'), onPress: () => {
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
              <Text style={{ marginTop: 12, color: "#666" }}>{t('loadingPaymentGateway')}</Text>
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
              {t('selectPayoutMethod')}
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
              <Text style={{ fontWeight: "700", color: "#111827" }}>{t('bankAccount')}</Text>
              <Text style={{ color: "#6b7280", marginTop: 2 }}>
                {bankAccount?.maskedAccount
                  ? `${t('linked')}: ${bankAccount.maskedAccount}${bankAccount?.isVerified ? ` (${t('verified')})` : ` (${t('pending')})`}`
                  : t('noBankLinked')}
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
              <Text style={{ fontWeight: "700", color: "#111827" }}>{t('upiId')}</Text>
              <Text style={{ color: "#6b7280", marginTop: 2 }}>
                {upiAccount?.maskedUpiId
                  ? `${t('linked')}: ${upiAccount.maskedUpiId}${upiAccount?.isVerified ? ` (${t('verified')})` : ` (${t('pending')})`}`
                  : t('noUpiLinked')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* UPI Modal */}
      <Modal visible={showAddUpi && activeTab === "Wallet"} transparent animationType="slide">
        <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1, backgroundColor: "#fff" }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingTop: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: "#EEE" }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: "#333" }}>{t('addUpiId')}</Text>
            <TouchableOpacity onPress={() => setShowAddUpi(false)}>
              <MaterialIcons name="close" size={28} color="#333" />
            </TouchableOpacity>
          </View>
          <View style={{ padding: 16 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('upiId')} *</Text>
            <TextInput
              style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 8, fontSize: 14 }}
              placeholder={t('upiPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              value={upiIdInput}
              onChangeText={setUpiIdInput}
            />
            <Text style={{ fontSize: 12, color: "#666", marginBottom: 18 }}>
              {t('upiWithdrawInfo')}
            </Text>
            <TouchableOpacity
              style={{ backgroundColor: "#1a2f4d", padding: 14, borderRadius: 8, alignItems: "center" }}
              onPress={handleAddUpiId}
            >
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>{t('saveUpiId')}</Text>
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
              <Text style={{ fontSize: 18, fontWeight: "700", color: "#333" }}>{t('addBankAccount')}</Text>
              <TouchableOpacity onPress={() => setShowAddBank(false)}>
                <MaterialIcons name="close" size={28} color="#333" />
              </TouchableOpacity>
            </View>

            <View style={{ padding: 16 }}>
              {/* Account Holder Name */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountHolderName')} *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('accountHolderNamePlaceholder')}
                value={bankDetails.accountHolderName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountHolderName: val })}
              />

              {/* Bank Name */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('bankName')} *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('bankNamePlaceholder')}
                value={bankDetails.bankName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, bankName: val })}
              />

              {/* Account Type */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountType')} *</Text>
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
                  <Text style={{ fontWeight: bankDetails.accountType === 'savings' ? '700' : '600', color: bankDetails.accountType === 'savings' ? '#1a2f4d' : '#666' }}>{t('savings')}</Text>
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
                  <Text style={{ fontWeight: bankDetails.accountType === 'current' ? '700' : '600', color: bankDetails.accountType === 'current' ? '#1a2f4d' : '#666' }}>{t('current')}</Text>
                </TouchableOpacity>
              </View>

              {/* Account Number */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountNumber')} *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('enterAccountNumber')}
                keyboardType="number-pad"
                value={bankDetails.accountNumber}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumber: val })}
              />

              {/* Confirm Account Number */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('confirmAccountNumber')} *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('confirmAccountNumberPlaceholder')}
                keyboardType="number-pad"
                value={bankDetails.accountNumberConfirm}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumberConfirm: val })}
              />

              {/* IFSC Code */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('ifscCode')} *</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 24, fontSize: 14 }}
                placeholder={t('ifscPlaceholder')}
                maxLength={11}
                value={bankDetails.ifscCode}
                onChangeText={(val) => setBankDetails({ ...bankDetails, ifscCode: val.toUpperCase() })}
              />

              {/* Submit Button */}
              <TouchableOpacity
                style={{ backgroundColor: "#1a2f4d", padding: 16, borderRadius: 8, alignItems: 'center', marginBottom: 32 }}
                onPress={handleAddBankAccount}
              >
                <Text style={{ color: "#fff", fontWeight: "700", fontSize: 16 }}>{t('saveBankAccount')}</Text>
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
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333" }}>{t('upiPayout')}</Text>
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
              <Text style={{ color: "#6d28d9", fontWeight: "600" }}>{t('change')}</Text>
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
            <Text style={{ fontWeight: '700', fontSize: 16, marginBottom: 12 }}>{t('choosePaymentMethod')}</Text>

            <TouchableOpacity
              style={{ padding: 12, borderRadius: 8, backgroundColor: '#f3f4f6', marginBottom: 8 }}
              onPress={() => payOptionsTarget && handlePayOption(payOptionsTarget.jobId, 'Cash', payOptionsTarget.workerPhone)}
            >
              <Text style={{ fontWeight: '600' }}>{t('payViaCash')}</Text>
              <Text style={{ color: '#666', marginTop: 4 }}>{t('payViaCashDesc')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={{ padding: 12, borderRadius: 8, backgroundColor: '#e6f7ff' }}
              onPress={() => payOptionsTarget && handlePayOption(payOptionsTarget.jobId, 'Online', payOptionsTarget.workerPhone)}
            >
              <Text style={{ fontWeight: '600' }}>{t('payViaOnline')}</Text>
              <Text style={{ color: '#666', marginTop: 4 }}>{t('payViaOnlineDesc')}</Text>
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


