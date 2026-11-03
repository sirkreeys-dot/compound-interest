# FOMO CopyBot

Copy-trading bot that mirrors **fomo.family** trader buys/sells into **your own wallet**, using **[FOMO API](https://fomoapi.io/docs)** (unofficial third-party) for signals.

- **Default watchlist:** top **3** traders on the **weekly** FOMO leaderboard (`GET /v2/leaderboard/7d`), refreshed every **6 hours**
- **Signals:** `WSS wss://api.fomoapi.io/ws/alerts` (one socket per trader) + optional REST `/v2/alerts`
- **Solana execution:** [Jupiter Swap API v2](https://developers.jup.ag/docs/swap) `GET /order` + `POST /execute`
- **Base execution (optional, off by default):** [0x Swap API v2](https://docs.0x.org) when `chains.base` / `ENABLED_CHAINS` includes `base`
- **Default size:** **fixed $2 USD** per copied trade (`maxUsdPerTrade: 5`, `dailyBudgetUsd: 40`)
- **Safety:** `DRY_RUN=true` by default, kill switch, budgets, TP/SL hooks
- **Telegram (first-class):** entry / exit / skip(reason) / PnL / **watchlist changes** + `/status` `/positions` `/pause` `/resume`

> **Not financial advice.** You can lose money. Use a **fresh wallet** funded with only what you can afford to lose. FOMO API is independent and **not affiliated** with fomo.family.

---

## Requirements

- Node.js **20+** (uses built-in `node:sqlite`)
- A FOMO API key (free tier can try `/ws/alerts` + leaderboard — see below)
- For live Solana: wallet key (+ optional Jupiter key). Base/0x only if you enable Base
- Telegram bot token + chat id (recommended)

---

## 1. Get a FOMO API key

Based on [fomoapi.io/docs](https://fomoapi.io/docs), [fomoapi.io/pricing](https://fomoapi.io/pricing), and [fomoapi.io/dashboard](https://fomoapi.io/dashboard). Pricing can change — treat the pricing page as authoritative.

### Sign up (free key)

1. Open **[https://fomoapi.io/dashboard](https://fomoapi.io/dashboard)**.
2. Sign in with your **email**. FOMO API sends a **one-time code** — there is **no password**.
3. After you verify the code, the dashboard **mints an API key automatically**.
4. Copy the key into `.env` as `FOMO_API_KEY=...`. Rotate anytime from the dashboard.

Buying a **paid** plan: the [pricing page](https://fomoapi.io/pricing) takes an email → checkout → key emailed when payment clears (no account required first).

### Which plan for this bot?

| Feature | Endpoint | Plan (per FOMO pricing/docs) |
| --- | --- | --- |
| Weekly top traders | `GET /v2/leaderboard/7d` | Every plan (uses credits) |
| Per-trader live buys/sells | `WSS /ws/alerts?trader=...` | **Every plan, including Free** |
| REST gap recovery | `GET /v2/alerts` | Every plan (credits) |
| On-chain stream | `WSS /ws/trades` | **Growth/Scale only** — not used by default |

**`/ws/alerts` delay:** Paid = realtime. Free = realtime for **7 days**, then **15s delayed**. WS connect/messages are **unmetered**; REST still costs credits.

**Starter ($49.99/mo)** is FOMO’s production floor for a permanently realtime stream. Free is enough to develop and dry-run.

### Credit costs (from FOMO docs/pricing)

| Call | Credits |
| --- | --- |
| Normal read (leaderboard, trades, balances, search) | 250 |
| `GET /v2/alerts` | 125 |
| Thesis page | 1,250 |
| Wallet resolution `GET /v2/users/{handle}` | 2,500 |
| `/health`, `/v1`, `/v2/me` | 0 |
| `/ws/alerts` | 0 |

**Monthly buckets:** Free **250,000**; Starter **2,500,000** ($49.99); Builder **12,500,000** ($199.99); Growth **37,500,000** ($599); Scale **112,500,000** ($1,500). Out of credits → HTTP **402**.

```http
authorization: Bearer YOUR_API_KEY
```

```text
wss://api.fomoapi.io/ws/alerts?key=YOUR_API_KEY&trader=HANDLE
```

### Chains (Solana only by default)

- Config: `chains.solana: true`, `chains.base: false`, `filters.allowedChains: [solana]`
- Env override: `ENABLED_CHAINS=solana` (default in `.env.example`) or `ENABLED_CHAINS=solana,base` to turn Base on
- Alerts on a disabled chain are skipped (`unsupported_chain`) and do **not** call Base/0x

---

## 2. Get a 0x API key (optional — only if you enable Base)

**Default config is Solana-only** (`ENABLED_CHAINS=solana`, `chains.base: false`). Skip this section unless you set `ENABLED_CHAINS=solana,base` or `chains.base: true`.

Needed for **Base** execution and for fresh ETH/USD sizing via 0x. Based only on [0x’s Create a 0x API Key](https://docs.0x.org/docs/introduction/quickstart/getting-started), the [0x Dashboard sign-up](https://dashboard.0x.org/create-account), and [0x Pricing](https://0x.org/pricing). Treat those pages as authoritative if anything changes.

### Steps (from 0x docs)

1. Open **[https://dashboard.0x.org/create-account](https://dashboard.0x.org/create-account)** (or the Dashboard **Sign Up** flow in the docs).
2. Create a 0x account: enter your **name**, **email**, and **password**, then click **Continue**.
3. After verification, **create a Team**: pick a team name and the type of project you are building.
4. In the dashboard, click **Create an app** to get a live API key with access to 0x products.
5. In the app pop-up, enter an **app name** and enable the products this key should use (docs list **Swap API** and **Gasless API**). This bot needs **Swap API** for Base quotes/swaps. Click **Continue**.
6. **Reveal your API key** on the app (docs: the key is unique and tied to the app — do not share it). You can create additional keys for the same app later.
7. To find the key again later: select the app in the dashboard and **reveal** the API key (app **API Key** section).
8. Put the key in this bot’s `.env` as:

```env
ZEROX_API_KEY=your_0x_api_key_here
```

The bot sends it as the HTTP header `0x-api-key` (and `0x-version: v2`), matching [0x API authentication](https://docs.0x.org/api-reference/api-overview.md).

### Plans / pricing (from 0x pricing + start FAQ)

- 0x’s start FAQ: create a Dashboard account, **choose a plan**, set up your app, and generate API keys ([pricing FAQ](https://0x.org/pricing) / [help: get started](https://help.0x.org/articles/4704859362-how-to-get-started-with-0x-api)).
- The public [pricing page](https://0x.org/pricing) currently lists **Standard** and **Custom** tiers (Standard is described with a **0.15%** fee on select Swap pairs and about **5 requests/second**). The page headline says “Start building for free,” but it does **not** document a separate free-forever API tier with published free RPS — use the Dashboard and pricing pages for whatever plan you are offered at sign-up.
- Standard-plan notes from 0x: on-chain **0.15%** fees on select Swap pairs; Trade Surplus may be collected; heavy quote-only traffic can hit limits (contact 0x if you need price-only usage).

Without `ZEROX_API_KEY`, Base live swaps and 0x-based ETH pricing will not work (ETH sizing may try a guarded CoinGecko fallback and will refuse the trade if that fails).

---

## 3. Telegram (@BotFather)

### Create the bot

1. Open Telegram → **[@BotFather](https://t.me/BotFather)**.
2. Send `/newbot` → pick display name → username ending in `bot`.
3. Copy the **HTTP API token** into `.env` as `TELEGRAM_BOT_TOKEN=...`.

### Get your chat id

1. Message your new bot (`/start`).
2. Use [@userinfobot](https://t.me/userinfobot) / [@getidsbot](https://t.me/getidsbot), **or**:

```bash
curl "https://api.telegram.org/botTOKEN/getUpdates"
```

Find `"chat":{"id": 123456789` → set `TELEGRAM_CHAT_ID=123456789`.

Commands are **restricted to that chat id**.

**Group chats:** any member can talk in a group. Also set your personal Telegram **user id** so only you can run commands:

1. Open [@userinfobot](https://t.me/userinfobot) — copy the numeric **Id**.
2. Put it in `.env`:

```env
TELEGRAM_ALLOWED_USER_IDS=123456789
```

Comma-separate multiple ids if needed. When set, `/pause` `/resume` `/status` `/positions` `/help` require both the right `TELEGRAM_CHAT_ID` **and** `from.id` in that list (including `edited_message`).

| Command | Action |
| --- | --- |
| `/status` | mode, source, size, pause, positions, daily spend/PnL, WS, watchlist |
| `/positions` | open positions |
| `/pause` | kill switch ON (block new entries) |
| `/resume` | kill switch OFF |
| `/help` | list commands |

You also get Telegram messages for: **entries**, **exits**, **skipped trades (with reason)**, **PnL**, and **watchlist add/remove** when the leaderboard refresh changes who you follow.

---

## 4. Who to copy (leaderboard default)

FOMO leaderboard windows (exact path values from docs): **`24h` · `7d` · `30d` · `all`**.  
**Weekly = `7d`.**

Defaults in `config.yaml` / env:

```yaml
traderSource: leaderboard
leaderboard:
  window: 7d      # weekly
  topN: 3
  refreshHours: 6
```

```env
TRADER_SOURCE=leaderboard
LEADERBOARD_WINDOW=7d
LEADERBOARD_TOP_N=3
LEADERBOARD_REFRESH_HOURS=6
```

At startup the bot calls `GET /v2/leaderboard/7d?limit=3`, keys each row by **`userId`**, opens `/ws/alerts` per trader, and re-fetches on `refreshHours`.  

**When someone drops out of the top N:** they are removed from the active list → **no new copy buys**. If you still hold a position opened while they were watched, their **sells are still copied** (alumni). Telegram notifies on every add/remove.

### Manual mode

```yaml
traderSource: manual
traders:
  - handle: frankdegods
    userId: "…"   # preferred
    enabled: true
    chains: [solana, base]
```

Or `TRADER_SOURCE=manual`.

---

## 5. Sizing (default $2) and fees

Defaults:

| Setting | Default | Notes |
| --- | --- | --- |
| `sizing.mode` | `fixed_usd` | |
| `sizing.fixedUsd` | **2** | $2 notional per copied buy |
| `sizing.maxUsdPerTrade` | **5** | hard cap |
| `risk.dailyBudgetUsd` | **40** | stops new entries after ~20× $2 |

### Gas / priority fees on small trades

On **Solana** and **Base**, network fees and priority/inclusion tips are paid **on top of** your $2 swap notional. At this size, fees can be a **large share** of each trade’s cost (sometimes comparable to the notional itself when the network is busy), which hurts round-trip PnL even if the token price is flat. Prefer dry-run first; if you go live at $2, expect fee drag and consider raising size only after you understand your wallet’s fee spend. Exact fee amounts vary by congestion, route, and chain — this bot does not invent a fixed fee number.

---

## 6. Install & configure

```bash
cd compound-interest   # the folder you cloned into
cp .env.example .env
cp config.example.yaml config.yaml
npm install
```

Edit `.env`: set `FOMO_API_KEY`, Telegram vars; keep `DRY_RUN=true` until ready.

---

## 7. Run dry-run

```bash
npm run typecheck
npm test
npm run replay          # fixture alerts (manual trader list, no API key)
npm run dev             # live leaderboard + WS (needs FOMO_API_KEY); still DRY_RUN
```

With `DRY_RUN=true` the bot logs/Telegram-notifies what it **would** trade; modules may **fetch quotes** but **do not sign or broadcast**.

---

## 8. Going live

1. Confirm dry-run entries via Telegram.
2. Fund a **new** wallet with a **small** balance.
3. Set keys (+ `ZEROX_API_KEY` for Base) in `.env` only.
4. `DRY_RUN=false`. Start with `$2` / daily `$40` and `/pause` handy.
5. `npm run dev` or `npm run build && npm start`.

```bash
npm run kill            # or Telegram /pause
npm run kill resume     # or /resume
```

---

## Project layout

```text
src/
  fomo/adapter.ts      # raw FOMO field parsing (+ TODOs)
  fomo/client.ts       # REST (incl. leaderboard)
  fomo/ws.ts           # /ws/alerts, reconnect, dynamic setTraders
  engine/watchlist.ts  # leaderboard top-N + manual + alumni
  engine/copy.ts
  engine/filters.ts
  execution/solana.ts  # Jupiter v2
  execution/base.ts    # 0x
  notify/telegram.ts   # notifications + commands
  store/db.ts          # SQLite
fixtures/sample-alerts.json
tests/
```

---

## Unverified / TODO API fields

In `src/fomo/adapter.ts` / watchlist:

- Multi-trader on **one** `/ws/alerts` socket — bot uses **one socket per trader**.
- REST `/v2/alerts` envelope key (`alerts` / `items` / `data`) — adapter probes all.
- Missing `tradeUsd` → percent sizing skips; docs say don’t use `usdValue` as fill size.
- Market cap rarely on `/ws/alerts` — mcap filter only when present.
- TP/SL needs better mark-to-market when quotes omit USD out.

---

## Risks

- Real funds; MEV, slippage, failed txs, rugs; FOMO feed can omit smaller trades (docs: large-feed floor near ~$3k position value).
- Free `/ws/alerts` delays after 7 days.
- Leaderboard refresh can change who you copy; alumni sells still process.
- At **$2** size, **fees can dominate** — see sizing section.
- Private keys in `.env` = full wallet control.
- Software as-is, no warranty.

## Security notes (audit)

- **DRY_RUN=true** (default): Jupiter/0x quotes may be fetched; **no transaction is signed or broadcast**.
- **Live Solana**: before signing, the bot checks Jupiter `inputMint`/`outputMint`/`inAmount`/`outAmount`/`slippageBps`/`taker`, deserializes the tx, and **refuses to sign unless the fee payer is your wallet**.
- **Live Base** (optional): tx `to` and ERC-20 spender must be the documented 0x AllowanceHolder (`0x0000000000001fF3684f28c67538d4D072C22734`); native `value` must match sell amount.
- **Token mints** on alerts are format-checked; Solana buys also inspect freeze authority / Token-2022 transfer hooks via RPC (`filters.tokenSafety`, default `block`).
- **Telegram** commands only from `TELEGRAM_CHAT_ID` (message + edited_message). Optional `TELEGRAM_ALLOWED_USER_IDS` further locks `/pause` `/resume` etc. to your personal user id(s) — required for group chats. Untrusted symbols are HTML-escaped; secrets are redacted from errors.
- **Pre-sign simulation (Solana live):** each Jupiter TX is `simulateTransaction`'d; unexpected SOL/token outflows or output below `otherAmountThreshold` refuse the signature (`risk.simulateBeforeSign`, default true).
- **Pending ledger:** live buys write a `pending_swaps` row before broadcast and reconcile into `positions` (or alert on Telegram) so fills are never silently untracked.
- **maxChaseBps**: refuses quotes whose USD out is worse than this vs your spend (also used live before sign).
- Private keys stay in `.env` only — never commit `.env` / `data/` / `kill.switch`.

