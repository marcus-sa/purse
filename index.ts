#!/usr/bin/env bun

/**
 * tron-wallet-cli (Bun edition)
 *
 * Multi-profile Tron wallet CLI backed by bun:sqlite.
 *
 * Usage:
 *   bun index.ts profile add <name>
 *   bun index.ts profile import <name> <privateKeyHex>
 *   bun index.ts profile list
 *   bun index.ts profile use <name>
 *   bun index.ts profile show <name> [--reveal]
 *   bun index.ts profile qr [name]
 *   bun index.ts profile remove <name>
 *
 *   bun index.ts rekey                          (rotate WALLET_MASTER_KEY; see env vars)
 *
 *   bun index.ts balance [name]                 (defaults to active profile)
 *   bun index.ts transactions [name] [--limit N] [--all] [--type trx|usdt|trc20|all] [--json]
 *   bun index.ts send-trx <to> <amount> [--profile name]
 *   bun index.ts send-usdt <to> <amount> [--fee-limit trx] [--profile name]
 *   bun index.ts swap <trx-usdt|usdt-trx> <amount> [--slippage n] [--quote]
 *
 * Env vars:
 *   WALLET_MASTER_KEY   optional passphrase to encrypt private keys at rest
 *   WALLET_NEW_MASTER_KEY  new passphrase, used only by the rekey command
 *   TRONGRID_API_KEY    optional, recommended for higher rate limits
 *   TRON_FULL_HOST      optional, defaults to https://api.trongrid.io
 *   TRONGRID_API_HOST   optional, host for the v1 REST API (tx history)
 *   WALLET_DATA_DIR     optional, defaults to ~/.tron-wallet-cli
 */

import {
  insertProfile,
  getProfile,
  listProfiles,
  deleteProfile,
  setSetting,
  getActiveProfileName,
  replaceProfileKeys,
  DB_PATH,
} from "./lib/db";
import {
  encryptSecret,
  decryptSecret,
  encryptSecretWith,
  decryptSecretWith,
  isEncryptionEnabled,
} from "./lib/crypto";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { buildTronWeb, generateKeypair, USDT_CONTRACT } from "./lib/tron";
import { renderQrToTerminal } from "./lib/qr";
import { fetchHistory, type HistoryEntry } from "./lib/history";
import {
  DEFAULT_TRX_RESERVE,
  ensureUsdtAllowance,
  executeSwap,
  isSwapDirection,
  planSwap,
  quoteSwap,
  receiptError,
  receiptSucceeded,
  receivedAmount,
  tokensFor,
  waitForReceipt,
  type SwapDirection,
} from "./lib/swap";

function printUsage() {
  console.log(`
tron-wallet-cli (Bun) — DB: ${DB_PATH}

Profile commands:
  profile add <name>                  Generate a new keypair and save as a profile
  profile import <name> <privKeyHex>  Import an existing private key as a profile
  profile list                        List all profiles (marks the active one)
  profile use <name>                  Set the active profile
  profile show <name> [--reveal]      Show a profile's address (and key with --reveal)
  profile qr [name]                   Render the address as a scannable QR code
  profile remove <name>               Delete a profile

Maintenance commands:
  rekey                               Rotate WALLET_MASTER_KEY to WALLET_NEW_MASTER_KEY
                                      (re-encrypts all profiles, backs up the DB first)

Wallet commands:
  balance [name]                      Show TRX + USDT balance (active profile if omitted)
  transactions [name] [options]       Show transaction history (aliases: txs, history)
      --limit <n>                       Number of transactions to show (default 20)
      --all                             Fetch the complete history, no limit
      --type <trx|usdt|trc20|all>       Filter by transfer type (default all)
      --json                            Print raw JSON instead of a table
      --profile <name>                  Profile to use
  send-trx <to> <amount> [--profile name]
  send-usdt <to> <amount> [options]
      --fee-limit <trx>                 Max TRX to burn on energy (default ${DEFAULT_USDT_FEE_LIMIT})
      --profile <name>                  Profile to use
  swap <trx-usdt|usdt-trx> <amount> [options]
      --quote                           Print the current rate without swapping
      --slippage <percent>              Max acceptable slippage (default 0.5)
      --reserve <trx>                   TRX held back for fees (default ${DEFAULT_TRX_RESERVE})
      --deadline <minutes>              Swap expiry (default 10)
      --profile <name>                  Profile to use

Encryption: ${isEncryptionEnabled() ? "ENABLED (WALLET_MASTER_KEY set)" : "disabled (set WALLET_MASTER_KEY to encrypt keys at rest)"}
`);
}

