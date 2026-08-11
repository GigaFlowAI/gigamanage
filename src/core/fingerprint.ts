/**
 * A compact similarity fingerprint, for deciding whether a session has changed
 * *enough* to re-summarise — not merely *at all*.
 *
 * SimHash reduces a document to a 64-bit value where similar text yields similar
 * bits, so the Hamming distance between two fingerprints tracks how much the
 * content moved. It's 16 hex characters no matter how long the session gets —
 * which is the whole point: fixed, tiny metadata for an ever-growing transcript.
 *
 * `core` imports nothing internal; this is pure and deterministic.
 */

const MASK64 = (1n << 64n) - 1n;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;

/** FNV-1a over the bytes of a token → a 64-bit value. Deterministic, no deps. */
function hashToken(token: string): bigint {
  let hash = FNV_OFFSET;
  for (let i = 0; i < token.length; i++) {
    hash ^= BigInt(token.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
  }
  return hash;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * The 64-bit SimHash of `text`, as 16 lowercase hex characters.
 *
 * Each token votes on every bit (+1 if its hash has the bit set, −1 otherwise);
 * the final bit is set when its column of votes is positive. Empty text is all
 * zeros — a defined value the distance can compare against.
 */
export function simhash64(text: string): string {
  const votes = new Array<number>(64).fill(0);
  for (const token of tokenize(text)) {
    const h = hashToken(token);
    for (let bit = 0; bit < 64; bit++) {
      votes[bit]! += (h >> BigInt(bit)) & 1n ? 1 : -1;
    }
  }
  let fingerprint = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if (votes[bit]! > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint.toString(16).padStart(16, "0");
}

/** The number of differing bits between two hex fingerprints. */
export function hammingDistance(a: string, b: string): number {
  let xor = (BigInt(`0x${a}`) ^ BigInt(`0x${b}`)) & MASK64;
  let count = 0;
  while (xor > 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}
