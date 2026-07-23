# Deploying DataFlow

Two separate pieces: the **frontend** (dataflow.html — what customers see) and the
**backend** (dataflow-backend/ — handles payment + data delivery). Deploy the
backend first so you have a URL to point the frontend at.

## 1. Backend (Render, free tier works)

1. Create a Paystack account at https://dashboard.paystack.com and grab your
   **Test Secret Key** from Settings → API Keys & Webhooks.
2. Put the `dataflow-backend` folder in its own GitHub repo (or a subfolder of one).
3. Go to https://render.com → New → Web Service → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. Under Environment, add:
   - `PAYSTACK_SECRET_KEY` = your Paystack secret key
   - `ALLOWED_ORIGIN` = your frontend's URL (fill in after step 2 below)
5. Deploy. Render gives you a URL like `https://dataflow-backend.onrender.com`.
6. Back in Paystack dashboard → Settings → API Keys & Webhooks, set the webhook
   URL to `https://dataflow-backend.onrender.com/api/webhook/paystack`.
   This is how the server finds out a payment actually succeeded.

Railway (https://railway.app) works the same way if you'd rather use that.

## 2. Frontend (Netlify)

1. Open `dataflow.html` and near the top of the `<script>` tag, before the
   line `const API_BASE = ...`, add:
   ```html
   <script>window.DATAFLOW_API_BASE = "https://dataflow-backend.onrender.com";</script>
   ```
   using your actual Render URL from step 1.
2. Go to https://app.netlify.com/drop and drag `dataflow.html` in.
3. Netlify gives you a live URL immediately — no build step needed since it's
   a single static file.
4. Go back to Render and update `ALLOWED_ORIGIN` to this Netlify URL, so the
   backend accepts requests from it (CORS).

## 3. Test it

Use a Paystack **test** Mobile Money number (listed in their docs under
Ghana test cards/numbers) so you don't get charged for real. Once that works
end-to-end, swap the Paystack key for your **live** key and go through their
account activation (KYC) before taking real payments.

## 4. Data bundle delivery — IceKash Consult (complete)

`deliverBundle()` in `dataflow-backend/index.js` now performs a real purchase
against IceKash Consult (`https://www.icekashconsult.com/api/v1`):

- `GET /api/packages` — proxies IceKash's live package list to the frontend,
  so the bundle picker only ever shows real packages at IceKash's real prices
  (cached 5 minutes to avoid hammering their API on every page load)
- `POST /api/purchase` — looks up the exact package price from that cache
  server-side (never trusts a price from the browser), charges it via
  Paystack, then on payment success calls IceKash's `/purchase` endpoint
- Because IceKash returns `"processing"` rather than an instant "done", the
  server polls `GET /order-status/:reference` every 4 seconds (up to ~1
  minute) until it sees `"completed"`, then marks the order delivered and
  credits any referring agent's commission

Known IceKash error responses are surfaced back to the customer/agent rather
than silently failing:
- `Insufficient wallet balance` — your IceKash wallet needs topping up; check
  `GET /api/provider/balance`
- `Duplicate order, please wait 1 minute` — can happen if a customer double-taps
  "Buy"; the current code doesn't retry automatically, so watch for this in logs
- `Unknown package` — the picker only shows packages IceKash currently lists,
  so this should be rare, but the cache being briefly stale (5 min) could
  cause it right after IceKash changes their catalog

Set `ICEKASH_API_KEY` in your Render environment variables (see `.env.example`).
Without it, the server runs in mock mode (instant fake delivery) for local testing.


## 5. Pricing: platform markup + agent markup

Every sale is priced in three layers:

1. **Cost price** — what IceKash actually charges you for the package
2. **Base price** — cost + `PLATFORM_MARKUP_PERCENT` (10% by default). This is
   what a customer pays when they buy directly, with no agent involved. You
   keep this margin on every single sale.
3. **Final price** — if the sale came through an agent's link (`?ref=CODE`),
   their own markup is added on top of the base price. That extra amount is
   entirely theirs — credited to their wallet once the bundle is delivered.

So on a referred sale: you keep the base markup, the agent keeps their own
markup, and the customer pays cost + both markups combined.

Agents set their own markup at signup (defaulting to
`DEFAULT_AGENT_MARKUP_PERCENT`, 15%) and can change it anytime via
`PATCH /api/agents/:code/markup` — the frontend's agent dashboard has a
control for this. It's bounded between 0% and 100% in the code
(`AGENT_MARKUP_MIN` / `AGENT_MARKUP_MAX` in `index.js`) so an agent can't set
something absurd; adjust those constants if you want a different range.

`GET /api/packages?ref=CODE` returns prices already computed for that
specific agent, so their shop link always shows their real price — not the
base price.

## 6. Agent / reselling feature

Anyone can sign up as an agent from the "Become an agent" section and gets a
shop link like `yoursite.com?ref=THEIR-CODE`. Purchases made through that link
credit the agent's own markup (see pricing section above) to their wallet
once the bundle is delivered.

"Withdraw to Mobile Money" now performs a **real Paystack Transfer** — see
section 8 below for exactly how it works and what you need to configure
before it can send money.

## 7. Agent login

Agents set a password at signup and must log in (`POST /api/agents/login`)
to see their wallet, change their markup, or withdraw. `GET /api/agents/:code`,
`PATCH /api/agents/:code/markup`, and `POST /api/agents/:code/withdraw` all
require a valid session token in an `Authorization: Bearer <token>` header.

How it works in `index.js`:
- Passwords are hashed with Node's built-in `scrypt` plus a per-agent random
  salt — never stored in plain text, never sent back to the client.
- A successful register or login returns a session token, stored in the
  `sessions` table for 24 hours (`SESSION_TTL_MS`).
- `requireAgentSession()` checks that token on every protected route.

One deliberate simplification: the frontend keeps the session token in a JS
variable only (no localStorage/cookies), so agents are logged out on every
page refresh. If you want "stay logged in," that's a cookie-based session
(with `httpOnly` + `secure` flags) or a refresh-token flow — worth doing
properly rather than bolting on localStorage.

## 8. Real Mobile Money payouts (Paystack Transfers)

Withdrawals now call Paystack's Transfers API for real:

1. **One-time setup in your Paystack dashboard**: go to Settings →
   Preferences → Transfers, and **uncheck "Confirm transfers before
   sending"**. Without this, every transfer needs a manual OTP typed into
   Paystack's dashboard, and the API call in `index.js` will come back with
   `status: "otp"` — the withdraw endpoint detects this and returns a clear
   error telling the agent (and you, in the logs) what to fix, without
   touching their wallet.
2. **Fund your Paystack balance.** Transfers pay out of your Paystack
   balance (`source: "balance"`), not your bank account directly — top up
   via Paystack's dashboard.
3. Add a **transfer webhook**: the same webhook URL you already set up for
   charges (`/api/webhook/paystack`) also handles `transfer.success`,
   `transfer.failed`, and `transfer.reversed` events — no separate URL
   needed, Paystack sends all event types to one webhook.

What the code does, in `index.js`:
- `getOrCreateTransferRecipient()` creates a Paystack "transfer recipient"
  for an agent's Mobile Money number on first withdrawal (using the network
  they picked at signup), and caches the recipient code on their record so
  it's only created once.
