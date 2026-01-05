import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Alert,
  Modal
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import styles from '../../../styles/WorkerWalletStyles';
import { LinearGradient } from 'expo-linear-gradient';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { API_BASE as API_URL } from '../../../utils/config';
import { socket } from '../../../utils/socket';
import { connectSocket } from '../../../utils/socket';
// Define types for wallet and transactions
type Transaction = {
  type: 'deposit' | 'withdraw' | 'payment'; // ✅ Added 'payment' type for contractor payments
  amount: number;
  date: string;
};

type WalletType = {
  balance: number;
  transactions: Transaction[];
};

export default function Wallet(): React.ReactElement {
  const [wallet, setWallet] = useState<WalletType>({ balance: 0, transactions: [] });
  const [showDeposit, setShowDeposit] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [currentUserPhone, setCurrentUserPhone] = useState<string | null>(null);
  const [walletFetchPending, setWalletFetchPending] = useState(false);
  const previousUserPhoneRef = useRef<string | null>(null);
  
  // ✅ Razorpay deposit states
  const [depositModalVisible, setDepositModalVisible] = useState(false);
  const [depositModalHtml, setDepositModalHtml] = useState('');
  const [currentDepositAmount, setCurrentDepositAmount] = useState(0);
  const [currentDepositOrderId, setCurrentDepositOrderId] = useState('');

  // ✅ Bank account states
  const [bankAccount, setBankAccount] = useState<any>(null);
  const [showAddBank, setShowAddBank] = useState(false);
  const [bankDetails, setBankDetails] = useState({
    accountHolderName: '',
    accountNumber: '',
    accountNumberConfirm: '',
    ifscCode: '',
    bankName: '',
    accountType: 'savings'
  });
  const [token, setToken] = useState<string | null>(null);

  // API_URL imported from central config

  // ✅ Check for user changes when screen comes into focus (no dependency on currentUserPhone to avoid stale closures)
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        const userStr = await AsyncStorage.getItem('user');
        const userPhone = userStr ? JSON.parse(userStr).phone : null;
        
        // If user changed (compare with ref, not state), reset wallet state immediately
        if (userPhone && userPhone !== previousUserPhoneRef.current) {
          console.log(`👤 Wallet: User changed from ${previousUserPhoneRef.current} to ${userPhone}, resetting wallet`);
          previousUserPhoneRef.current = userPhone;
          setCurrentUserPhone(userPhone);
          setWallet({ balance: 0, transactions: [] });
        } else if (!userPhone && previousUserPhoneRef.current !== null) {
          // User logged out
          console.log(`👤 Wallet: User logged out, resetting wallet`);
          previousUserPhoneRef.current = null;
          setCurrentUserPhone(null);
          setWallet({ balance: 0, transactions: [] });
        }
      })();
    }, [])
  );

  // ✅ Close all modals when wallet tab loses focus (not visible in other tabs)
  useFocusEffect(
    React.useCallback(() => {
      return () => {
        // When this component loses focus, close all modals
        setShowAddBank(false);
        setShowDeposit(false);
        setShowWithdraw(false);
        setDepositModalVisible(false);
        console.log('✅ Wallet modals closed (tab unfocused)');
      };
    }, [])
  );

  // Fetch wallet data when component mounts
  useEffect(() => {
    // ✅ Get current user to detect user changes on initial mount
    (async () => {
      const userStr = await AsyncStorage.getItem('user');
      const userPhone = userStr ? JSON.parse(userStr).phone : null;
      
      // If user changed, reset wallet state
      if (userPhone && userPhone !== currentUserPhone) {
        console.log(`👤 User changed from ${currentUserPhone} to ${userPhone}, resetting wallet`);
        setCurrentUserPhone(userPhone);
        setWallet({ balance: 0, transactions: [] });
      }
    })();
  }, []);

  // Fetch wallet when user phone changes
  useEffect(() => {
    if (currentUserPhone) {
      console.log(`💼 Fetching wallet for user: ${currentUserPhone}`);
      (async () => {
        // ✅ Ensure socket is connected with auth token (don't disconnect if already connected)
        const storedToken = await AsyncStorage.getItem('token');
        if (storedToken) {
          if (!socket.connected) {
            socket.auth = { token: storedToken };
            socket.connect();
            console.log("✅ Socket connecting with token for wallet");
          } else {
            console.log("✅ Socket already connected for wallet");
          }
        }
      })();

      // Small delay to ensure socket is ready
      const timer = setTimeout(() => {
        fetchWallet();
      }, 500);

      // ✅ Listen for job updates (payment) and refresh wallet
      const handleJobUpdated = (job: any) => {
        console.log("📱 Job updated event received:", job.paymentStatus);
        if (job.paymentStatus === "Paid") {
          console.log("💰 Payment detected, refreshing wallet...");
          // ✅ Prevent race condition: Only refresh if no other fetch is pending
          if (!walletFetchPending) {
            setWalletFetchPending(true);
            setTimeout(() => {
              fetchWallet().finally(() => setWalletFetchPending(false));
            }, 500);
          } else {
            console.log("⏳ Wallet fetch already pending, skipping duplicate fetch");
          }
        }
      };

      // ✅ Listen for wallet refresh events (from payment)
      const handleWalletRefresh = (data: any) => {
        console.log(`💸 Wallet refresh event received:`, data);
        if (!walletFetchPending) {
          setWalletFetchPending(true);
          setTimeout(() => {
            fetchWallet().finally(() => setWalletFetchPending(false));
          }, 500);
        }
      };

      // ✅ Listen for wallet updated events (from Razorpay payment)
      const handleWalletUpdated = (data: any) => {
        console.log(`💰 Wallet updated from payment:`, data);
        if (data.phone === currentUserPhone && !walletFetchPending) {
          setWalletFetchPending(true);
          setTimeout(() => {
            fetchWallet().finally(() => setWalletFetchPending(false));
          }, 500);
        }
      };

      socket.on("jobUpdated", handleJobUpdated);
      socket.on("walletRefresh", handleWalletRefresh);
      socket.on("walletUpdated", handleWalletUpdated);

      return () => {
        clearTimeout(timer);
        socket.off("jobUpdated", handleJobUpdated);
        socket.off("walletRefresh", handleWalletRefresh);
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
    }, [])
  );

  const fetchWallet = async () => {
    try {
      const token = await AsyncStorage.getItem('token');
      if (!token) return Promise.reject('No token');

      const res = await axios.get(`${API_URL}/wallet`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.data.success && res.data.wallet) {
        console.log(`💰 Wallet fetched: ₹${res.data.wallet.balance}`);
        setWallet({
          balance: res.data.wallet.balance || 0,
          transactions: res.data.wallet.transactions || []
        });
        return Promise.resolve();
      }
      return Promise.reject('Failed to fetch wallet');
    } catch (err) {
      console.error('Failed to fetch wallet', err);
      return Promise.reject(err);
    }
  };

  const handleDepositClick = () => {
    setShowDeposit(true);
    setShowWithdraw(false);
  };

  const handleWithdrawClick = () => {
    setShowWithdraw(true);
    setShowDeposit(false);
  };

  const confirmDeposit = async () => {
    if (!depositAmount || Number(depositAmount) <= 0) {
      Alert.alert('Error', 'Enter a valid amount to deposit');
      return;
    }
    
    if (Number(depositAmount) < 100) {
      Alert.alert('Error', 'Minimum deposit is ₹100');
      return;
    }

    try {
      const token = await AsyncStorage.getItem('token');
      
      // Step 1: Create deposit order
      const orderRes = await axios.post(
        `${API_URL}/wallet/deposit/create-order`,
        { amount: Number(depositAmount) },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (!orderRes.data.success) {
        Alert.alert('Error', 'Failed to create deposit order');
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
      Alert.alert('Error', err.response?.data?.message || 'Failed to initiate deposit');
    }
  };

  // Handle Razorpay deposit response
  const handleDepositMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'deposit_success') {
        // Verify deposit on backend
        await verifyDeposit(data);
      } else if (data.type === 'deposit_failed') {
        setDepositModalVisible(false);
        Alert.alert('Payment Failed', data.error || 'Deposit cancelled');
      }
    } catch (error) {
      console.error('Error handling deposit response:', error);
    }
  };

  // Verify deposit payment
  const verifyDeposit = async (data: any) => {
    try {
      const token = await AsyncStorage.getItem('token');
      
      const res = await axios.post(
        `${API_URL}/wallet/deposit/verify`,
        {
          orderId: data.orderId,
          paymentId: data.paymentId,
          signature: data.signature,
          amount: currentDepositAmount
        },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      setDepositModalVisible(false);

      if (res.data.success) {
        setWallet({ ...wallet, balance: res.data.walletBalance });
        Alert.alert('Success', `₹${currentDepositAmount} deposited to your wallet!`);
        setDepositAmount('');
        setShowDeposit(false);
        
        // Refresh wallet
        fetchWallet();
      } else {
        Alert.alert('Error', res.data.message || 'Deposit verification failed');
      }
    } catch (err: any) {
      setDepositModalVisible(false);
      Alert.alert('Error', err.response?.data?.message || 'Deposit verification failed');
    }
  };

  const confirmWithdraw = async () => {
    if (!withdrawAmount || Number(withdrawAmount) <= 0) {
      Alert.alert('Error', 'Enter a valid amount to withdraw');
      return;
    }

    if (Number(withdrawAmount) < 100) {
      Alert.alert('Error', 'Minimum withdrawal is ₹100');
      return;
    }

    if (Number(withdrawAmount) > wallet.balance) {
      Alert.alert('Error', 'Insufficient balance');
      return;
    }

    // Check if bank account is linked
    if (!bankAccount) {
      Alert.alert(
        'Bank Account Required',
        'Please add your bank account details before withdrawing',
        [
          { text: 'Cancel', onPress: () => {} },
          { text: 'Add Bank Account', onPress: () => setShowAddBank(true) }
        ]
      );
      return;
    }

    try {
      const savedToken = await AsyncStorage.getItem('token');
      const res = await axios.post(
        `${API_URL}/wallet/withdraw`,
        { amount: Number(withdrawAmount) },
        { headers: { Authorization: `Bearer ${savedToken}` } }
      );

      if (res.data.success) {
        setWallet({ ...wallet, balance: res.data.walletBalance });
        Alert.alert('Success', `Withdrawal of ₹${withdrawAmount} initiated!\n\nAmount will be transferred to your bank account within 2-4 hours.`);
        setWithdrawAmount('');
        setShowWithdraw(false);
        
        // Refresh wallet
        fetchWallet();
      }
    } catch (err: any) {
      const errorMsg = err.response?.data?.message || 'Withdrawal failed';
      Alert.alert('Error', errorMsg);
    }
  };

  // ✅ Fetch bank account
  const fetchBankAccount = async () => {
    try {
      const savedToken = await AsyncStorage.getItem('token');
      const res = await axios.get(
        `${API_URL}/wallet/bank-account`,
        { headers: { Authorization: `Bearer ${savedToken}` } }
      );

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
      Alert.alert('Error', 'Please enter account holder name');
      return;
    }

    if (bankDetails.accountNumber.length < 9 || bankDetails.accountNumber.length > 18) {
      Alert.alert('Error', 'Account number must be 9-18 digits');
      return;
    }

    if (bankDetails.accountNumber !== bankDetails.accountNumberConfirm) {
      Alert.alert('Error', 'Account numbers do not match');
      return;
    }

    if (bankDetails.ifscCode.length !== 11) {
      Alert.alert('Error', 'IFSC code must be exactly 11 characters');
      return;
    }

    if (!bankDetails.bankName.trim()) {
      Alert.alert('Error', 'Please enter bank name');
      return;
    }

    try {
      const savedToken = await AsyncStorage.getItem('token');
      const res = await axios.post(
        `${API_URL}/wallet/bank-account/add`,
        bankDetails,
        { headers: { Authorization: `Bearer ${savedToken}` } }
      );

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
        Alert.alert('Success', 'Bank account added! Waiting for verification.');
        fetchBankAccount();
      }
    } catch (err: any) {
      Alert.alert('Error', err.response?.data?.message || 'Failed to add bank account');
    }
  };

  // Map transactions to cards
  const cards = wallet.transactions.map((t, idx) => ({
    id: idx + 1,
    title: t.type.charAt(0).toUpperCase() + t.type.slice(1),
    amount: t.amount,
    date: new Date(t.date).toLocaleDateString(),
    icon: t.type === 'deposit' ? 'attach-money' : (t.type === 'payment' ? 'paid' : 'money-off')
  }));

  return (
    <ScrollView style={styles.container}>
      {/* Earnings Header */}
      <LinearGradient
        colors={['#223550ff', '#1a2f4d']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.headerContainer}
      >
        <Text style={styles.headerText}>Earnings</Text>
        <Text style={styles.amountText}>₹{wallet.balance}</Text>
      </LinearGradient>

      {/* Pocket Balance */}
      <View style={styles.balanceContainer}>
        <Text style={styles.balanceTitle}>Pocket Balance</Text>
        <Text style={styles.balanceAmount}>₹{wallet.balance}</Text>
      </View>

      {/* Available Balance */}
      <View style={styles.balanceContainer}>
        <Text style={styles.balanceTitle}>Available Balance</Text>
        <Text style={styles.balanceAmount}>₹{wallet.balance}</Text>
      </View>

      {/* Deposit & Withdraw Buttons */}
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: '#1a2f4d' }]}
          onPress={handleDepositClick}
        >
          <Text style={styles.buttonText}>Deposit</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionButton, { backgroundColor: '#2ecc71' }]}
          onPress={handleWithdrawClick}
        >
          <Text style={styles.buttonText}>Withdraw</Text>
        </TouchableOpacity>
      </View>

      {/* Conditional Deposit Input */}
      {showDeposit && (
        <View style={styles.inputRow}>
          <TextInput
            style={styles.amountInput}
            placeholder="Enter amount"
            keyboardType="numeric"
            value={depositAmount}
            onChangeText={setDepositAmount}
          />
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#1a2f4d', flex: 0.3 }]}
            onPress={confirmDeposit}
          >
            <Text style={styles.buttonText}>Confirm</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Conditional Withdraw Input */}
      {showWithdraw && (
        <View style={styles.inputRow}>
          <TextInput
            style={styles.amountInput}
            placeholder="Enter amount"
            keyboardType="numeric"
            value={withdrawAmount}
            onChangeText={setWithdrawAmount}
          />
          <TouchableOpacity
            style={[styles.actionButton, { backgroundColor: '#2ecc71', flex: 0.3 }]}
            onPress={confirmWithdraw}
          >
            <Text style={styles.buttonText}>Confirm</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Cards Grid */}
      <View style={styles.cardsRow}>
        {cards.map((card) => (
          <View key={card.id} style={styles.cardContainer}>
            <MaterialIcons name={card.icon as any} size={28} color="#1a2f4d" />
            <Text style={styles.cardAmount}>₹{card.amount}</Text>
            <Text style={styles.cardTitle}>{card.title}</Text>
            <Text style={styles.cardDate}>{card.date}</Text>
          </View>
        ))}
      </View>

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
      <Modal visible={showAddBank} transparent animationType="slide">
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
      {bankAccount && (
        <View style={{ padding: 16, backgroundColor: "#f0f8ff", marginTop: 16, marginHorizontal: 16, borderRadius: 8, borderLeftWidth: 4, borderLeftColor: "#1a2f4d" }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ fontSize: 14, fontWeight: "600", color: "#333" }}>💳 Linked Bank Account</Text>
            <TouchableOpacity onPress={() => setShowAddBank(true)}>
              <Text style={{ color: "#1a2f4d", fontWeight: "600" }}>Change</Text>
            </TouchableOpacity>
          </View>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.bankName}</Text>
          <Text style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>{bankAccount.maskedAccount}</Text>
          <Text style={{ fontSize: 11, color: bankAccount.isVerified ? "#27ae60" : "#f39c12" }}>
            {bankAccount.isVerified ? '✅ Verified' : `⏳ ${bankAccount.verificationStatus}`}
          </Text>
        </View>
      )}
    </ScrollView>
  );
}
