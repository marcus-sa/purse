import { Database } from "bun:sqlite";
import { homedir } from "os";
import { join } from "path";
import { mkdirSync, existsSync } from "fs";

// Store the DB in ~/.purse/wallet.db by default so it's not tied to whatever
// directory you happen to run the command from. Before the rename to purse the
// default was ~/.tron-wallet-cli; keep using it when that is where the data is,
// rather than silently starting an empty wallet.
const LEGACY_DATA_DIR = join(homedir(), ".tron-wallet-cli");
const DEFAULT_DATA_DIR = join(homedir(), ".purse");
const DATA_DIR =
  process.env.WALLET_DATA_DIR ||
  (!existsSync(DEFAULT_DATA_DIR) && existsSync(LEGACY_DATA_DIR) ? LEGACY_DATA_DIR : DEFAULT_DATA_DIR);
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = join(DATA_DIR, "wallet.db");
const db = new Database(DB_PATH);

// If this DB file lives in a synced cloud folder (Proton Drive, Dropbox, etc.),
// avoid WAL mode: it creates -wal/-shm sidecar files that can desync or
// corrupt if the sync client uploads mid-write. DELETE mode keeps everything
// in the single .db file and is the safer choice for a synced folder.
db.run(`PRAGMA journal_mode = DELETE;`);
db.run(`PRAGMA synchronous = FULL;`);

db.run(`
  CREATE TABLE IF NOT EXISTS profiles (
    name TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    private_key TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )
`);

// Profiles predating Solana support have no chain column; they are all Tron.
const profileColumns = db.query(`PRAGMA table_info(profiles)`).all() as { name: string }[];
if (!profileColumns.some((c) => c.name === "chain")) {
  db.run(`ALTER TABLE profiles ADD COLUMN chain TEXT NOT NULL DEFAULT 'tron'`);
}

db.run(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

export type Chain = "tron" | "solana";

export const CHAINS: readonly Chain[] = ["tron", "solana"];

export function isChain(value: string): value is Chain {
  return (CHAINS as readonly string[]).includes(value);
}

export interface Profile {
  name: string;
  chain: Chain;
  address: string;
  private_key: string;
  encrypted: number;
  created_at: string;
}

export function insertProfile(profile: Omit<Profile, "created_at">) {
  db.run(
    `INSERT INTO profiles (name, chain, address, private_key, encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [profile.name, profile.chain, profile.address, profile.private_key, profile.encrypted, new Date().toISOString()]
  );
}

export function getProfile(name: string): Profile | null {
  const row = db.query(`SELECT * FROM profiles WHERE name = ?`).get(name) as Profile | null;
  return row ?? null;
}

export function listProfiles(): Profile[] {
  return db.query(`SELECT * FROM profiles ORDER BY created_at ASC`).all() as Profile[];
}

export function deleteProfile(name: string) {
  db.run(`DELETE FROM profiles WHERE name = ?`, [name]);
}

// Replaces the stored private keys of many profiles in one transaction, so a
// failure part-way leaves every row untouched. Rows are marked encrypted.
export function replaceProfileKeys(updates: { name: string; private_key: string }[]) {
  const stmt = db.prepare(`UPDATE profiles SET private_key = ?, encrypted = 1 WHERE name = ?`);
  const apply = db.transaction((rows: { name: string; private_key: string }[]) => {
    for (const row of rows) {
      const result = stmt.run(row.private_key, row.name);
      if (result.changes !== 1) throw new Error(`Profile "${row.name}" was not updated.`);
    }
  });
  apply(updates);
}

export function setSetting(key: string, value: string) {
  db.run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  );
}

export function getSetting(key: string): string | null {
  const row = db.query(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function getActiveProfileName(): string | null {
  return getSetting("active_profile");
}

export { DB_PATH };