function getPrivateKeyPlaintext(profile: { private_key: string; encrypted: number }): string {
  if (profile.encrypted) {
    return decryptSecret(profile.private_key);
  }
  return profile.private_key;
}

function resolveProfileName(explicit?: string): string {
  const name = explicit || getActiveProfileName();
  if (!name) {
    console.error("No profile specified and no active profile set.");
    console.error("Run 'profile add <name>' then 'profile use <name>', or pass --profile <name>.");
    process.exit(1);
  }
  return name as string;
}

function requireProfile(name: string) {
  const profile = getProfile(name);
  if (!profile) {
    console.error(`Profile "${name}" not found. Run 'profile list' to see available profiles.`);
    process.exit(1);
  }
  return profile;
}

// --- profile commands ---------------------------------------------------

function cmdProfileAdd(name?: string) {
  if (!name) {
    console.error("Usage: profile add <name>");
    process.exit(1);
  }
  if (getProfile(name)) {
    console.error(`Profile "${name}" already exists.`);
    process.exit(1);
  }

  const { address, privateKey } = generateKeypair();
  const stored = isEncryptionEnabled() ? encryptSecret(privateKey) : privateKey;

  insertProfile({ name, address, private_key: stored, encrypted: isEncryptionEnabled() ? 1 : 0 });

  if (!getActiveProfileName()) {
    setSetting("active_profile", name);
  }

  console.log(`Created profile "${name}"`);
  console.log(`  Address: ${address}`);
  if (!isEncryptionEnabled()) {
    console.log(`  Private key stored in plaintext (set WALLET_MASTER_KEY to encrypt).`);
  }
  console.log(`\nFund this address with a small amount of TRX before sending anything.`);
}

function cmdProfileImport(name?: string, privateKeyHex?: string) {
  if (!name || !privateKeyHex) {
    console.error("Usage: profile import <name> <privateKeyHex>");
    process.exit(1);
  }
  if (getProfile(name)) {
    console.error(`Profile "${name}" already exists.`);
    process.exit(1);
  }

  const tronWeb = buildTronWeb();
  let address: string;
  try {
    address = tronWeb.address.fromPrivateKey(privateKeyHex);
  } catch {
    console.error("Invalid private key.");
    process.exit(1);
  }

  const stored = isEncryptionEnabled() ? encryptSecret(privateKeyHex) : privateKeyHex;
  insertProfile({ name, address: address!, private_key: stored, encrypted: isEncryptionEnabled() ? 1 : 0 });

  if (!getActiveProfileName()) {
    setSetting("active_profile", name);
  }

  console.log(`Imported profile "${name}"`);
  console.log(`  Address: ${address}`);
}

function cmdProfileList() {
  const profiles = listProfiles();
  const active = getActiveProfileName();

  if (profiles.length === 0) {
    console.log("No profiles yet. Run 'profile add <name>' to create one.");
    return;
  }

  console.log("Profiles:");
  for (const p of profiles) {
    const marker = p.name === active ? "*" : " ";
    console.log(`  ${marker} ${p.name}  ${p.address}${p.encrypted ? "  (encrypted)" : ""}`);
  }
}

