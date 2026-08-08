require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const app = express();
app.use(helmet());
app.set('trust proxy', 1); // needed for correct rate-limit/IP handling behind Render/Railway's proxy

// Webhook route needs the raw body for signature verification, so capture it
// before the normal JSON parser runs.
app.use('/api/webhook/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const allowedOrigins = [
  allowedOrigin,
  'https://data-flow-black.vercel.app',
  'https://data-flow-admin.vercel.app',
  'https://dataflow-gh.netlify.app'
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
  }
}));

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE = 'https://api.paystack.co';

// --- IceKash Consult: bundle delivery provider ---
const ICEKASH_BASE_URL = 'https://www.icekashconsult.com/api/v1';
const ICEKASH_API_KEY = process.env.ICEKASH_API_KEY;

const icekash = axios.create({
  baseURL: ICEKASH_BASE_URL,
  headers: { 'x-api-key': ICEKASH_API_KEY },
});

// Map our network names to the provider codes Paystack expects — the same
// codes are used both for charging a customer (mobile_money.provider) and
// for creating a transfer recipient (bank_code) when paying an agent out.
const PAYSTACK_NETWORK_CODE = {
  MTN: 'mtn',
  Telecel: 'vod', // Paystack still uses the legacy Vodafone code for Telecel Cash
  AirtelTigo: 'atl',
};
const PAYSTACK_TRANSFER_BANK_CODE = {
  MTN: 'MTN',
  Telecel: 'VOD',
  AirtelTigo: 'ATL',
};

// --- Rate limiting on sensitive endpoints ---
// Generous enough for normal use, tight enough to blunt scripted abuse.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again in a few minutes.' },
});
const purchaseLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many purchase attempts. Please slow down and try again shortly.' },
});
const withdrawLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many withdrawal attempts. Please try again later.' },
});

// Your own margin over IceKash's cost, applied to EVERY sale — direct or via agent.
// The env var is only the initial default — the admin dashboard can change the
// live value at any time and it's persisted in the settings table.
const ENV_PLATFORM_MARKUP_PERCENT = parseFloat(process.env.PLATFORM_MARKUP_PERCENT || '30');

// Suggested starting markup for a newly registered agent. They can change it later.
const ENV_DEFAULT_AGENT_MARKUP_PERCENT = parseFloat(process.env.DEFAULT_AGENT_MARKUP_PERCENT || '25');

// Live values: prefer what the admin saved in the settings table, fall back
// to the environment defaults if nothing has been saved yet.
function getPlatformMarkupPercent() {
  const stored = parseFloat(db.getSetting('platform_markup_percent'));
  // Use default (30%) if not set or if currently 0 (as requested)
  if (Number.isNaN(stored) || stored === 0) return ENV_PLATFORM_MARKUP_PERCENT;
  return stored;
}

function getDefaultAgentMarkupPercent() {
  const stored = parseFloat(db.getSetting('default_agent_markup_percent'));
  // Use default (25%) if not set or if currently 0 (as requested)
  if (Number.isNaN(stored) || stored === 0) return ENV_DEFAULT_AGENT_MARKUP_PERCENT;
  return stored;
}

// Sane bounds so an agent can't set something absurd (0% = no profit, 100% = doubling the price)
const AGENT_MARKUP_MIN = 0;
const AGENT_MARKUP_MAX = 100;

// --- Admin authentication ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Gist_zone@blogger1';
const ADMIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let adminSessions = {};

function createAdminSession() {
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions[token] = Date.now() + ADMIN_SESSION_TTL_MS;
  return token;
}

function verifyAdminSession(token) {
  if (!token || !adminSessions[token]) return false;
  if (adminSessions[token] < Date.now()) {
    delete adminSessions[token];
    return false;
  }
  return true;
}

/**
 * Verifies the admin session token.
 */
function requireAdminSession(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  
  if (!verifyAdminSession(token)) {
    return res.status(401).json({ error: 'Admin access required. Please log in.' });
  }
  next();
}

