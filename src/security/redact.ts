/**
 * Strip secrets from strings before logs / Telegram / errors.
 * Never log raw private keys, API keys, or bot tokens.
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return (
    input
      // FOMO / generic query key=
      .replace(/([?&](?:key|api_key|apikey|access_token)=)[^&\s"'`]+/gi, "$1[REDACTED]")
      // Authorization bearer
      .replace(/(Bearer\s+)[A-Za-z0-9._\-+=/]+/gi, "$1[REDACTED]")
      // Telegram bot tokens in URLs: bot<id>:<secret>
      .replace(/\bbot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
      // Jupiter / 0x header echo (defensive)
      .replace(/(x-api-key["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1[REDACTED]")
      .replace(/(0x-api-key["']?\s*[:=]\s*["']?)[^"'\s&,}]+/gi, "$1[REDACTED]")
      // Hex private keys (32+ bytes)
      .replace(/\b(0x)?[a-fA-F0-9]{64}\b/g, "[REDACTED_HEX]")
      // Solana base58 secret-ish long strings in "private"/"secret" contexts already covered;
      // avoid nuking every mint address (32–44 chars base58). Only redact labeled keys:
      .replace(
        /((?:SOLANA|BASE)_PRIVATE_KEY\s*[=:]\s*)\S+/gi,
        "$1[REDACTED]",
      )
  );
}
