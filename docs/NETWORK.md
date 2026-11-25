# Network calls

Every outbound call has a timeout. Retries are bounded. Backoff is `min(4000ms, 200ms * 2^attempt)` inside `fetchRetry` (`src/utils/http.ts`). State-changing posts use `retries: 0`. RPC failover tries the primary, then `SOLANA_RPC_URL_SECONDARY` once. URLs are not logged.

| Call | File | Timeout | Retries | Notes |
| --- | --- | --- | --- | --- |
| Jupiter `GET /swap/v2/order` | `src/execution/solana.ts` `requestOrder` | 10s | 2 | Quote only. |
| Jupiter `GET /swap/v1/swap-instructions` and `/quote` | `src/execution/solana.ts` round-trip | 10s | 2 | Sell simulation. |
| Jupiter `POST /swap/v2/execute` | `src/execution/solana.ts` | 20s | 0 | Signed broadcast. Not used when `SOLANA_ALLOW_LOOPBACK=true`. |
| DexScreener token liquidity | `src/execution/solana.ts` `checkTokenSafety` | 10s | 2 | Fail closed. |
| Solana RPC via `rpcConnection` (`getParsedAccountInfo`, `getTokenLargestAccounts`, `simulateTransaction`, `getSignatureStatuses`, `isBlockhashValid`, `getBalance`, `sendRawTransaction`) | `src/utils/http.ts` `rpcFetch` | 12s | 2 | 429 and 5xx only. `sendRawTransaction` also sets `maxRetries: 2`. |
| RPC failover | `src/utils/http.ts` `withRpcFailover` | per attempt above | one extra host | Secondary only. |
| Jupiter price `GET /price/v3` | `src/utils/prices.ts` | 10s | 2 | |
| CoinGecko SOL price | `src/utils/prices.ts` | 10s | 2 | Fallback. |
| FOMO REST | `src/fomo/client.ts` | 10s | 2 | |
| FOMO websocket | `src/fomo/ws.ts` | socket | reconnect delay capped at 60s | Not a request retry loop. |
| Telegram `sendMessage` and `getUpdates` | `src/notify/telegram.ts` | 10s | 2 | Body is redacted. The bot token is in the URL and is not logged. |
| Base 0x quote and price | `src/execution/base.ts` | 10s | 2 | Base is off unless enabled. |
| Base `sendTransaction` | `src/execution/base.ts` | wallet client | no blind resend in this repo | Live Base still requires the chain to be enabled. |

No call site uses an unbounded `while` retry. Intervals (`tp/sl`, position reconcile, REST poll, Telegram command poll) are timers with a re-entry guard, not retry loops.