function cmdProfileUse(name?: string) {
  if (!name) {
    console.error("Usage: profile use <name>");
    process.exit(1);
  }
  requireProfile(name);
  setSetting("active_profile", name);
  console.log(`Active profile set to "${name}"`);
}

function cmdProfileShow(name?: string, reveal = false, qr = false) {
  if (!name) {
    console.error("Usage: profile show <name> [--reveal] [--qr]");
    process.exit(1);
  }
  const profile = requireProfile(name);
  console.log(`Profile: ${profile.name}`);
  console.log(`  Address: ${profile.address}`);
  console.log(`  Created: ${profile.created_at}`);
  console.log(`  Encrypted at rest: ${profile.encrypted ? "yes" : "no"}`);
  if (reveal) {
    console.log(`  Private key: ${getPrivateKeyPlaintext(profile)}`);
  }
  if (qr) {
    console.log();
    console.log(renderQrToTerminal(profile.address));
  }
}

function cmdProfileQr(nameArg?: string) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);
  console.log(`${profile.name}: ${profile.address}`);
  console.log();
  console.log(renderQrToTerminal(profile.address));
}

function cmdProfileRemove(name?: string) {
  if (!name) {
    console.error("Usage: profile remove <name>");
    process.exit(1);
  }
  requireProfile(name);
  deleteProfile(name);
  if (getActiveProfileName() === name) {
    setSetting("active_profile", "");
  }
  console.log(`Removed profile "${name}"`);
}

const MIN_NEW_KEY_LENGTH = 16;

function cmdRekey() {
  const oldKey = process.env.WALLET_MASTER_KEY;
  const newKey = process.env.WALLET_NEW_MASTER_KEY;

  if (!newKey) {
    console.error("WALLET_NEW_MASTER_KEY is not set. Export the new passphrase, then run 'rekey' again.");
    process.exit(1);
  }
  if (newKey === oldKey) {
    console.error("WALLET_NEW_MASTER_KEY must differ from WALLET_MASTER_KEY.");
    process.exit(1);
  }
  if (newKey.length < MIN_NEW_KEY_LENGTH) {
    console.error(`WALLET_NEW_MASTER_KEY must be at least ${MIN_NEW_KEY_LENGTH} characters.`);
    process.exit(1);
  }

  const profiles = listProfiles();
  if (profiles.length === 0) {
    console.error("No profiles to rekey.");
    process.exit(1);
  }
  if (!oldKey && profiles.some((p) => p.encrypted)) {
    console.error("WALLET_MASTER_KEY is not set, but some profiles are encrypted. Set the current passphrase.");
    process.exit(1);
  }

  // Decrypt and verify everything in memory before touching the DB or disk.
  const tronWeb = buildTronWeb();
  const updates: { name: string; private_key: string }[] = [];
  for (const p of profiles) {
    let plain: string;
    try {
      plain = p.encrypted ? decryptSecretWith(oldKey as string, p.private_key) : p.private_key;
    } catch {
      console.error(`Could not decrypt profile "${p.name}" with WALLET_MASTER_KEY. Nothing was changed.`);
      process.exit(1);
    }
    let derived: string;
    try {
      derived = tronWeb.address.fromPrivateKey(plain);
    } catch {
      console.error(`Profile "${p.name}" holds an invalid private key. Nothing was changed.`);
      process.exit(1);
    }
    if (derived !== p.address) {
      console.error(`Profile "${p.name}": derived address does not match the stored address. Nothing was changed.`);
      process.exit(1);
    }
    updates.push({ name: p.name, private_key: encryptSecretWith(newKey, plain) });
  }

  const backupDir = join(import.meta.dir, "backups");
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `wallet-${stamp}.db`);
  copyFileSync(DB_PATH, backupPath);
  console.log(`Backup written: ${backupPath}`);

  replaceProfileKeys(updates);

  console.log(`Rekeyed ${updates.length} profile${updates.length === 1 ? "" : "s"}.`);
  console.log(`\nNext steps:`);
  console.log(`  - Set WALLET_MASTER_KEY to the new passphrase now; the old one no longer decrypts the DB.`);
  console.log(`  - The backup is still encrypted with the OLD key. Delete it once you are satisfied.`);
  console.log(`  - Rotating the passphrase does not protect copies of the DB already encrypted under the old one.`);
}