- The wallet is zeroed as soon as Paystack accepts the transfer (status
  `pending` or `success`) — this matches how Paystack transfers actually
  behave (they're asynchronous).
- If a transfer later fails or is reversed, the webhook handler
  automatically credits the agent's wallet back via `refundAgentWallet()` —
  so a failed payout doesn't cost the agent their commission.
- Every withdrawal is recorded in the `withdrawals` table with its Paystack
  transfer code, so you can always look up what happened to a specific payout.

## 9. Database (SQLite)

Agents, purchases, sessions, and withdrawals are now stored in SQLite via
`db.js` (using `better-sqlite3`), replacing the earlier in-memory Maps that
reset on every restart.

**Important for deployment:** SQLite is a single file on disk
(`DATABASE_PATH` in `.env`). On Render or Railway, the filesystem is
**ephemeral by default** — a redeploy wipes it just like the old in-memory
version did, unless you attach a **persistent disk/volume** and point
`DATABASE_PATH` at a file inside it:
- **Render**: Add a Disk under your service's settings, mount it at e.g.
  `/data`, and set `DATABASE_PATH=/data/dataflow.db`.
- **Railway**: Add a Volume, mount it the same way.

If your user base grows enough that a single SQLite file becomes a
bottleneck (many concurrent writes), migrating to Postgres is the natural
next step — `db.js` isolates all the storage logic in one file, so that
migration touches one file, not the rest of the app.

## 10. Security hardening for public launch

- **Helmet** is enabled, adding standard security headers (HSTS, disabling
  MIME-sniffing, etc.) with sensible defaults for an API.
- **Rate limiting** is applied per-IP on the endpoints most worth protecting:
  - Registration/login: 10 attempts per 15 minutes
  - Purchases: 20 per 10 minutes
  - Withdrawals: 5 per hour
  Adjust the numbers in `index.js` (`authLimiter`, `purchaseLimiter`,
  `withdrawLimiter`) if they're too strict or too loose for your real traffic.
- The server now **fails fast on startup** if `PAYSTACK_SECRET_KEY` is
  missing, rather than silently running until the first customer hits a
  broken payment.
- `app.set('trust proxy', 1)` is set so rate limiting sees the real client
  IP behind Render/Railway's reverse proxy, instead of limiting by the
  proxy's IP for everyone.

Still worth doing as you scale further: a Web Application Firewall / DDoS
layer in front (Cloudflare's free tier covers a lot of this), structured
logging/monitoring (e.g. Sentry) so failures surface immediately instead of
sitting in server logs, and automated backups of the SQLite file (or a move
to managed Postgres, which typically includes backups).

## Launch checklist

- [ ] Rotate the IceKash key that was shared in this chat, and put the new
      one only in your host's environment variables
- [ ] Attach a persistent disk/volume and set `DATABASE_PATH` to a file on it
- [ ] Set all required env vars on your host: `PAYSTACK_SECRET_KEY`,
      `ICEKASH_API_KEY`, `ALLOWED_ORIGIN`, `PLATFORM_MARKUP_PERCENT`
- [ ] In Paystack dashboard: disable "Confirm transfers before sending",
      fund your Paystack balance, confirm your webhook URL is set
- [ ] Update `window.DATAFLOW_API_BASE` in `dataflow.html` to your real
      backend URL
- [ ] Test one full cycle end-to-end with Paystack test Mobile Money
      numbers: buy a bundle → webhook fires → IceKash delivers → (if via an
      agent link) agent wallet credits → agent withdraws → real transfer
      completes
- [ ] Only then switch Paystack and IceKash to live keys
