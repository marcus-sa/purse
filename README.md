# tron-wallet-cli (Bun edition)

Multi-profile Tron wallet CLI using Bun and `bun:sqlite`. Generate keypairs,
store multiple named profiles locally, and send TRX / TRC-20 USDT.

## Setup

```bash
bun install
cp .env.example .env
# optionally set WALLET_MASTER_KEY in .env to encrypt private keys at rest
# optionally set TRONGRID_API_KEY (free at https://www.trongrid.io/)
```

Profiles are stored in a local SQLite DB at `~/.tron-wallet-cli/wallet.db`
by default. Override the location with `WALLET_DATA_DIR` — see
[Storing the DB on Proton Drive](#storing-the-db-on-proton-drive-macos) below.

## Profile management

```bash
# Create a new profile (generates a fresh keypair)
bun index.ts profile add alice

# Import an existing private key as a profile
bun index.ts profile import bob <privateKeyHex>

# List all profiles (marks the active one with *)
bun index.ts profile list

# Set which profile is "active" (used by default for balance/send)
bun index.ts profile use alice

# Show a profile's address; add --reveal to also print the private key
bun index.ts profile show alice
bun index.ts profile show alice --reveal

# Delete a profile
bun index.ts profile remove bob
```

## Wallet commands

```bash
# Check balance for a specific profile, or the active one if omitted
bun index.ts balance
bun index.ts balance alice

# Show transaction history (aliases: txs, history)
bun index.ts transactions
bun index.ts transactions alice

# Last 100 instead of the default 20, or the complete history
bun index.ts transactions --limit 100
bun index.ts transactions --all

# Filter by type, or get machine-readable output
bun index.ts transactions --type usdt
bun index.ts transactions --type trx
bun index.ts transactions --json

# Send TRX / USDT using the active profile
bun index.ts send-trx <toAddress> <amount>
bun index.ts send-usdt <toAddress> <amount>

# Or specify a profile explicitly
bun index.ts send-trx <toAddress> <amount> --profile alice
bun index.ts send-usdt <toAddress> <amount> --profile alice

# Raise or lower the most TRX a USDT send may burn on energy (default 50)
bun index.ts send-usdt <toAddress> <amount> --fee-limit 30

# Check the current rate without swapping anything
bun index.ts swap trx-usdt 100 --quote

# Swap 100 TRX for USDT, or 50 USDT back to TRX
bun index.ts swap trx-usdt 100
bun index.ts swap usdt-trx 50
```

### Transaction history

`transactions` reads history from TronGrid's v1 REST API — TronWeb itself
only exposes single-transaction lookups, with no "list this account's
transactions" call. Two endpoints are merged: native transactions (TRX
transfers, contract calls, staking) and TRC-20 transfer events. A USDT send
appears in both, so the native row is dropped when the TRC-20 stream already
described that txID with real token amounts.

| Option | Meaning |
| --- | --- |
| `--limit <n>` | Number of transactions to show (default 20) |
| `--all` | Fetch the complete history with no limit |
| `--type <trx\|usdt\|trc20\|all>` | Filter by transfer type (default `all`) |
| `--json` | Print raw JSON instead of the table |
| `--profile <name>` | Profile to use, instead of the active one |

Filters are applied while paging, so `--type trx` keeps looking until it has
`--limit` actual TRX transfers rather than filtering one page and giving up.
Filtered scans stop after 5,000 transactions unless you pass `--all`.

If `TRON_FULL_HOST` points at a self-hosted full node, set `TRONGRID_API_HOST`
as well — a bare node serves no `/v1` routes, so history lookups need a
TronGrid host.

### Swapping TRX <-> USDT