// --- wallet commands ------------------------------------------------------

async function cmdBalance(nameArg?: string) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);
  const tronWeb = buildTronWeb();
  // Constant-contract calls (balanceOf) require an owner_address; without a
  // private key the only address we have is the profile's own.
  tronWeb.setAddress(profile.address);

  const sunBalance = await tronWeb.trx.getBalance(profile.address);
  console.log(`Profile: ${profile.name} (${profile.address})`);
  console.log(`  TRX:  ${tronWeb.fromSun(sunBalance)}`);

  const contract = await tronWeb.contract().at(USDT_CONTRACT);
  const usdtRaw = await contract.methods.balanceOf(profile.address).call();
  console.log(`  USDT: ${usdtRaw.toNumber() / 1_000_000}`);
}

interface TransactionsOptions {
  limit: number;
  type: string;
  json: boolean;
}

function formatWhen(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function signedAmount(entry: HistoryEntry): string {
  if (entry.amount === null) return "—";
  if (entry.direction === "self") return entry.amount;
  return `${entry.direction === "out" ? "-" : "+"}${entry.amount}`;
}

function printHistoryTable(entries: HistoryEntry[]) {
  // The status column is dead weight when nothing failed, and dropping it buys
  // back the width that the full 64-char txID needs. Truncating the txID
  // instead would be worse: a partial hash can't be pasted into an explorer.
  const showStatus = entries.some((e) => e.status !== "SUCCESS");

  const rows = entries.map((e) => [
    formatWhen(e.timestamp),
    e.direction.toUpperCase(),
    e.kind,
    signedAmount(e),
    e.counterparty || "—",
    ...(showStatus ? [e.status] : []),
    e.txId,
  ]);

  const header = ["WHEN", "DIR", "TYPE", "AMOUNT", "COUNTERPARTY", ...(showStatus ? ["STATUS"] : []), "TXID"];
  // Amount reads best right-aligned so decimal points line up.
  const rightAligned = new Set([3]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));

  const renderRow = (cells: string[]) =>
    "  " +
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : rightAligned.has(i) ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join("  ");

  console.log(renderRow(header));
  for (const row of rows) {
    console.log(renderRow(row));
  }
}

async function cmdTransactions(nameArg?: string, options: TransactionsOptions = { limit: 20, type: "all", json: false }) {
  const name = resolveProfileName(nameArg);
  const profile = requireProfile(name);

  const entries = await fetchHistory(profile.address, { limit: options.limit, type: options.type });

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  const scope = options.type === "all" ? "" : ` [${options.type}]`;
  console.log(`Transactions for "${profile.name}" (${profile.address})${scope}`);

  if (entries.length === 0) {
    console.log("  No transactions found.");
    return;
  }

  console.log();
  printHistoryTable(entries);
  console.log();

  const reachedLimit = Number.isFinite(options.limit) && entries.length >= options.limit;
  console.log(
    `  ${entries.length} transaction${entries.length === 1 ? "" : "s"}` +
      (reachedLimit ? ` (limit reached — use --limit <n> or --all for more)` : "")
  );
}

async function cmdSendTrx(toAddress?: string, amountStr?: string, profileName?: string) {
  if (!toAddress || !amountStr) {
    console.error("Usage: send-trx <toAddress> <amount> [--profile name]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number.");
    process.exit(1);
  }

  const name = resolveProfileName(profileName);
  const profile = requireProfile(name);
  const privateKey = getPrivateKeyPlaintext(profile);
  const tronWeb = buildTronWeb(privateKey);

  const amountInSun = tronWeb.toSun(amount);
  const tx = await tronWeb.trx.sendTransaction(toAddress, amountInSun);
  console.log(`Sent from profile "${profile.name}" (${profile.address})`);
  console.log(JSON.stringify(tx, null, 2));
}

