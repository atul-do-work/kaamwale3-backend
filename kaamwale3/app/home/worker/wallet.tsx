import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Modal,
  ActivityIndicator
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import styles from '../../../styles/WorkerWalletStyles';
import { LinearGradient } from 'expo-linear-gradient';
// API base now used via `api` wrapper; no direct API_BASE import needed here
import { socket } from '../../../utils/socket';
import { useLanguage } from '../../../context/LanguageContext';
// Define types for wallet and transactions
type Transaction = {
  type: 'deposit' | 'pocket_deposit' | 'withdraw' | 'payment' | 'incentive_reward';
  amount: number;
  date: string;
};

type WalletType = {
  balance: number;
  availableBalance: number;
  pocketBalance: number;
  transactions: Transaction[];
};

type WeeklyType = {
  earnings: number;
  available: number;
  deducted: number;
  weekStart: string | Date;
  weekEnd: string | Date;
};

type CashDepositType = {
  id: string;
  jobId: string;
  jobTitle: string;
  amount: number;
  status: 'pending' | 'completed' | 'expired' | 'cancelled';
  depositDeadline: string;
  createdAt: string;
  contractorName: string;
};

import { useAuth } from '../../../context/AuthContext';
import api from '../../../utils/api';

export default function Wallet(): React.ReactElement {
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const { accessToken, user: authUser } = useAuth();
  const tx = (key: keyof typeof import('../../../constants/translations').translations.en, fallback: string) => {
    const translated = t(key);
    return translated && translated !== key ? translated : fallback;
  };
  
  const [wallet, setWallet] = useState<WalletType>({ balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
  const [weekly, setWeekly] = useState<WeeklyType | null>(null);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const previousUserPhoneRef = useRef<string | null>(null);
  
  // ✅ Razorpay deposit states
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [depositModalHtml, setDepositModalHtml] = useState('');
  const [currentDepositAmount, setCurrentDepositAmount] = useState(0);
  const [currentDepositOrderId, setCurrentDepositOrderId] = useState('');
  const [depositLoading, setDepositLoading] = useState(false);

  // ✅ Bank account states
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [showAddBank, setShowAddBank] = useState(false);
  const [showBankInfo, setShowBankInfo] = useState(true); // ✅ Control visibility of bank info display
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: '',
    accountNumber: '',
    accountNumberConfirm: '',
    ifscCode: '',
    bankName: '',
    accountType: 'savings'
  });
  const [withdrawStatus, setWithdrawStatus] = useState<any>(null);
  const [recentWithdrawal, setRecentWithdrawal] = useState<any>(null);
  
  // ✅ Cash Deposits State
  const [cashDeposits, setCashDeposits] = useState<CashDepositType[]>([]);
  const [isDepositingCash, setIsDepositingCash] = useState(false);
  const [depositingJobId, setDepositingJobId] = useState<string | null>(null);
  
  // 🔐 CRITICAL FIX #2: Add idempotency locks to prevent double-tap exploits
  const [isWithdrawProcessing, setIsWithdrawProcessing] = useState(false);
  const [isDepositVerifyProcessing, setIsDepositVerifyProcessing] = useState(false);
  const lastWithdrawIdempotencyKeyRef = useRef<string>('');
  const lastDepositVerifyIdempotencyKeyRef = useRef<string>('');

  // API_URL imported from central config
  
  // 🔐 Generate unique idempotency key: timestamp + random = no duplicates
  const generateIdempotencyKey = (): string => {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  };

  // ✅ Check for user changes when screen comes into focus
  useFocusEffect(
    React.useCallback(() => {
      const userPhone = authUser?.phone;
      // If user changed (compare with ref), reset wallet state immediately
      if (userPhone && userPhone !== previousUserPhoneRef.current) {
        console.log(`👤 Wallet: User changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting wallet`);
        previousUserPhoneRef.current = userPhone;
        setCurrentUserPhone(userPhone);
        setWallet({ balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
        setDepositLoading(false); // Reset loading state on user change
        setIsWithdrawProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on user change
        setIsDepositVerifyProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on user change
      } else if (!userPhone && previousUserPhoneRef.current !== null) {
        // User logged out
        console.log(`👤 Wallet: User logged out, resetting wallet`);
        previousUserPhoneRef.current = null;
        setCurrentUserPhone(null);
        setWallet({ balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
        setDepositLoading(false); // Reset loading state on logout
        setIsWithdrawProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on logout
        setIsDepositVerifyProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on logout
      }
    }, [authUser])
  );

  // ✅ Close all modals when wallet tab loses focus
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        setShowAddBank(false);
        setShowDeposit(false);
        setShowWithdraw(false);
        setDepositModalVisible(false);
        setDepositLoading(false); // Reset loading state
        setIsWithdrawProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on tab unfocus
        setIsDepositVerifyProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on tab unfocus
        console.log('✅ Wallet modals closed (tab unfocused)');
      };
    }, [])
  );

  // ✅ Initialize user phone from AuthProvider
  useEffect(() => {
    const userPhone = authUser?.phone;
    if (userPhone && userPhone !== currentUserPhone) {
      console.log(`👤 User changed from ${currentUserPhone} to ${userPhone}, resetting wallet`);
      setCurrentUserPhone(userPhone);
      setWallet({ balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
      setIsWithdrawProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on user change
      setIsDepositVerifyProcessing(false); // 🔐 CRITICAL FIX #2: Reset lock on user change
    }
  }, [authUser?.phone]);

  // Fetch wallet when user phone changes
  useEffect(() => {
    if (currentUserPhone) {
      console.log(`💼 Fetching wallet for user: ${currentUserPhone}`);
      // ✅ Track if component is mounted to prevent state updates after unmount
      let isMounted = true;
      
      // Small delay to ensure socket is ready
      const timer = setTimeout(() => {
        if (isMounted) {
          fetchWallet();
        }
      }, 500);

      // ✅ PRODUCTION PATTERN: Direct state update from socket events (no re-fetch)
      const handleWalletUpdated = (data: any) => {
        console.log(`💰 Wallet updated from payment:`, data);
        try {
          // ✅ Only update state if component is still mounted
          if (!isMounted) {
            console.warn('⚠️ Component unmounted, ignoring wallet update');
            return;
          }
          
          if (data && data.phone === currentUserPhone) {
            const nextAvailable = Number(data.availableBalance ?? data.balance ?? 0);
            const nextPocket = Number(data.pocketBalance ?? 0);
            setWallet(prev => {
              // ✅ FIX: Ensure prev and transactions are defined before spreading
              if (!prev || !prev.transactions) {
                return {
                  balance: nextAvailable,
                  availableBalance: nextAvailable,
                  pocketBalance: nextPocket,
                  transactions: [{
                    type: data.type || 'deposit',
                    amount: data.amount || 0,
                    date: new Date().toISOString()
                  }]
                };
              }
              
              return {
                balance: nextAvailable,
                availableBalance: nextAvailable,
                pocketBalance: nextPocket,
                transactions: [
                  {
                    type: data.type || 'deposit',
                    amount: data.amount || 0,
                    date: new Date().toISOString()
                  },
                  ...(Array.isArray(prev.transactions) ? prev.transactions : [])
                ]
              };
            });
            setWeekly(prev => {
              if (!prev) return prev;
              const now = new Date();
              const weekStart = new Date(prev.weekStart);
              const weekEnd = new Date(prev.weekEnd);
              if (
                Number.isNaN(weekStart.getTime()) ||
                Number.isNaN(weekEnd.getTime()) ||
                now < weekStart ||
                now > weekEnd
              ) {
                return prev;
              }
              const amt = Number(data.amount || 0);
              if (!Number.isFinite(amt) || amt <= 0) return prev;
              if (data.type === 'payment') {
                return {
                  ...prev,
                  earnings: Number(prev.earnings || 0) + amt,
                  available: Number(prev.available || 0) + amt,
                };
              }
              if (data.type === 'withdraw') {
                return {
                  ...prev,
                  deducted: Number(prev.deducted || 0) + amt,
                  available: Math.max(0, Number(prev.available || 0) - amt),
                };
              }
              return prev;
            });
            console.log(`✅ Wallet updated: available ₹${nextAvailable}, pocket ₹${nextPocket}`);
          } else {
            console.warn(`⚠️ Invalid wallet update data:`, data);
          }
        } catch (err) {
          console.error('❌ Error updating wallet from socket:', err);
        }
      };

      socket.on("walletUpdated", handleWalletUpdated);

      // ✅ Cleanup function
      return () => {
        isMounted = false; // Mark as unmounted
        clearTimeout(timer);
        socket.off("walletUpdated", handleWalletUpdated);
      };
    }
  }, [currentUserPhone]);

  // ✅ Refresh wallet when screen comes into focus (fallback for missed socket events)
  useFocusEffect(
    React.useCallback(() => {
      console.log("📱 Wallet screen focused - refreshing balance");
      fetchWallet();
      fetchBankAccount();
      fetchWithdrawStatus();
      fetchCashDeposits();
    }, [])
  );

  const fetchWallet = async () => {
    try {
      if (!accessToken) return Promise.reject('No token');

      const res = await api.get('/wallet');

      if (res.data.success && res.data.wallet) {
        console.log(`💰 Wallet fetched: available ₹${res.data.wallet.availableBalance ?? res.data.wallet.balance ?? 0}, pocket ₹${res.data.wallet.pocketBalance ?? 0}`);
        setWallet({
          balance: Number(res.data.wallet.availableBalance ?? res.data.wallet.balance ?? 0),
          availableBalance: Number(res.data.wallet.availableBalance ?? res.data.wallet.balance ?? 0),
          pocketBalance: Number(res.data.wallet.pocketBalance ?? 0),
          transactions: res.data.wallet.transactions || []
        });
        setWeekly(res.data.wallet.weekly || null);
        return Promise.resolve();
      }
      return Promise.reject('Failed to fetch wallet');
    } catch (err) {
      console.error('Failed to fetch wallet', err);
      return Promise.reject(err);
    }
  };

  const fetchWithdrawStatus = async () => {
    if (!accessToken) return;
    try {
      const res = await api.get('/wallet/withdraw/status');
      if (res.data?.success) {
        setRecentWithdrawal(res.data.recentWithdrawal || null);
        setWithdrawStatus(res.data.withdrawStatus || null);
      }
    } catch (err) {
      console.error('Failed to load withdraw status:', err);
    }
  };

  // ✅ Fetch Cash Deposits
  const fetchCashDeposits = async () => {
    if (!accessToken) return;
    try {
      const res = await api.get('/jobs/cash-deposits');
      if (res.data?.success) {
        setCashDeposits(res.data.deposits || []);
      }
    } catch (err) {
      console.error('Failed to load cash deposits:', err);
    }
  };

  useEffect(() => {
    if (accessToken) {
      fetchWithdrawStatus();
    }
  }, [accessToken]);

  const handleDepositClick = () => {
    setShowDeposit(true);
    setShowWithdraw(false);
  };

  const handleWithdrawClick = () => {
    setShowWithdraw(true);
    setShowDeposit(false);
  };

  const confirmDeposit = async () => {
    if (depositLoading) return; // ✅ Prevent double-submission
    
    if (!depositAmount || Number(depositAmount) <= 0) {
      Alert.alert(t('error'), t('enterValidAmount'));
      return;
    }
    
    if (Number(depositAmount) < 100) {
      Alert.alert(t('error'), t('minimumDeposit'));
      return;
    }

    setDepositLoading(true);
    try {
      // Step 1: Create deposit order
      const orderRes = await api.post('/wallet/deposit/create-order', { 
        amount: Number(depositAmount) 
      });

      if (!orderRes.data.success) {
        Alert.alert(t('error'), t('failedCreateOrder'));
        return;
      }

      // ✅ SECURITY: Get amount from backend response, NOT frontend calculation
      const { orderId, key_id, amount } = orderRes.data;

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
      Alert.alert(t('error'), err.response?.data?.message || t('failedInitiateDeposit'));
    } finally {
      setDepositLoading(false);
    }
  };

  // Handle Razorpay deposit response
  const handleDepositMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'deposit_success') {
        // ✅ Close modal FIRST before verifying deposit (prevents race condition)
        // This ensures state updates happen after UI transitions complete
        setDepositModalVisible(false);
        setDepositModalHtml('');
        
        // Small delay to allow modal to close gracefully before state updates
        setTimeout(() => {
          verifyDeposit(data);
        }, 300);
      } else if (data.type === 'deposit_failed') {
        setDepositModalVisible(false);
        // ✅ Clear WebView HTML from memory
        setDepositModalHtml('');
        // ✅ Offer retry instead of just closing
        Alert.alert(
          t('paymentFailed'),
          data.error || t('depositCancelled'),
          [
            { text: t('close'), onPress: () => {} },
            { text: t('tryAgain'), onPress: () => {
              setDepositModalVisible(true);
            }, style: 'default' }
          ]
        );
      }
    } catch (error) {
      console.error('Error handling deposit response:', error);
    }
  };

  // ✅ Verify deposit payment
  const verifyDeposit = async (data: any) => {
    // 🔐 CRITICAL FIX #2: Add loading lock to prevent double-tap on verify
    if (isDepositVerifyProcessing) {
      console.warn('⚠️ Deposit verify already processing, ignoring duplicate request');
      return;
    }
    
    setIsDepositVerifyProcessing(true);
    const idempotencyKey = generateIdempotencyKey();
    lastDepositVerifyIdempotencyKeyRef.current = idempotencyKey;
    
    try {
      // 🔐 CRITICAL FIX #2: Include idempotency key in request header
      const res = await api.post('/wallet/deposit/verify', 
        {
          orderId: data.orderId,
          paymentId: data.paymentId,
          signature: data.signature,
          amount: currentDepositAmount
        },
        {
          headers: {
            'x-idempotency-key': idempotencyKey
          }
        }
      );

      // ✅ Don't close modal here - already closed in handleDepositMessage
      // setDepositModalVisible(false);

      if (res.data.success) {
        const message = res.data.isDuplicate
          ? tx('depositAlreadyProcessed', 'Deposit already processed successfully.')
          : `${tx('depositLabel', 'Deposit')} ₹${currentDepositAmount} ${tx('depositSuccessSuffix', 'was successful')}`;
        Alert.alert(t('success'), message);
        setDepositAmount('');
        setShowDeposit(false);
        // ✅ Fallback: Fetch wallet if socket fails
        await fetchWallet();
      } else {
        // ✅ Offer retry for verification failures
        Alert.alert(
          t('error'),
          res.data.message || t('depositVerificationFailed'),
          [
            { text: t('close'), onPress: () => {} },
            { text: t('tryAgain'), onPress: () => verifyDeposit(data), style: 'default' }
          ]
        );
      }
    } catch (err: any) {
      // ✅ Don't close modal here - already closed in handleDepositMessage
      // setDepositModalVisible(false);
      const errorMsg = err.response?.data?.message || t('depositVerificationFailed');
      // ✅ Offer retry for network/timeout errors
      Alert.alert(
        t('error'),
        errorMsg,
        [
          { text: t('close'), onPress: () => {
            // ✅ Even if user closes error, try to fetch wallet as fallback
            fetchWallet();
          } },
          { text: t('tryAgain'), onPress: () => verifyDeposit(data), style: 'default' }
        ]
      );
    } finally {
      // 🔐 CRITICAL FIX #2: Always release the lock
      setIsDepositVerifyProcessing(false);
    }
  };

  const confirmWithdraw = async () => {
    // 🔐 CRITICAL FIX #2: Add loading lock to prevent double-tap
    if (isWithdrawProcessing) {
      console.warn('⚠️ Withdraw already processing, ignoring duplicate request');
      return;
    }
    
    if (withdrawStatus?.blocked) {
      Alert.alert(t('error'), withdrawStatus.message || tx('withdrawalUnavailable', 'Withdrawal temporarily unavailable'));
      return;
    }

    if (!withdrawAmount || Number(withdrawAmount) <= 0) {
      Alert.alert(t('error'), t('enterValidWithdrawAmount'));
      return;
    }

    if (Number(withdrawAmount) < 100) {
      Alert.alert(t('error'), t('minimumWithdraw'));
      return;
    }

    const availableBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0);
    if (Number(withdrawAmount) > availableBalance) {
      Alert.alert(t('error'), t('insufficientBalance'));
      return;
    }

    // Check if bank account is linked
    if (!bankAccount) {
      Alert.alert(
        t('bankAccount'),
        tx('verifiedBankRequiredBeforeWithdraw', 'Please add a verified bank account before withdrawing'),
        [
          { text: t('cancel'), onPress: () => {} },
          { text: t('addBankAccount'), onPress: () => setShowAddBank(true) }
        ]
      );
      return;
    }

    // 🔐 CRITICAL FIX #2: Generate idempotency key + set loading lock
    setIsWithdrawProcessing(true);
    const idempotencyKey = generateIdempotencyKey();
    lastWithdrawIdempotencyKeyRef.current = idempotencyKey;
    
    try {
      // 🔐 CRITICAL FIX #2: Include idempotency key in request header
      const res = await api.post('/wallet/withdraw', 
        { amount: Number(withdrawAmount) },
        {
          headers: {
            'x-idempotency-key': idempotencyKey
          }
        }
      );

      if (res.data.success) {
        Alert.alert(t('success'), `${t('withdrawalInitiated')}\n\n${t('amountTransferred')}`);
        setWithdrawAmount('');
        setShowWithdraw(false);
        await fetchWithdrawStatus();
        await fetchWallet();
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || t('withdrawFailed');
      Alert.alert(t('error'), errorMsg);
      await fetchWithdrawStatus();
    } finally {
      // 🔐 CRITICAL FIX #2: Always release the lock
      setIsWithdrawProcessing(false);
    }
  };

  // ✅ Fetch bank account
  const fetchBankAccount = async () => {
    try {
      const res = await api.get('/wallet/bank-account');

      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
      }
    } catch (err) {
      console.error('Error fetching bank account:', err);
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
      const res = await api.post('/wallet/bank-account/add', bankDetails);

      if (res.data.success) {
        setBankAccount(res.data.bankAccount);
        setBankDetails({
          accountHolderName: '',
          accountNumber: '',
          accountNumberConfirm: '',
          ifscCode: '',
          bankName: '',
          accountType: 'savings'
        });
        setShowAddBank(false);
        Alert.alert(t('success'), tx('bankAccountPendingVerification', 'Bank account added and is pending verification'));
        fetchBankAccount();
      }
    } catch (err: any) {
      Alert.alert(t('error'), err.response?.data?.message || t('failedAddBank'));
    }
  };

  // ✅ Handle Cash Deposit
  const handleCashDeposit = async (depositId: string) => {
    setIsDepositingCash(true);
    setDepositingJobId(depositId);
    try {
      const res = await api.post(`/jobs/cash-deposits/${depositId}/deposit`);
      if (res.data.success) {
        Alert.alert(t('success'), 'Cash deposited successfully');
        await fetchCashDeposits();
        await fetchWallet();
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Cash deposit failed';
      Alert.alert(t('error'), errorMsg);
    } finally {
      setIsDepositingCash(false);
      setDepositingJobId('');
    }
  };

  // Map transactions to cards
  const transactionTitleMap: Record<Transaction['type'], string> = {
    deposit: tx('depositLabel', 'Deposit'),
    pocket_deposit: tx('pocketDeposit', 'Pocket Deposit'),
    withdraw: t('withdraw'),
    payment: tx('paymentLabel', 'Payment'),
    incentive_reward: tx('incentiveReward', 'Incentive Reward'),
  };

  const formatWeekRange = (w: WeeklyType | null) => {
    if (!w?.weekStart || !w?.weekEnd) return "";
    const start = new Date(w.weekStart);
    const end = new Date(w.weekEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
    const fmt = (d: Date) =>
      `${String(d.getDate()).padStart(2, '0')} ${d.toLocaleString('en-IN', { month: 'short' })}`;
    return `${fmt(start)} - ${fmt(end)}`;
  };
  const weekRangeText = formatWeekRange(weekly);
  const weeklyEarningsAmount = Number(weekly?.earnings ?? 0);
  const currentAvailableAmount = Number(wallet.availableBalance ?? wallet.balance ?? 0);

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom + 24, 32) }}
    >
      {/* Earnings Header */}
      <LinearGradient
        colors={['#223550ff', '#1a2f4d']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.headerContainer}
      >
        <Text style={styles.headerText}>{t('earnings')}</Text>
        <Text style={styles.amountText}>₹{weeklyEarningsAmount}</Text>
        {!!weekRangeText && (
          <Text style={{ color: '#d7e3f5', marginTop: 4, fontSize: 12 }}>{weekRangeText}</Text>
        )}
      </LinearGradient>

      {/* Balance summary */}
      <View style={styles.balanceSummaryCard}>
        <View style={styles.balanceRow}>
          <View style={styles.balanceSegment}>
            <Text style={styles.balanceSegmentTitle}>{t('pocketBalance')}</Text>
            <Text style={styles.balanceSegmentAmount}>₹{wallet.pocketBalance}</Text>
          </View>
          <View style={styles.balanceSegmentSpacer} />
          <View style={styles.balanceSegment}>
            <Text style={styles.balanceSegmentTitle}>{tx('availableBalance', 'Available Balance')}</Text>
            <Text style={styles.balanceSegmentAmount}>₹{currentAvailableAmount}</Text>
          </View>
        </View>
      </View>

      {/* Cash Deposits Section */}
      {cashDeposits.length > 0 && (
        <View style={styles.cashDepositsCard}>
          <Text style={styles.cashDepositsTitle}>{'Pending Cash Deposits'}</Text>
          {cashDeposits.map((deposit) => (
            <View key={deposit.id} style={styles.cashDepositItem}>
              <View style={styles.cashDepositInfo}>
                <Text style={styles.cashDepositAmount}>₹{deposit.amount}</Text>
                <Text style={styles.cashDepositJobId}>Job: {deposit.jobTitle}</Text>
                <Text style={styles.cashDepositDeadline}>
                  Deadline: {new Date(deposit.depositDeadline).toLocaleDateString()}
                </Text>
              </View>
              <TouchableOpacity
                style={[
                  styles.cashDepositButton,
                  {
                    opacity: isDepositingCash && depositingJobId === deposit.id ? 0.6 : 1
                  }
                ]}
                onPress={() => handleCashDeposit(deposit.id)}
                disabled={isDepositingCash}
              >
                <Text style={styles.cashDepositButtonText}>
                  {isDepositingCash && depositingJobId === deposit.id
                    ? 'Depositing...'
                    : 'Deposit Cash'
                  }
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Deposit & Withdraw Actions */}
      <View style={styles.actionIconRow}>
        <TouchableOpacity
          style={[styles.actionIconButton, { backgroundColor: '#1a2f4d', opacity: depositLoading ? 0.6 : 1 }]}
          onPress={handleDepositClick}
          disabled={depositLoading}
        >
          <MaterialIcons name="arrow-downward" size={20} color="#fff" />
          <Text style={styles.actionIconText}>{tx('depositLabel', 'Deposit')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionIconButton, { backgroundColor: '#2ecc71', opacity: isWithdrawProcessing ? 0.6 : 1 }]}
          onPress={handleWithdrawClick}
          disabled={isWithdrawProcessing}
        >
          <MaterialIcons name="arrow-upward" size={20} color="#fff" />
          <Text style={styles.actionIconText}>{isWithdrawProcessing ? t('processing') : t('withdraw')}</Text>
        </TouchableOpacity>
      </View>

      {/* Conditional Deposit Input */}
      {showDeposit && (
        <View>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.amountInput}
              placeholder={tx('enterAmount', 'Enter amount')}
              keyboardType="numeric"
              value={depositAmount}
              onChangeText={setDepositAmount}
              editable={!depositLoading}
            />
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#1a2f4d', flex: 0.3, opacity: depositLoading || isDepositVerifyProcessing ? 0.6 : 1 }]}
              onPress={confirmDeposit}
              disabled={depositLoading || isDepositVerifyProcessing}
            >
              <Text style={styles.buttonText}>{depositLoading || isDepositVerifyProcessing ? t('processing') : tx('confirmLabel', 'Confirm')}</Text>
            </TouchableOpacity>
          </View>
          {/* ✅ Deposit Summary UI */}
          {depositAmount && Number(depositAmount) > 0 && (
            <View style={{ marginTop: 12, marginHorizontal: 16, padding: 12, backgroundColor: '#f0f8ff', borderRadius: 8, borderLeftWidth: 4, borderLeftColor: '#1a2f4d' }}>
              <Text style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>{tx('depositSummary', 'Deposit Summary')}</Text>
              <Text style={{ fontSize: 14, fontWeight: '600', color: '#1a2f4d' }}>{tx('youWillDeposit', 'You will deposit')} ₹{Number(depositAmount)}</Text>
              <Text style={{ fontSize: 11, color: '#999', marginTop: 6 }}>{tx('minimumDepositNoCharges', 'Minimum ₹100, no transaction charges')}</Text>
            </View>
          )}
        </View>
      )}

      {/* Conditional Withdraw Input */}
      {showWithdraw && (
        <View>
          {withdrawStatus?.isRequestPending && (
            <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 10, backgroundColor: '#eef6ff', borderWidth: 1, borderColor: '#bee3f8' }}>
              <Text style={{ fontSize: 13, color: '#1d4ed8', fontWeight: '700', marginBottom: 4 }}>{tx('withdrawalRequested', 'Withdrawal Requested')}</Text>
              <Text style={{ fontSize: 12, color: '#334155' }}>
                {tx('withdrawalRequestedMessage', 'A withdrawal request is already pending. One withdrawal is allowed per week, so please wait for the current request to complete before requesting again.')}
              </Text>
            </View>
          )}
          {withdrawStatus?.blocked && !withdrawStatus?.isRequestPending && (
            <View style={{ marginHorizontal: 16, marginBottom: 10, padding: 12, borderRadius: 10, backgroundColor: '#fff7ed', borderWidth: 1, borderColor: '#fbbf24' }}>
              <Text style={{ fontSize: 13, color: '#b45309', fontWeight: '700', marginBottom: 4 }}>{tx('withdrawalUnavailable', 'Withdrawal unavailable')}</Text>
              <Text style={{ fontSize: 12, color: '#7c2d12' }}>{withdrawStatus.message}</Text>
            </View>
          )}
          <View style={styles.inputRow}>
            <TextInput
              style={styles.amountInput}
              placeholder={tx('enterAmount', 'Enter amount')}
              keyboardType="numeric"
              value={withdrawAmount}
              onChangeText={setWithdrawAmount}
              editable={!withdrawStatus?.isRequestPending}
            />
            <TouchableOpacity
              style={[styles.actionButton, { backgroundColor: '#2ecc71', flex: 0.3, opacity: withdrawStatus?.isRequestPending ? 0.5 : 1 }]}
              onPress={confirmWithdraw}
              disabled={withdrawStatus?.isRequestPending}
            >
              <Text style={styles.buttonText}>{tx('confirmLabel', 'Confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Transaction list */}
      <View style={styles.transactionSection}>
        <View style={styles.transactionHeaderRow}>
          <Text style={styles.transactionHeader}>{tx('transactions', 'Transactions')}</Text>
          <Text style={styles.transactionCount}>{wallet.transactions.length} {tx('transactions', 'Transactions')}</Text>
        </View>

        {wallet.transactions.length === 0 ? (
          <View style={styles.transactionEmpty}>
            <Text style={styles.transactionEmptyText}>{tx('noTransactions', 'No transactions yet')}</Text>
          </View>
        ) : (
          wallet.transactions.map((transaction, index) => {
            const title = transactionTitleMap[transaction.type] || transaction.type;
            const icon =
              transaction.type === 'deposit' || transaction.type === 'pocket_deposit'
                ? 'arrow-downward'
                : transaction.type === 'withdraw'
                  ? 'arrow-upward'
                  : 'paid';
            const amountColor = transaction.type === 'withdraw' ? '#dc2626' : '#16a34a';
            const prefix = transaction.type === 'withdraw' ? '-₹' : '+₹';

            return (
              <View key={`${transaction.type}-${transaction.date}-${index}`} style={styles.transactionItem}>
                <View style={styles.transactionLeft}>
                  <View style={styles.transactionIconCircle}>
                    <MaterialIcons name={icon as any} size={20} color={transaction.type === 'withdraw' ? '#dc2626' : '#1d4ed8'} />
                  </View>
                  <View style={styles.transactionDetails}>
                    <Text style={styles.transactionTitle}>{title}</Text>
                    <Text style={styles.transactionDate}>{new Date(transaction.date).toLocaleDateString()}</Text>
                  </View>
                </View>
                <Text style={[styles.transactionAmount, { color: amountColor }]}>{prefix}{transaction.amount}</Text>
              </View>
            );
          })
        )}
      </View>

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
              Alert.alert(
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

      {/* ✅ Bank Account Modal */}
      <Modal visible={showAddBank} transparent animationType="slide">
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
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountHolderName')}</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('accountHolderNamePlaceholder')}
                value={bankDetails.accountHolderName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountHolderName: val })}
              />

              {/* Bank Name */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('bankName')}</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('bankNamePlaceholder')}
                value={bankDetails.bankName}
                onChangeText={(val) => setBankDetails({ ...bankDetails, bankName: val })}
              />

              {/* Account Type */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountType')}</Text>
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
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('accountNumber')}</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('enterAccountNumber')}
                keyboardType="number-pad"
                value={bankDetails.accountNumber}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumber: val })}
              />

              {/* Confirm Account Number */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('confirmAccountNumber')}</Text>
              <TextInput
                style={{ borderWidth: 1, borderColor: "#DDD", borderRadius: 8, padding: 12, marginBottom: 16, fontSize: 14 }}
                placeholder={t('confirmAccountNumberPlaceholder')}
                keyboardType="number-pad"
                value={bankDetails.accountNumberConfirm}
                onChangeText={(val) => setBankDetails({ ...bankDetails, accountNumberConfirm: val })}
              />

              {/* IFSC Code */}
              <Text style={{ fontSize: 14, fontWeight: "600", color: "#333", marginBottom: 8 }}>{t('ifscCode')}</Text>
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
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333" }}>{t('linkedBankAccount')}</Text>
            <TouchableOpacity onPress={() => setShowBankInfo(false)}>
              <MaterialIcons name="close" size={20} color="#333" />
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.bankName}</Text>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.maskedAccount}</Text>
          <Text style={{ fontSize: 11, color: bankAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {bankAccount.isVerified ? `✅ ${t('verified')}` : `⏳ ${bankAccount.verificationStatus}`}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}