`swap` trades against [SunSwap V2](https://sunswap.com/), Tron's Uniswap-V2
fork, by calling its router contract directly — no exchange account, no API
key, and the funds never leave the profile's address.

```bash
# Always free to ask: a constant call, nothing is signed or sent
bun index.ts swap trx-usdt 100 --quote

bun index.ts swap trx-usdt 100 --slippage 1
bun index.ts swap usdt-trx 50 --profile alice
```

| Option | Meaning |
| --- | --- |
| `--quote` | Print the current rate and exit without swapping |
| `--slippage <percent>` | Maximum acceptable slippage (default `0.5`) |
| `--reserve <trx>` | TRX held back to pay fees (default `30`) |
| `--deadline <minutes>` | How long the swap stays valid on-chain (default `10`) |
| `--profile <name>` | Profile to use, instead of the active one |

Each swap quotes the router with `getAmountsOut`, converts that quote into an
`amountOutMin` using `--slippage`, and only then signs. The minimum is what
stops a sandwich bot from taking the trade at an arbitrary price — a swap that
would land below it reverts instead of executing.

Direction matters for what actually happens on-chain:

- **`trx-usdt`** sends native TRX as the call's value, so it's a single
  transaction with no allowance step.
- **`usdt-trx`** is a TRC-20 spend, so the router needs an allowance first.
  The CLI checks the current allowance and only sends an `approve` when it
  falls short — and clears a stale non-zero allowance first, since Tether-style
  tokens reject a non-zero to non-zero approval outright. That makes it up to
  three transactions.

After sending, the CLI waits for the receipt rather than trusting the txID:
`send()` resolves as soon as a node accepts the transaction, which says nothing
about whether it executed. The final "received" figure is read out of the
receipt logs (the token's `Transfer` event, or WTRX's `Withdrawal` for TRX out),
so it's the amount that actually arrived, not the pre-trade quote.

The `--reserve` default keeps 30 TRX back on `trx-usdt` swaps. Swapping a whole
balance leaves nothing to pay the next transaction's bandwidth and energy with,
which is an easy way to strand an account. Set `--reserve 0` if you know what
you're doing.

## Storing the DB on Proton Drive (macOS)

Proton Drive's desktop app syncs a local folder to the cloud, so pointing
`WALLET_DATA_DIR` at a folder inside it works like any other local path —
Proton Drive handles the sync in the background.

1. Find your local Proton Drive sync folder. It's typically:
   ```
   ~/Library/CloudStorage/ProtonDrive-<your-email>/My files
   ```
   (Check Proton Drive's app settings if the exact path differs for you.)

2. Point the CLI at a subfolder there, e.g. in your `.env`:
   ```
   WALLET_DATA_DIR=/Users/yourname/Library/CloudStorage/ProtonDrive-you@proton.me/My files/tron-wallet-cli
   ```
   or export it in your shell profile:
   ```bash
   export WALLET_DATA_DIR="$HOME/Library/CloudStorage/ProtonDrive-you@proton.me/My files/tron-wallet-cli"
   ```

3. Run any command as usual — the `wallet.db` file will be created there and
   Proton Drive will sync it like any other file.

**Important caveats for a synced DB:**

- **Set `WALLET_MASTER_KEY`.** Anything in a cloud-synced folder should be
  treated as "at rest in the cloud" — encrypt the private keys before they
  ever touch Proton's servers, even though Proton Drive itself is
  end-to-end encrypted.
- **Don't run the CLI from two devices at the same time.** SQLite handles
  concurrent access on one machine fine, but two machines writing to the
  same synced file near-simultaneously can create sync conflicts (Proton
  Drive will usually save a conflicted copy rather than corrupt data, but
  you don't want to find that out mid-transaction).
- **Wait for sync to finish** after a write (`profile add`, `send-trx`,
  etc.) before switching to another device, so you're not reading a
  stale/partially-synced copy.
- This CLI pins the DB to SQLite's `DELETE` journal mode specifically
  because it's safer for synced folders than `WAL` mode (which spreads
  writes across extra sidecar files that can desync from the main `.db`
  file).
- Treat it like a shared, syncable secrets file: a proper backup/version
  history (which Proton Drive does provide) is a nice side benefit here,
  but it's not a substitute for exporting/backing up private keys
  separately if you're managing meaningful funds.

## Encryption at rest

If `WALLET_MASTER_KEY` is set in your environment, private keys are encrypted
with AES-256-GCM (key derived via scrypt) before being written to SQLite.
If it's unset, keys are stored in plaintext — fine for local testing, not
recommended for anything holding real funds.

```bash
export WALLET_MASTER_KEY="a long random passphrase"
bun index.ts profile add prod-wallet
```

**Important:** if you lose `WALLET_MASTER_KEY`, encrypted private keys in the
DB become unrecoverable. Back up your master key and/or exported private
keys separately.

### Rotating the passphrase (`rekey`)

```bash
export WALLET_MASTER_KEY="current passphrase"
export WALLET_NEW_MASTER_KEY="new passphrase, 16+ characters"
tron-wallet rekey
```

`rekey` copies the DB to `backups/wallet-<timestamp>.db`, decrypts every profile
with the old key, checks that each private key still derives its stored address,
then re-encrypts all of them in one SQLite transaction. If any profile fails,
nothing is changed. Secrets are read from the environment only, never from
arguments. Afterwards, set `WALLET_MASTER_KEY` to the new value. The backup is
still encrypted with the OLD key, so delete it once you are satisfied. Rotating
the passphrase does not protect copies of the DB that were already encrypted
under the old one.

## Making it globally runnable (optional)

```bash
chmod +x index.ts
bun link
tron-wallet profile list
```

## Notes

- New addresses need a small amount of TRX before sending anything, since
  Tron transactions consume TRX for bandwidth/energy.
- `--fee-limit` in send-usdt is a cap, not a fixed cost — you only pay
  for the energy actually used. Without staked energy a USDT transfer burns
  ~65k energy (~130k to an address that has never held USDT), which can
  cost well over 10 TRX; if the cap is too low the transfer reverts with
  `OUT_OF_ENERGY` and the burned TRX is still lost. Swaps use a higher cap (100 TRX) because they touch
  the router, the pool and the TRX wrapper in one transaction.
- Never commit `.env`, the SQLite DB file, or logs containing revealed keys.