// Fee limit is a ceiling, not a spend. With nothing staked, a USDT transfer
// burns ~65k energy (~130k to a never-funded recipient), which can exceed
// 10 TRX — a lower cap makes transfers revert with OUT_OF_ENERGY.
const DEFAULT_USDT_FEE_LIMIT = 50;
// Protocol maximum for fee_limit.
const MAX_FEE_LIMIT = 15_000;

async function cmdSendUsdt(
  toAddress?: string,
  amountStr?: string,
  profileName?: string,
  feeLimitTrx = DEFAULT_USDT_FEE_LIMIT
) {
  if (!toAddress || !amountStr) {
    console.error("Usage: send-usdt <toAddress> <amount> [--fee-limit trx] [--profile name]");
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number.");
    process.exit(1);
  }

  const name = resolveProfileName(profileName);
  const profile = requireProfile(name);
  const privateKey = getPrivateKeyPlaintext(profile);
  const tronWeb = buildTronWeb(privateKey);

  const contract = await tronWeb.contract().at(USDT_CONTRACT);
  const amountInSmallestUnit = Math.round(amount * 1_000_000); // USDT has 6 decimals

  const tx = await contract.methods.transfer(toAddress, amountInSmallestUnit).send({
    feeLimit: Math.round(feeLimitTrx * 1_000_000),
  });
  console.log(`Sent from profile "${profile.name}" (${profile.address})`);
  console.log("Transaction ID:", tx);
}

interface SwapOptions {
  slippage: number;
  reserve: number;
  deadline: number;
  quoteOnly: boolean;
  profile?: string;
}

async function cmdSwap(direction: SwapDirection, amountStr?: string, options?: SwapOptions) {
  const opts = options!;
  const tokens = tokensFor(direction);

  if (!amountStr) {
    console.error(`Usage: swap ${direction} <amount> [--slippage n] [--quote] [--profile name]`);
    process.exit(1);
  }
  const amount = parseFloat(amountStr);
  if (Number.isNaN(amount) || amount <= 0) {
    console.error("Amount must be a positive number.");
    process.exit(1);
  }

  const name = resolveProfileName(opts.profile);
  const profile = requireProfile(name);

  if (opts.quoteOnly) {
    const tronWeb = buildTronWeb();
    // getAmountsOut is a constant call, which still needs an owner address.
    tronWeb.setAddress(profile.address);
    const out = await quoteSwap(tronWeb, direction, amount);
    console.log(`${amount} ${tokens.in} → ${out} ${tokens.out}`);
    console.log(`  Rate: 1 ${tokens.in} = ${out / amount} ${tokens.out}`);
    console.log(`  Quote only — nothing was sent.`);
    return;
  }

  const privateKey = getPrivateKeyPlaintext(profile);
  const tronWeb = buildTronWeb(privateKey);
  const trxBalance = Number(tronWeb.fromSun(await tronWeb.trx.getBalance(profile.address)));

  if (direction === "trx-usdt") {
    const spendable = trxBalance - opts.reserve;
    if (amount > spendable) {
      console.error(`Not enough TRX. Balance ${trxBalance}, reserved ${opts.reserve} for fees.`);
      if (spendable > 0) {
        console.error(`Most you can swap right now: ${spendable} TRX (or lower the reserve with --reserve).`);
      } else {
        console.error(opts.reserve > 0 ? "Fund the account, or lower the reserve with --reserve." : "Fund the account first.");
      }
      process.exit(1);
    }
  } else {
    const usdt = await tronWeb.contract().at(USDT_CONTRACT);
    const usdtBalance = Number((await usdt.methods.balanceOf(profile.address).call()).toString()) / 1_000_000;
    if (amount > usdtBalance) {
      console.error(`Not enough USDT. Balance ${usdtBalance}.`);
      process.exit(1);
    }
    // A USDT-in swap costs an approval plus the swap, both paid in energy.
    if (trxBalance === 0) {
      console.error("Account holds no TRX — there is nothing to pay the swap's energy with.");
      process.exit(1);
    }
    if (trxBalance < 15) {
      console.log(`  Warning: only ${trxBalance} TRX for fees; the swap may run out of energy.`);
    }
  }

  const plan = await planSwap(tronWeb, direction, amount, opts.slippage);

  console.log(`Swapping from profile "${profile.name}" (${profile.address})`);
  console.log(`  In:       ${plan.amountIn} ${tokens.in}`);
  console.log(`  Expected: ${plan.expectedOut} ${tokens.out}`);
  console.log(`  Minimum:  ${plan.minOut} ${tokens.out} (${plan.slippagePercent}% slippage)`);

  if (direction === "usdt-trx") {
    const approvalTx = await ensureUsdtAllowance(tronWeb, profile.address, amount);
    if (approvalTx) {
      console.log(`  Approved router to spend USDT: ${approvalTx}`);
    }
  }

  const txId = await executeSwap(tronWeb, plan, profile.address, opts.deadline);
  console.log(`  Transaction ID: ${txId}`);

  const info = await waitForReceipt(tronWeb, txId);
  if (!info) {
    console.log("  Still unconfirmed after 90s — check the txID in an explorer.");
    return;
  }
  if (!receiptSucceeded(info)) {
    console.error(`  Swap failed on-chain: ${receiptError(info)}`);
    process.exit(1);
  }

  const received = receivedAmount(tronWeb, info, direction, profile.address);
  console.log(
    received === null
      ? `  Confirmed (could not read the received amount from the receipt).`
      : `  Confirmed — received ${received} ${tokens.out}`
  );
}

