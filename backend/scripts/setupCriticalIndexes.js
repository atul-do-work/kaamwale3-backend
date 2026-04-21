/**
 * 🚨 CRITICAL INDEXES SETUP (FINAL VERSION)
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Jobs = require('../models/Jobs');
const IncentiveLedger = require('../models/IncentiveLedger');
const GigHistory = require('../models/GigHistory');

async function setupCriticalIndexes() {
  try {
    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;

    if (!mongoUri) {
      throw new Error('❌ MongoDB URI not found in environment variables');
    }

    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // ================================
    // 1. ENSURE SCHEMA INDEXES
    // ================================
    console.log('📌 Ensuring schema indexes (Jobs)...');
    await Jobs.syncIndexes(); // better than ensureIndexes
    console.log('✅ Jobs indexes synced\n');

    // ================================
    // 2. INCENTIVE LEDGER INDEXES
    // ================================
    console.log('📌 Creating IncentiveLedger indexes...');

    // Prevent double credit
    await IncentiveLedger.collection.createIndex(
      { phone: 1, milestoneId: 1 },
      {
        unique: true,
        partialFilterExpression: {
          'walletCredit.status': 'credited'
        },
        name: 'idx_incentive_unique_claim'
      }
    );

    // Fast lookup
    await IncentiveLedger.collection.createIndex(
      { phone: 1, 'walletCredit.status': 1 },
      {
        name: 'idx_incentive_phone_status'
      }
    );

    console.log('✅ IncentiveLedger indexes created\n');

    // ================================
    // 3. GIG HISTORY INDEXES
    // ================================
    console.log('📌 Creating GigHistory indexes...');

    // TTL (auto delete after 1 year)
    await GigHistory.collection.createIndex(
      { eventTime: 1 },
      {
        expireAfterSeconds: 31536000,
        name: 'idx_gighistory_ttl'
      }
    );

    // Query optimization
    await GigHistory.collection.createIndex(
      { workerPhone: 1, eventTime: -1 },
      {
        name: 'idx_gighistory_worker_time'
      }
    );

    // 🔥 IMPORTANT: Eligibility query optimization
    await GigHistory.collection.createIndex(
      { workerPhone: 1, workDate: -1, eventType: 1 },
      {
        name: 'idx_gighistory_worker_workdate_type'
      }
    );

    console.log('✅ GigHistory indexes created\n');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ ALL INDEXES SETUP COMPLETE\n');

    console.log('🔒 SAFETY GUARANTEES:');
    console.log('  ✅ No double incentive credit');
    console.log('  ✅ Fast eligibility queries');
    console.log('  ✅ Controlled DB growth (TTL)');
    console.log('  ✅ Optimized job + gig queries');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await mongoose.connection.close();
    process.exit(0);

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  }
}

setupCriticalIndexes();