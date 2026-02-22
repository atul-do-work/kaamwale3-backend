const Withdrawal = require('../models/Withdrawal');
const { sendOpsAlert } = require('../utils/opsAlert');

async function runWalletReconciliation() {
  const staleMinutes = Number(process.env.WALLET_RECON_STALE_MINUTES || 60);
  const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);

  const stuck = await Withdrawal.find({
    status: { $in: ['initiated', 'processing'] },
    updatedAt: { $lt: cutoff },
  }).limit(500);

  for (const row of stuck) {
    row.retryCount = Number(row.retryCount || 0) + 1;
    row.reconciledAt = new Date();
    row.status = 'processing';
    await row.save();
  }

  if (stuck.length > 0) {
    await sendOpsAlert('Stuck withdrawals detected', { count: stuck.length, staleMinutes });
  }

  return { checked: stuck.length };
}

function startWalletReconciliationScheduler() {
  const enabled = String(process.env.WALLET_RECON_ENABLED || 'true') === 'true';
  if (!enabled) return;

  const intervalMs = Number(process.env.WALLET_RECON_INTERVAL_MS || 24 * 60 * 60 * 1000);
  setInterval(async () => {
    try {
      const result = await runWalletReconciliation();
      console.log(`[wallet-recon] completed, checked=${result.checked}`);
    } catch (err) {
      console.error('[wallet-recon] failed:', err && err.message);
    }
  }, intervalMs);

  console.log(`[wallet-recon] scheduler started (${intervalMs}ms)`);
}

module.exports = { runWalletReconciliation, startWalletReconciliationScheduler };