function generateReferralCode(name) {
  const base = name.replace(/[^a-zA-Z]/g, '').slice(0, 5).toUpperCase() || 'AGENT';
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${base}-${suffix}`;
}

// --- Agent authentication ---
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function createSession(referralCode) {
  const token = crypto.randomBytes(24).toString('hex');
  db.createSessionRow(token, referralCode, Date.now() + SESSION_TTL_MS);
  return token;
}

/**
 * Verifies the Authorization: Bearer <token> header belongs to a live
 * session for the agent code in the URL. Returns the agent record on
 * success, or sends a 401 and returns null on failure.
 */
function requireAgentSession(req, res, code) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const session = token ? db.getSession(token) : null;

  if (!session || session.expiresAt < Date.now() || session.referralCode !== code.toUpperCase()) {
    res.status(401).json({ error: 'Please log in to access this account.' });
    return null;
  }

  const agent = db.getAgentByCode(session.referralCode);
  if (!agent) {
    res.status(401).json({ error: 'Please log in to access this account.' });
    return null;
  }
  return agent;
}

/**
 * The pricing stack for any given sale:
 *   costPrice   — what IceKash actually charges you
 *   basePrice   — costPrice + your platform markup (what a direct customer pays)
 *   finalPrice  — basePrice + the agent's own markup, if bought via an agent's link
 *   agentMarkup — the cedi amount that's the agent's profit (finalPrice - basePrice)
 * Your platform's own margin (basePrice - costPrice) is kept on every sale
 * regardless of whether an agent is involved.
 */
function computePricing(costPrice, agent) {
  const basePrice = Number((costPrice * (1 + getPlatformMarkupPercent() / 100)).toFixed(2));

  if (!agent) {
    return { costPrice, basePrice, finalPrice: basePrice, agentMarkup: 0 };
  }

  const finalPrice = Number((basePrice * (1 + agent.markupPercent / 100)).toFixed(2));
  const agentMarkup = Number((finalPrice - basePrice).toFixed(2));
  return { costPrice, basePrice, finalPrice, agentMarkup };
}

// --- IceKash package cache ---
// IceKash sells fixed packages (e.g. exactly "1GB" at a fixed price) — not an
// arbitrary GB amount at a per-GB rate. We cache their list and always use
// THEIR price, never our own computed one, so what we charge always matches
// what IceKash actually bills.
let packagesCache = { data: [], fetchedAt: 0 };
const PACKAGES_CACHE_MS = 5 * 60 * 1000; // 5 minutes

async function getPackages() {
  const isStale = Date.now() - packagesCache.fetchedAt > PACKAGES_CACHE_MS;
  if (!isStale && packagesCache.data.length) {
    // Apply overrides even to cached data
    return packagesCache.data.map(p => {
      const id = `${p.network}-${p.capacity}`.toLowerCase().replace(/\s+/g, '-');
      const override = db.getSetting(`price_override_${id}`);
      if (override) p.price = parseFloat(override);
      return p;
    });
  }

  const { data } = await icekash.get('/packages');
  const packages = data.packages.map(p => {
    const id = `${p.network}-${p.capacity}`.toLowerCase().replace(/\s+/g, '-');
    const override = db.getSetting(`price_override_${id}`);
    if (override) p.price = parseFloat(override);
    return p;
  });

  packagesCache = { data: packages, fetchedAt: Date.now() };
  return packagesCache.data;
}

async function findPackage(network, capacity) {
  const packages = await getPackages();
  return packages.find(p => p.network === network && p.capacity === capacity);
}

/**
 * Confirms the IceKash key is valid and reachable — call this once at startup
 * and it's also exposed at GET /api/provider/status for a manual check.
 */
async function checkIcekashConnection() {
  const { data } = await icekash.get('/ping');
  return data; // { ok: true, owner: "uuid" }
}

/**
 * Current IceKash account balance — the wallet that funds bundle deliveries.
 * Exposed at GET /api/provider/balance so you can keep an eye on it without
 * logging into IceKash's dashboard separately.
 */
async function getIcekashBalance() {
  const { data } = await icekash.get('/balance');
  return data; // { balance: 12.50, currency: "GHS" }
}

/**
 * Kicks off a real bundle purchase against IceKash. Returns their reference
 * and initial status (usually "processing" — not delivered yet).
 */
async function purchaseFromIcekash({ network, phone, capacity, reference }) {
  const { data } = await icekash.post('/purchase', {
    network,
    phoneNumber: phone,
    capacity,
    reference,
  });
  return data; // { reference, status: "processing", price, balance }
}

/**
 * IceKash purchases don't complete instantly — the purchase call returns
 * "processing", so we poll /order-status until it flips to "completed"
 * (or something clearly terminal) before telling the customer it's delivered.
 */
async function pollIcekashOrder(icekashReference, ourReference, attempts = 0) {
  const record = db.getPurchase(ourReference);
  if (!record) return;

  if (attempts > 15) { // ~1 minute of polling at 4s intervals
    db.setPurchaseStatus(ourReference, 'payment_ok_delivery_pending');
    return;
  }

  try {
    const { data } = await icekash.get(`/order-status/${icekashReference}`);

    if (data.status === 'completed') {
      db.setPurchaseStatus(ourReference, 'delivered');
      creditAgentCommission(record);
      return;
    }

    if (data.status === 'failed' || data.status === 'cancelled') {
      db.setPurchaseStatus(ourReference, 'payment_ok_delivery_failed');
      return;
    }
  } catch (err) {
    console.error('order-status check failed:', err.response?.data || err.message);
  }

  setTimeout(() => pollIcekashOrder(icekashReference, ourReference, attempts + 1), 4000);
}

/**
 * Credits the referring agent's wallet with their markup profit on this sale.
 * Split out so both the real IceKash flow and the mock-mode flow use the same logic.
 */
function creditAgentCommission(record) {
  if (!record.ref || !record.agentMarkup) return;
  db.creditAgentWallet(record.ref, record.agentMarkup);
}

/**
 * Starts bundle delivery for a paid-for purchase. In mock mode (no API key
 * set) it delivers instantly for easy local testing; in live mode it calls
 * IceKash and hands off to the polling loop above.
 */
async function deliverBundle(record, ourReference) {
  if (!ICEKASH_API_KEY) {
    console.log(`[MOCK DELIVERY] ${record.capacity} ${record.network} bundle sent to ${record.phone}`);
    db.setPurchaseStatus(ourReference, 'delivered');
    creditAgentCommission(record);
    return;
  }

  const result = await purchaseFromIcekash({
    network: record.network,
    phone: record.phone,
    capacity: record.capacity,
    reference: ourReference,
  });

  db.setPurchaseIcekashReference(ourReference, result.reference, 'processing_delivery');
  pollIcekashOrder(result.reference, ourReference); // runs in the background
}

/**
 * Creates (or reuses) a Paystack transfer recipient for this agent's Mobile
 * Money number, so we can pay them out. Recipients only need to be created
 * once per agent — the code is cached on their record afterward.
 */
async function getOrCreateTransferRecipient(agent) {
  if (agent.paystackRecipientCode) return agent.paystackRecipientCode;

  const { data } = await axios.post(
    `${PAYSTACK_BASE}/transferrecipient`,
    {
      type: 'mobile_money',
      name: agent.name,
      account_number: agent.phone,
      bank_code: PAYSTACK_TRANSFER_BANK_CODE[agent.network],
      currency: 'GHS',
    },
    { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
  );

  const recipientCode = data.data.recipient_code;
  db.setAgentRecipientCode(agent.referralCode, recipientCode);
  return recipientCode;
}

function sanitizeAgent(agent) {
  const { passwordHash, passwordSalt, paystackRecipientCode, ...safe } = agent;
  return safe;
}

/**
 * Agent signup — anyone can become a reselling agent. Returns a referral code
 * that becomes their personal shop link: yoursite.com?ref=CODE
 */
app.post('/api/agents/register', authLimiter, async (req, res) => {
  const { name, phone, network, markupPercent, password } = req.body;

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Enter your full name.' });
  }
  if (!phone || !/^0\d{9}$/.test(phone)) {
    return res.status(400).json({ error: 'Phone must be a 10-digit Ghana number starting with 0' });
  }
  if (!PAYSTACK_TRANSFER_BANK_CODE[network]) {
    return res.status(400).json({ error: 'Choose the network your Mobile Money account is on.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  if (db.getAgentByPhone(phone)) {
    return res.status(409).json({ error: 'That phone number is already registered. Please log in instead.' });
  }

  let initialMarkup = getDefaultAgentMarkupPercent();
  if (markupPercent !== undefined) {
    const parsed = parseFloat(markupPercent);
    if (!Number.isNaN(parsed) && parsed >= AGENT_MARKUP_MIN && parsed <= AGENT_MARKUP_MAX) {
      initialMarkup = parsed;
    }
  }

  const referralCode = generateReferralCode(name);
  const passwordSalt = crypto.randomBytes(16).toString('hex');

  try {
    db.createAgent({
      referralCode,
      name: name.trim(),
      phone,
      network,
      markupPercent: initialMarkup,
      passwordHash: hashPassword(password, passwordSalt),
      passwordSalt,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Covers a race where two requests with the same phone land at once
    return res.status(409).json({ error: 'That phone number is already registered. Please log in instead.' });
  }

  const token = createSession(referralCode);
  res.json({ referralCode, markupPercent: initialMarkup, token });
});

/**
 * Agent login — verifies referral code + password, returns a session token
 * the frontend attaches as "Authorization: Bearer <token>" on every
 * subsequent dashboard request.
 */
app.post('/api/agents/login', authLimiter, (req, res) => {
  const { referralCode, password } = req.body;
  const agent = db.getAgentByCode(String(referralCode || ''));

  // Same error for "no such agent" and "wrong password" so a login attempt
  // can't be used to check which referral codes exist.
  const invalid = () => res.status(401).json({ error: 'Incorrect agent code or password.' });

  if (!agent || !password) return invalid();

  if (agent.status === 'suspended') {
    return res.status(403).json({ error: 'This agent account is suspended.' });
  }

  const attemptHash = hashPassword(password, agent.passwordSalt);
  const valid = crypto.timingSafeEqual(
    Buffer.from(attemptHash, 'hex'),
    Buffer.from(agent.passwordHash, 'hex')
  );
  if (!valid) return invalid();

  const token = createSession(agent.referralCode);
  res.json({ referralCode: agent.referralCode, token });
});

/**
 * Lets an agent change their own markup at any time — this is their price,
 * so they can raise or lower it as they see fit within the platform's bounds.
 */
app.patch('/api/agents/:code/markup', (req, res) => {
  const agent = requireAgentSession(req, res, req.params.code);
  if (!agent) return; // requireAgentSession already sent the 401 response

  const parsed = parseFloat(req.body.markupPercent);
  if (Number.isNaN(parsed) || parsed < AGENT_MARKUP_MIN || parsed > AGENT_MARKUP_MAX) {
    return res.status(400).json({ error: `Markup must be between ${AGENT_MARKUP_MIN} and ${AGENT_MARKUP_MAX}%` });
  }

  db.updateAgentMarkup(agent.referralCode, parsed);
  res.json({ referralCode: agent.referralCode, markupPercent: parsed });
});

/**
 * Agent dashboard — wallet balance, sales count, and markup for the logged-in
 * agent. Requires a valid session token from /api/agents/login.
 */
app.get('/api/agents/:code', (req, res) => {
  const agent = requireAgentSession(req, res, req.params.code);
  if (!agent) return;
  res.json(sanitizeAgent(agent));
});

/**
 * Withdraw commission from the agent wallet via a real Paystack Mobile Money
 * transfer. The wallet is zeroed once Paystack accepts the transfer
 * (status "pending" or "success"); if the transfer later fails, the webhook
 * handler below credits the money back automatically.
 */
app.post('/api/agents/:code/withdraw', withdrawLimiter, async (req, res) => {
  const agent = requireAgentSession(req, res, req.params.code);
  if (!agent) return;

  if (agent.walletBalance <= 0) {
    return res.status(400).json({ error: 'No balance to withdraw.' });
  }

  const amount = agent.walletBalance;
  const reference = `WD-${crypto.randomBytes(8).toString('hex')}`;

  try {
    const recipientCode = await getOrCreateTransferRecipient(agent);

    const { data } = await axios.post(
      `${PAYSTACK_BASE}/transfer`,
      {
        source: 'balance',
        amount: Math.round(amount * 100), // pesewas
        recipient: recipientCode,
        reason: 'DataFlow agent commission withdrawal',
        reference,
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const transferStatus = data.data.status; // "pending" | "success" | "otp"

    if (transferStatus === 'otp') {
      // Automated transfers require OTP confirmation to be disabled in the
      // Paystack dashboard (Settings → Preferences → Transfers). Until
      // that's done, transfers can't complete without manual OTP entry —
      // so don't touch the wallet and tell the operator what to fix.
      db.createWithdrawal(reference, agent.referralCode, amount, 'otp_required');
      return res.status(409).json({
        error: 'Payouts need one-time setup: disable "Confirm transfers before sending" in your Paystack dashboard (Settings → Preferences → Transfers) to allow automated withdrawals.',
      });
    }

    db.createWithdrawal(reference, agent.referralCode, amount, transferStatus, data.data.transfer_code);
    db.zeroAgentWallet(agent.referralCode);

    res.json({
      withdrawn: amount,
      status: transferStatus,
      agent: sanitizeAgent({ ...agent, walletBalance: 0 }),
    });
  } catch (err) {
    console.error('Withdrawal failed:', err.response?.data || err.message);
    res.status(502).json({ error: 'Could not start the payout. Please try again shortly.' });
  }
});

// --- Admin Routes ---

/**
 * POST /api/admin/login
 * Verifies admin password, returns a session token.
 */
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Enter your password.' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password.' });
  
  const token = createAdminSession();
  res.json({ token });
});

/**
 * GET /api/admin/stats
 * Returns platform-wide statistics.
 */
app.get('/api/admin/stats', requireAdminSession, (req, res) => {
  try {
    const agents = db.getAllAgents();
    const purchases = db.getAllPurchases();
    const delivered = purchases.filter(p => p.status === 'delivered' || p.status.includes('delivery'));
    
    const totalRevenue = delivered.reduce((sum, p) => sum + p.amount, 0);
    const totalCost = delivered.reduce((sum, p) => sum + p.costPrice, 0);
    const totalAgentPayout = delivered.reduce((sum, p) => sum + p.agentMarkup, 0);
    const platformProfit = totalRevenue - totalCost - totalAgentPayout;
    
    const activeAgents = agents.filter(a => a.status !== 'suspended').length;
    const today = new Date().toISOString().split('T')[0];
    const salesToday = delivered.filter(p => p.createdAt.startsWith(today)).length;
    
    res.json({
      totalRevenue: Number(totalRevenue.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
      totalAgentPayout: Number(totalAgentPayout.toFixed(2)),
      platformProfit: Number(platformProfit.toFixed(2)),
      totalSales: delivered.length, // Matching the dashboard's "Bundles sold"
      totalPurchases: purchases.length,
      activeAgents,
      salesToday
    });
  } catch (err) {
    res.status(500).json({ error: 'Could not load stats.' });
  }
});

/**
 * GET /api/admin/settings
 * Returns global platform settings.
 */
app.get('/api/admin/settings', requireAdminSession, (req, res) => {
  res.json({
    platformMarkupPercent: getPlatformMarkupPercent(),
    defaultAgentMarkupPercent: getDefaultAgentMarkupPercent()
  });
});

/**
 * POST/PATCH /api/admin/settings
 * Updates global platform settings and optionally applies them to all agents.
 */
const updateSettings = (req, res) => {
  const { platformMarkupPercent, defaultAgentMarkupPercent, applyToAllAgents } = req.body;

  if (platformMarkupPercent !== undefined) {
    const parsed = parseFloat(platformMarkupPercent);
    if (!Number.isNaN(parsed)) {
      db.setSetting('platform_markup_percent', parsed);
    }
  }

  if (defaultAgentMarkupPercent !== undefined) {
    const parsed = parseFloat(defaultAgentMarkupPercent);
    if (!Number.isNaN(parsed)) {
      db.setSetting('default_agent_markup_percent', parsed);
      
      if (applyToAllAgents) {
        const agents = db.getAllAgents();
        agents.forEach(agent => {
          db.updateAgentMarkup(agent.referralCode, parsed);
        });
      }
    }
  }

  res.json({
    platformMarkupPercent: getPlatformMarkupPercent(),
    defaultAgentMarkupPercent: getDefaultAgentMarkupPercent(),
    message: 'Settings updated successfully.'
  });
};

app.post('/api/admin/settings', requireAdminSession, updateSettings);
app.patch('/api/admin/settings', requireAdminSession, updateSettings);

/**
 * GET /api/admin/packages
 * Returns the list of all packages.
 */
app.get('/api/admin/packages', requireAdminSession, async (req, res) => {
  try {
    const rawPackages = await getPackages();
    const packages = rawPackages.map(p => ({
      id: `${p.network}-${p.capacity}`.toLowerCase().replace(/\s+/g, '-'),
      network: p.network,
      capacity: p.capacity,
      price: p.price
    }));
    res.json({ 
      packages,
      platformMarkupPercent: getPlatformMarkupPercent()
    });
  } catch (err) {
    res.status(502).json({ error: 'Could not fetch packages from provider.' });
  }
});

/**
 * GET /api/admin/agents
 * Returns the list of all agents for management.
 */
app.get('/api/admin/agents', requireAdminSession, (req, res) => {
  const agents = db.getAllAgents().map(sanitizeAgent);
  res.json({ agents });
});

/**
 * PATCH /api/admin/agents/:referralCode
 * Updates an agent's markup or status.
 */
app.patch('/api/admin/agents/:referralCode', requireAdminSession, (req, res) => {
  const { referralCode } = req.params;
  const { markupPercent, status } = req.body;
  
  const agent = db.getAgentByCode(referralCode);
  if (!agent) return res.status(404).json({ error: 'Agent not found.' });
  
  if (markupPercent !== undefined) {
    const parsed = parseFloat(markupPercent);
    if (Number.isNaN(parsed) || parsed < 0 || parsed > 100) {
      return res.status(400).json({ error: 'Markup must be between 0 and 100.' });
    }
    db.updateAgentMarkup(referralCode, parsed);
    agent.markupPercent = parsed;
  }
  
  if (status !== undefined) {
    if (status !== 'active' && status !== 'suspended') {
      return res.status(400).json({ error: 'Status must be active or suspended.' });
    }
    db.updateAgentStatus(referralCode, status);
    agent.status = status;
  }
  
  res.json(sanitizeAgent(agent));
});

/**
 * GET /api/admin/purchases
 * Returns recent orders.
 */
app.get('/api/admin/purchases', requireAdminSession, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const purchases = db.getRecentPurchases(limit);
    res.json({ purchases });
  } catch (err) {
    res.status(500).json({ error: 'Could not load purchases.' });
  }
});

// (Duplicate settings endpoints removed - reconciled above)

/**
 * Lets the frontend fetch the current package list with prices already
 * computed for whoever's asking: a plain visitor sees cost + your platform
 * markup, someone arriving via ?ref=CODE sees that agent's price on top.
 */
app.get('/api/packages', async (req, res) => {
  try {
    const rawPackages = await getPackages();

    let agent = null;
    if (req.query.ref) {
      agent = db.getAgentByCode(String(req.query.ref)) || null;
    }

    const packages = rawPackages.map(p => {
      const pricing = computePricing(p.price, agent);
      return {
        network: p.network,
        capacity: p.capacity,
        validity: p.validity,
        price: pricing.finalPrice,
      };
    });

    res.json({ packages });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach IceKash', detail: err.response?.data || err.message });
  }
});

/**
 * Step 1: Frontend calls this with the buyer's phone, network, and the exact
 * package capacity (e.g. "1GB") as listed by /api/packages. We look up
 * IceKash's own price for that package server-side — never trusting a price
 * sent from the browser — and kick off a Paystack Mobile Money charge for it.
 */
app.post('/api/purchase', purchaseLimiter, async (req, res) => {
  try {
    const { network, phone, paymentPhone, capacity, ref } = req.body;

    if (!phone || !/^0\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Data Receiver number must be a 10-digit Ghana number starting with 0' });
    }
    if (!paymentPhone || !/^0\d{9}$/.test(paymentPhone)) {
      return res.status(400).json({ error: 'Payment number must be a 10-digit Ghana number starting with 0' });
    }

    const pkg = await findPackage(network, capacity);
    if (!pkg) {
      return res.status(400).json({ error: `Unknown package: ${network} ${capacity}` });
    }

    // A referral code is optional — if present, it must belong to a real agent
    let agent = null;
    if (ref) {
      agent = db.getAgentByCode(String(ref)) || null;
      if (agent && agent.status === 'suspended') {
        agent = null; // Fallback to no-referral pricing for suspended agents
      }
    }

    const pricing = computePricing(pkg.price, agent);
    const amountCedis = pricing.finalPrice;
    const amountPesewas = Math.round(amountCedis * 100); // Paystack uses the smallest currency unit

    const intlPaymentPhone = paymentPhone.startsWith('0') 
      ? '+233' + paymentPhone.slice(1) 
      : paymentPhone;

    console.log('Initiating Paystack charge:', {
      email: `${paymentPhone}@dataflow-checkout.com`,
      amount: amountPesewas,
      currency: 'GHS',
      provider: PAYSTACK_NETWORK_CODE[network],
      phone: intlPaymentPhone,
      network,
    });

    const chargeResponse = await axios.post(
      `${PAYSTACK_BASE}/charge`,
      {
        email: `${paymentPhone}@dataflow-checkout.com`,
        amount: amountPesewas,
        currency: 'GHS',
        mobile_money: {
          phone: intlPaymentPhone,
          provider: PAYSTACK_NETWORK_CODE[network],
        },
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    console.log('Paystack charge response:', chargeResponse.data);

    if (!chargeResponse.data.data) {
      console.error('Invalid Paystack response structure:', chargeResponse.data);
      return res.status(500).json({ error: 'Invalid payment response from provider' });
    }

    const { reference, status, display_text } = chargeResponse.data.data;

    db.createPurchase({
      reference, network, phone, paymentPhone, capacity,
      costPrice: pricing.costPrice,
      basePrice: pricing.basePrice,
      agentMarkup: pricing.agentMarkup,
      amount: amountCedis,
      status: 'pending',
      ref: agent ? agent.referralCode : null,
      paymentNumber: null,
    });

    // Paystack Mobile Money charges usually require the customer to approve a
    // prompt on their phone (pay_offline), so we tell the frontend
    // to keep polling instead of assuming success immediately.
    // If Paystack requires OTP (send_otp / otp), we also inform the frontend.
    let finalInstructions = display_text;
    if (status === 'pay_offline' || status === 'pending') {
      finalInstructions = 'Check your phone for a payment prompt.';
      if (network === 'MTN') {
        finalInstructions += ' If no prompt appears, dial *170#, go to Wallet > My Approvals.';
      }
    } else if (status === 'success') {
      // Rare but possible for some test cards or specific flows
      await deliverBundle(db.getPurchase(reference), reference);
      finalInstructions = 'Payment successful! Delivering your data...';
    } else if (!finalInstructions) {
      finalInstructions = 'Processing payment...';
    }

    res.json({
      reference,
      amount: amountCedis,
      status: (status === 'send_otp' || status === 'otp') ? 'otp_required' : (status === 'success' ? 'processing_delivery' : status),
      instructions: finalInstructions,
    });
  } catch (err) {
    console.error('Paystack charge error:', err.response?.data || err.message);
  }
});

/**
 * Step 1b: Submit OTP for Paystack charges that require it.
 */
app.post('/api/purchase/:reference/submit-otp', purchaseLimiter, async (req, res) => {
  try {
    const { reference } = req.params;
    const { otp } = req.body;

    if (!otp) return res.status(400).json({ error: 'Please enter the OTP code.' });

    const record = db.getPurchase(reference);
    if (!record) return res.status(404).json({ error: 'Purchase not found.' });

    console.log(`Submitting OTP for reference ${reference}`);

    const otpResponse = await axios.post(
      `${PAYSTACK_BASE}/charge/submit_otp`,
      { otp, reference },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const { status, display_text } = otpResponse.data.data;
    console.log('Paystack OTP response:', otpResponse.data);

    if (status === 'success') {
      db.setPurchaseStatus(reference, 'payment_success');
      await deliverBundle(record, reference);
      return res.json({ status: 'success', message: 'Payment confirmed! Delivering data...' });
    } else if (status === 'pending' || status === 'processing') {
      return res.json({ status: 'pending', message: display_text || 'Payment is processing...' });
    } else {
      return res.status(400).json({ error: display_text || 'OTP verification failed. Please try again.' });
    }
  } catch (err) {
    console.error('OTP submission error:', err.response?.data || err.message);
    const msg = err.response?.data?.data?.display_text || err.response?.data?.message || 'Could not verify OTP.';
    res.status(400).json({ error: msg });
  }
});

/**
 * Step 2: Frontend polls this every few seconds until status is no longer "pending".
   * We also do a quick check against Paystack's API to see if the status has
   * changed, in case the webhook is delayed.
   */
  app.get('/api/purchase/:reference', async (req, res) => {
    const reference = req.params.reference;
    let record = db.getPurchase(reference);
    if (!record) return res.status(404).json({ error: 'Unknown reference' });

    // If the record is still pending, double-check with Paystack to be safe
    if (record.status === 'pending') {
      try {
        const { data } = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
          headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
        });

        if (data.data.status === 'success') {
          // Sync status and trigger delivery if it hasn't happened yet
          db.setPurchaseStatus(reference, 'processing_delivery');
          record = db.getPurchase(reference); // Refresh record
          await deliverBundle(record, reference);
        } else if (data.data.status === 'failed') {
          db.setPurchaseStatus(reference, 'failed');
          record = db.getPurchase(reference); // Refresh record
        }
      } catch (err) {
        // Verification failed, just return the local record
        console.error('Paystack verification failed during polling:', err.message);
      }
    }

    res.json(record);
  });

  /**
   * Step 2c: Frontend manually triggers a verification check.
   * This is used if the automatic prompt or webhook is delayed.
   */
  app.post('/api/purchase/:reference/verify', purchaseLimiter, async (req, res) => {
    const reference = req.params.reference;
    const { paymentNumber } = req.body;
    
    let record = db.getPurchase(reference);
    if (!record) return res.status(404).json({ error: 'Unknown reference' });

    // Store the payment number if provided
    if (paymentNumber) {
      db.setPurchasePaymentNumber(reference, paymentNumber);
    }

    try {
      const { data } = await axios.get(`${PAYSTACK_BASE}/transaction/verify/${reference}`, {
        headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
      });

      if (data.data.status === 'success') {
        if (record.status === 'pending' || record.status === 'failed') {
          db.setPurchaseStatus(reference, 'processing_delivery');
          record = db.getPurchase(reference);
          await deliverBundle(record, reference);
        }
      } else if (data.data.status === 'failed') {
        db.setPurchaseStatus(reference, 'failed');
        record = db.getPurchase(reference);
      }
    } catch (err) {
      console.error('Manual verification failed:', err.message);
    }

    res.json(db.getPurchase(reference));
  });

/**
 * Step 2b: Frontend submits the OTP code that Paystack sent to the customer's phone.
 * Paystack then validates the code and completes the charge.
 */
app.post('/api/purchase/:reference/otp', purchaseLimiter, async (req, res) => {
  const { otp } = req.body;
  const reference = req.params.reference;

  if (!otp || otp.trim().length === 0) {
    return res.status(400).json({ error: 'Enter the OTP code.' });
  }

  const record = db.getPurchase(reference);
  if (!record) {
    return res.status(404).json({ error: 'Purchase not found.' });
  }

  try {
    // Submit the OTP to Paystack to complete the charge
    const otpResponse = await axios.post(
      `${PAYSTACK_BASE}/charge/submit_otp`,
      {
        reference,
        otp: otp.trim(),
      },
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } }
    );

    const { status } = otpResponse.data.data;

    // Store the OTP code for debugging/audit
    db.setPurchaseOtpCode(reference, otp.trim());

    // If OTP was accepted, Paystack will send a charge.success webhook
    // For now, just tell the frontend to keep polling
    if (status === 'success') {
      db.setPurchaseStatus(reference, 'pending');
      return res.json({
        reference,
        status: 'otp_accepted',
        instructions: 'OTP accepted — processing your payment...',
      });
    }

    // If still pending, tell frontend to keep polling
    res.json({
      reference,
      status: 'pending',
      instructions: 'Verifying OTP...',
    });
  } catch (err) {
    console.error('OTP submission failed:', err.response?.data || err.message);

    // Common Paystack OTP errors
    const paystackError = err.response?.data?.message || err.message;
    if (paystackError && (paystackError.includes('Invalid OTP') || paystackError.toLowerCase().includes('otp'))) {
      return res.status(400).json({ error: 'Invalid OTP. Please try again.' });
    }
    if (paystackError && paystackError.includes('expired')) {
      return res.status(400).json({ error: 'OTP has expired. Please start a new payment.' });
    }

    res.status(500).json({ error: 'Could not verify OTP. Please try again.' });
  }
});

/**
 * Paystack calls this automatically on charge and transfer events. This is
 * the reliable way to know something actually happened — never trust the
 * frontend alone.
 */
app.post('/api/webhook/paystack', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET_KEY)
    .update(req.body)
    .digest('hex');

  if (hash !== signature) {
    return res.status(401).send('Invalid signature');
  }

  const event = JSON.parse(req.body);

  if (event.event === 'charge.success') {
    const { reference } = event.data;
    const record = db.getPurchase(reference);

    if (record && record.status === 'pending') {
      try {
        await deliverBundle(record, reference);
      } catch (err) {
        console.error('Bundle delivery failed:', err.response?.data || err.message);
        db.setPurchaseStatus(reference, 'payment_ok_delivery_failed', err.response?.data?.error || err.message);
      }
    }
  }

  if (event.event === 'charge.failed') {
    const { reference } = event.data;
    if (db.getPurchase(reference)) {
      db.setPurchaseStatus(reference, 'failed');
    }
  }

  // If a payout we already deducted from an agent's wallet ultimately fails
  // or gets reversed, credit the money back — the agent shouldn't lose their
  // commission just because Paystack or their Mobile Money provider couldn't
  // complete the transfer.
  if (event.event === 'transfer.failed' || event.event === 'transfer.reversed') {
    const transferCode = event.data.transfer_code;
    const withdrawal = db.getWithdrawalByTransferCode(transferCode);
    if (withdrawal && withdrawal.status !== 'failed' && withdrawal.status !== 'reversed') {
      db.refundAgentWallet(withdrawal.referralCode, withdrawal.amount);
      db.setWithdrawalStatus(withdrawal.reference, event.event === 'transfer.failed' ? 'failed' : 'reversed', transferCode);
    }
  }

  if (event.event === 'transfer.success') {
    const transferCode = event.data.transfer_code;
    const withdrawal = db.getWithdrawalByTransferCode(transferCode);
    if (withdrawal) {
      db.setWithdrawalStatus(withdrawal.reference, 'success', transferCode);
    }
  }

  res.sendStatus(200);
});



app.get('/health', (req, res) => res.json({ ok: true }));

/**
 * Manual check that the IceKash key is valid and the account is reachable.
 */
app.get('/api/provider/status', async (req, res) => {
  try {
    const data = await checkIcekashConnection();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach IceKash', detail: err.response?.data || err.message });
  }
});

/**
 * Current IceKash wallet balance, so you can monitor funds without logging
 * into their dashboard separately.
 */
app.get('/api/provider/balance', async (req, res) => {
  try {
    const data = await getIcekashBalance();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not reach IceKash', detail: err.response?.data || err.message });
  }
});

const PORT = process.env.PORT || 4000;

// Fail loudly on startup if required secrets are missing, rather than
// discovering it from a customer's failed payment.
const REQUIRED_ENV = ['PAYSTACK_SECRET_KEY'];
const missing = REQUIRED_ENV.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

app.listen(PORT, async () => {
  console.log(`DataFlow backend running on port ${PORT}`);

  if (ICEKASH_API_KEY) {
    try {
      const status = await checkIcekashConnection();
      console.log(`IceKash connected — owner: ${status.owner}`);
    } catch (err) {
      console.error('IceKash connection check failed:', err.response?.data || err.message);
    }
  } else {
    console.log('ICEKASH_API_KEY not set — bundle delivery running in mock mode.');
  }
});
