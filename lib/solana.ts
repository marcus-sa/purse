import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TokenAccountNotFoundError,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";

// Solana's stablecoins are SPL tokens: one mint per token, and each holder
// keeps a separate token account per mint. Both use 6 decimals, like on Tron.
export const SOLANA_TOKENS = {
  USDT: { mint: new PublicKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), decimals: 6 },
  USDC: { mint: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6 },
} as const;

export type SolanaToken = keyof typeof SOLANA_TOKENS;

// The public endpoint is rate limited but fine for a handful of calls; set
// SOLANA_RPC_URL to a provider (Helius, QuickNode, ...) for heavier use.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// Priority fee in micro-lamports per compute unit. A transfer uses well under
// 200k CU, so even this bids under 0.00001 SOL — but without any priority fee
// transactions are often dropped when the network is busy.
export const DEFAULT_PRIORITY_FEE = 50_000;

export function buildConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

export function generateSolanaKeypair() {
  const keypair = Keypair.generate();
  return {
    address: keypair.publicKey.toBase58(),
    privateKey: bs58.encode(keypair.secretKey),
  };
}

/**
 * Accepts the two formats wallets export: a base58 string (Phantom, Solflare)
 * or the JSON byte array that solana-keygen writes to id.json. Returns the
 * secret normalised to base58 so the DB holds a single format.
 */
export function parseSolanaSecret(input: string): { address: string; privateKey: string } {
  const trimmed = input.trim();
  const bytes = trimmed.startsWith("[") ? Uint8Array.from(JSON.parse(trimmed)) : bs58.decode(trimmed);
  // fromSecretKey checks the embedded public key against the secret half.
  const keypair = Keypair.fromSecretKey(bytes);
  return { address: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}

export function keypairFromSecret(privateKey: string): Keypair {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

export function isSolanaAddress(value: string): boolean {
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function toBaseUnits(amount: number, decimals: number): bigint {
  // Go through a fixed-point string so 0.1 + 0.2 style float noise can't leak
  // into the integer amount.
  const [whole, frac = ""] = amount.toFixed(decimals).split(".");
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

export async function getSolBalance(connection: Connection, owner: string): Promise<number> {
  return (await connection.getBalance(new PublicKey(owner))) / LAMPORTS_PER_SOL;
}

export async function getTokenBalance(connection: Connection, owner: string, token: SolanaToken): Promise<number> {
  const { mint, decimals } = SOLANA_TOKENS[token];
  const ata = getAssociatedTokenAddressSync(mint, new PublicKey(owner));
  try {
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** decimals;
  } catch (err) {
    // No token account yet means the owner has never held this token.
    if (err instanceof TokenAccountNotFoundError) return 0;
    throw err;
  }
}

function priorityFeeInstruction(microLamports: number) {
  return ComputeBudgetProgram.setComputeUnitPrice({ microLamports });
}

export async function sendSol(
  connection: Connection,
  from: Keypair,
  to: string,
  amount: number,
  priorityFee = DEFAULT_PRIORITY_FEE
): Promise<string> {
  const tx = new Transaction().add(
    priorityFeeInstruction(priorityFee),
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(to),
      lamports: toBaseUnits(amount, 9),
    })
  );
  return await sendAndConfirmTransaction(connection, tx, [from]);
}

export interface TokenSendResult {
  signature: string;
  createdRecipientAccount: boolean;
}

export async function sendToken(
  connection: Connection,
  from: Keypair,
  to: string,
  token: SolanaToken,
  amount: number,
  priorityFee = DEFAULT_PRIORITY_FEE
): Promise<TokenSendResult> {
  const { mint, decimals } = SOLANA_TOKENS[token];
  const recipient = new PublicKey(to);

  // allowOwnerOffCurve stays false: an off-curve recipient is a program
  // address, and tokens sent to one are usually unrecoverable.
  const sourceAta = getAssociatedTokenAddressSync(mint, from.publicKey);
  const destAta = getAssociatedTokenAddressSync(mint, recipient);

  const tx = new Transaction().add(priorityFeeInstruction(priorityFee));

  // A recipient who has never held this token has no token account. The
  // sender pays its rent (~0.002 SOL) — the Solana counterpart of the extra
  // energy Tron charges for a first-time USDT recipient.
  const destInfo = await connection.getAccountInfo(destAta);
  if (!destInfo) {
    tx.add(createAssociatedTokenAccountInstruction(from.publicKey, destAta, recipient, mint));
  }

  tx.add(
    createTransferCheckedInstruction(sourceAta, mint, destAta, from.publicKey, toBaseUnits(amount, decimals), decimals)
  );

  const signature = await sendAndConfirmTransaction(connection, tx, [from]);
  return { signature, createdRecipientAccount: !destInfo };
}

/**
 * Recipients must be wallet addresses. A token account address (what some
 * explorers show next to a balance) or a program address can't own an
 * associated token account, so sending there would fail or strand funds.
 */
export function isWalletAddress(address: string): boolean {
  return PublicKey.isOnCurve(new PublicKey(address).toBytes());
}

// Minimum balance for a plain system account to exist. Sending less than this
// to an empty address fails with "insufficient funds for rent".
export async function rentExemptMinimum(connection: Connection): Promise<number> {
  return (await connection.getMinimumBalanceForRentExemption(0)) / LAMPORTS_PER_SOL;
}
