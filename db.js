const Database = require('better-sqlite3');
const path = require('path');

// The SQLite file needs to live on a persistent disk in production — on
// Render/Railway this means attaching a persistent volume and pointing
// DATABASE_PATH at a file inside it. Without that, a redeploy wipes the file
// just like the old in-memory Maps did (see README).
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, 'dataflow.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // better concurrent read/write behavior

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    referral_code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL UNIQUE,
    network TEXT NOT NULL,
    wallet_balance REAL NOT NULL DEFAULT 0,
    total_sales INTEGER NOT NULL DEFAULT 0,
    markup_percent REAL NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    paystack_recipient_code TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS purchases (
    reference TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    phone TEXT NOT NULL,
    capacity TEXT NOT NULL,
    cost_price REAL NOT NULL,
    base_price REAL NOT NULL,
    agent_markup REAL NOT NULL DEFAULT 0,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    ref TEXT,
    icekash_reference TEXT,
    delivery_error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    referral_code TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS withdrawals (
    reference TEXT PRIMARY KEY,
    referral_code TEXT NOT NULL,
    amount REAL NOT NULL,
    status TEXT NOT NULL,
    paystack_transfer_code TEXT,
    created_at TEXT NOT NULL
  );
`);

// ---------- agents ----------

function toAgentObject(row) {
  if (!row) return null;
  return {
    referralCode: row.referral_code,
    name: row.name,
    phone: row.phone,
    network: row.network,
    walletBalance: row.wallet_balance,
    totalSales: row.total_sales,
    markupPercent: row.markup_percent,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    paystackRecipientCode: row.paystack_recipient_code,
    createdAt: row.created_at,
  };
}

const stmts = {
  insertAgent: db.prepare(`
    INSERT INTO agents (referral_code, name, phone, network, wallet_balance, total_sales,
      markup_percent, password_hash, password_salt, created_at)
    VALUES (@referralCode, @name, @phone, @network, 0, 0, @markupPercent, @passwordHash, @passwordSalt, @createdAt)
  `),
  getAgentByCode: db.prepare('SELECT * FROM agents WHERE referral_code = ?'),
  getAgentByPhone: db.prepare('SELECT * FROM agents WHERE phone = ?'),
  updateMarkup: db.prepare('UPDATE agents SET markup_percent = ? WHERE referral_code = ?'),
  creditWallet: db.prepare(`
    UPDATE agents SET wallet_balance = wallet_balance + ?, total_sales = total_sales + 1
    WHERE referral_code = ?
  `),
  zeroWallet: db.prepare('UPDATE agents SET wallet_balance = 0 WHERE referral_code = ?'),
  refundWallet: db.prepare('UPDATE agents SET wallet_balance = wallet_balance + ? WHERE referral_code = ?'),
  setRecipientCode: db.prepare('UPDATE agents SET paystack_recipient_code = ? WHERE referral_code = ?'),
};

function createAgent(agent) {
  stmts.insertAgent.run(agent);
  return getAgentByCode(agent.referralCode);
}

function getAgentByCode(code) {
  return toAgentObject(stmts.getAgentByCode.get(String(code).toUpperCase()));
}

function getAgentByPhone(phone) {
  return toAgentObject(stmts.getAgentByPhone.get(phone));
}

function updateAgentMarkup(code, markupPercent) {
  stmts.updateMarkup.run(markupPercent, code);
}

function creditAgentWallet(code, amount) {
  stmts.creditWallet.run(amount, code);
}

function zeroAgentWallet(code) {
  stmts.zeroWallet.run(code);
}

function refundAgentWallet(code, amount) {
  stmts.refundWallet.run(amount, code);
}

function setAgentRecipientCode(code, recipientCode) {
  stmts.setRecipientCode.run(recipientCode, code);
}

// ---------- purchases ----------

const purchaseStmts = {
  insert: db.prepare(`
    INSERT INTO purchases (reference, network, phone, capacity, cost_price, base_price,
      agent_markup, amount, status, ref, created_at)
    VALUES (@reference, @network, @phone, @capacity, @costPrice, @basePrice,
      @agentMarkup, @amount, @status, @ref, @createdAt)
  `),
  get: db.prepare('SELECT * FROM purchases WHERE reference = ?'),
  setStatus: db.prepare('UPDATE purchases SET status = ?, delivery_error = ? WHERE reference = ?'),
  setIcekashReference: db.prepare('UPDATE purchases SET icekash_reference = ?, status = ? WHERE reference = ?'),
};

function toPurchaseObject(row) {
  if (!row) return null;
  return {
    reference: row.reference,
    network: row.network,
    phone: row.phone,
    capacity: row.capacity,
    costPrice: row.cost_price,
    basePrice: row.base_price,
    agentMarkup: row.agent_markup,
    amount: row.amount,
    status: row.status,
    ref: row.ref,
    icekashReference: row.icekash_reference,
    deliveryError: row.delivery_error,
    createdAt: row.created_at,
  };
}

function createPurchase(p) {
  purchaseStmts.insert.run({ ...p, createdAt: new Date().toISOString() });
}

function getPurchase(reference) {
  return toPurchaseObject(purchaseStmts.get.get(reference));
}

function setPurchaseStatus(reference, status, deliveryError = null) {
  purchaseStmts.setStatus.run(status, deliveryError, reference);
}

function setPurchaseIcekashReference(reference, icekashReference, status) {
  purchaseStmts.setIcekashReference.run(icekashReference, status, reference);
}

// ---------- sessions ----------

const sessionStmts = {
  insert: db.prepare('INSERT INTO sessions (token, referral_code, expires_at) VALUES (?, ?, ?)'),
  get: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  delete: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

function createSessionRow(token, referralCode, expiresAt) {
  sessionStmts.insert.run(token, referralCode, expiresAt);
}

function getSession(token) {
  const row = sessionStmts.get.get(token);
  if (!row) return null;
  return { referralCode: row.referral_code, expiresAt: row.expires_at };
}

function deleteSession(token) {
  sessionStmts.delete.run(token);
}

// Housekeeping: clear expired sessions periodically so the table doesn't
// grow forever. Cheap enough to run on an interval for this scale.
setInterval(() => sessionStmts.deleteExpired.run(Date.now()), 60 * 60 * 1000);

// ---------- withdrawals ----------

const withdrawalStmts = {
  insert: db.prepare(`
    INSERT INTO withdrawals (reference, referral_code, amount, status, paystack_transfer_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  setStatus: db.prepare('UPDATE withdrawals SET status = ?, paystack_transfer_code = ? WHERE reference = ?'),
  getByReference: db.prepare('SELECT * FROM withdrawals WHERE reference = ?'),
  getByTransferCode: db.prepare('SELECT * FROM withdrawals WHERE paystack_transfer_code = ?'),
};

function createWithdrawal(reference, referralCode, amount, status, transferCode = null) {
  withdrawalStmts.insert.run(reference, referralCode, amount, status, transferCode, new Date().toISOString());
}

function setWithdrawalStatus(reference, status, transferCode = null) {
  withdrawalStmts.setStatus.run(status, transferCode, reference);
}

function getWithdrawalByTransferCode(transferCode) {
  const row = withdrawalStmts.getByTransferCode.get(transferCode);
  if (!row) return null;
  return { reference: row.reference, referralCode: row.referral_code, amount: row.amount, status: row.status };
}

module.exports = {
  createAgent, getAgentByCode, getAgentByPhone, updateAgentMarkup,
  creditAgentWallet, zeroAgentWallet, refundAgentWallet, setAgentRecipientCode,
  createPurchase, getPurchase, setPurchaseStatus, setPurchaseIcekashReference,
  createSessionRow, getSession, deleteSession,
  createWithdrawal, setWithdrawalStatus, getWithdrawalByTransferCode,
};