// --- arg parsing ------------------------------------------------------

function extractFlag(args: string[], flag: string): { value: string | undefined; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { value: undefined, rest: args };
  const value = args[idx + 1];
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

function hasFlag(args: string[], flag: string): { present: boolean; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { present: false, rest: args };
  const rest = [...args.slice(0, idx), ...args.slice(idx + 1)];
  return { present: true, rest };
}

async function main() {
  const argv = process.argv.slice(2);
  const [command, sub, ...rest] = argv;

  try {
    if (command === "profile") {
      switch (sub) {
        case "add":
          cmdProfileAdd(rest[0]);
          break;
        case "import":
          cmdProfileImport(rest[0], rest[1]);
          break;
        case "list":
          cmdProfileList();
          break;
        case "use":
          cmdProfileUse(rest[0]);
          break;
        case "show": {
          const { present: reveal, rest: rest2 } = hasFlag(rest, "--reveal");
          const { present: qr, rest: rest3 } = hasFlag(rest2, "--qr");
          cmdProfileShow(rest3[0], reveal, qr);
          break;
        }
        case "qr":
          cmdProfileQr(rest[0]);
          break;
        case "remove":
          cmdProfileRemove(rest[0]);
          break;
        default:
          printUsage();
      }
      return;
    }

    if (command === "rekey") {
      cmdRekey();
      return;
    }

    if (command === "balance") {
      const { value: profileFlag, rest: rest2 } = extractFlag([sub, ...rest].filter(Boolean) as string[], "--profile");
      await cmdBalance(profileFlag || rest2[0]);
      return;
    }

    if (command === "transactions" || command === "txs" || command === "history") {
      let args = [sub, ...rest].filter(Boolean) as string[];

      const profileFlag = extractFlag(args, "--profile");
      args = profileFlag.rest;
      const limitFlag = extractFlag(args, "--limit");
      args = limitFlag.rest;
      const typeFlag = extractFlag(args, "--type");
      args = typeFlag.rest;
      const allFlag = hasFlag(args, "--all");
      args = allFlag.rest;
      const jsonFlag = hasFlag(args, "--json");
      args = jsonFlag.rest;

      let limit = 20;
      if (allFlag.present) {
        limit = Infinity;
      } else if (limitFlag.value !== undefined) {
        limit = parseInt(limitFlag.value, 10);
        if (Number.isNaN(limit) || limit <= 0) {
          console.error("--limit must be a positive integer.");
          process.exit(1);
        }
      }

      const type = (typeFlag.value ?? "all").toLowerCase();
      const allowedTypes = ["all", "trx", "trc20", "usdt"];
      if (!allowedTypes.includes(type)) {
        console.error(`--type must be one of: ${allowedTypes.join(", ")}`);
        process.exit(1);
      }

      await cmdTransactions(profileFlag.value || args[0], { limit, type, json: jsonFlag.present });
      return;
    }

    if (command === "send-trx") {
      const args = [sub, ...rest].filter(Boolean) as string[];
      const { value: profileFlag, rest: rest2 } = extractFlag(args, "--profile");
      await cmdSendTrx(rest2[0], rest2[1], profileFlag);
      return;
    }

    if (command === "send-usdt") {
      const args = [sub, ...rest].filter(Boolean) as string[];
      const { value: profileFlag, rest: rest2 } = extractFlag(args, "--profile");
      const { value: feeLimitFlag, rest: rest3 } = extractFlag(rest2, "--fee-limit");
      let feeLimit = DEFAULT_USDT_FEE_LIMIT;
      if (feeLimitFlag !== undefined) {
        feeLimit = parseFloat(feeLimitFlag);
        if (Number.isNaN(feeLimit) || feeLimit <= 0 || feeLimit > MAX_FEE_LIMIT) {
          console.error(`--fee-limit must be a number of TRX between 0 and ${MAX_FEE_LIMIT}.`);
          process.exit(1);
        }
      }
      await cmdSendUsdt(rest3[0], rest3[1], profileFlag, feeLimit);
      return;
    }

    if (command === "swap") {
      let args = [sub, ...rest].filter(Boolean) as string[];

      const profileFlag = extractFlag(args, "--profile");
      args = profileFlag.rest;
      const slippageFlag = extractFlag(args, "--slippage");
      args = slippageFlag.rest;
      const reserveFlag = extractFlag(args, "--reserve");
      args = reserveFlag.rest;
      const deadlineFlag = extractFlag(args, "--deadline");
      args = deadlineFlag.rest;
      const quoteFlag = hasFlag(args, "--quote");
      args = quoteFlag.rest;

      const direction = (args[0] ?? "").toLowerCase();
      if (!isSwapDirection(direction)) {
        console.error("Usage: swap <trx-usdt|usdt-trx> <amount> [options]");
        process.exit(1);
      }

      const numericFlag = (raw: string | undefined, fallback: number, label: string, allowZero = false) => {
        if (raw === undefined) return fallback;
        const value = parseFloat(raw);
        if (Number.isNaN(value) || value < 0 || (!allowZero && value === 0)) {
          console.error(`${label} must be a positive number.`);
          process.exit(1);
        }
        return value;
      };

      // 0 is a valid, if impractical, slippage: it pins minOut to the quote.
      const slippage = numericFlag(slippageFlag.value, 0.5, "--slippage", true);
      if (slippage >= 100) {
        console.error("--slippage must be below 100.");
        process.exit(1);
      }

      await cmdSwap(direction, args[1], {
        slippage,
        reserve: numericFlag(reserveFlag.value, DEFAULT_TRX_RESERVE, "--reserve", true),
        deadline: numericFlag(deadlineFlag.value, 10, "--deadline"),
        quoteOnly: quoteFlag.present,
        profile: profileFlag.value,
      });
      return;
    }

    printUsage();
    process.exit(command ? 1 : 0);
  } catch (err: any) {
    console.error("Error:", err?.message || err);
    process.exit(1);
  }
}

main();
