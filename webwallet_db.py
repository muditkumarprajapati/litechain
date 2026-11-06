import aiosqlite
import os
import hashlib
from typing import Dict, List, Optional

DB_PATH = os.path.join(os.path.dirname(__file__), "webwallet.db")

SUPPORTED_COINS = [
    {"symbol": "LTC", "name": "Litecoin", "network": "Litecoin Mainnet", "color": "#345d9d", "icon": "🪙"},
    {"symbol": "BTC", "name": "Bitcoin", "network": "Bitcoin Native SegWit", "color": "#f7931a", "icon": "₿"},
    {"symbol": "ETH", "name": "Ethereum", "network": "Ethereum (ERC20)", "color": "#627eea", "icon": "Ξ"},
    {"symbol": "USDT", "name": "Tether USD", "network": "Tron (TRC20)", "color": "#26a17b", "icon": "₮"},
    {"symbol": "SOL", "name": "Solana", "network": "Solana Mainnet", "color": "#14f195", "icon": "◎"},
    {"symbol": "DOGE", "name": "Dogecoin", "network": "Dogecoin Network", "color": "#c2a633", "icon": "Ð"},
    {"symbol": "BNB", "name": "BNB", "network": "BNB Smart Chain (BEP20)", "color": "#f3ba2f", "icon": "🟡"},
    {"symbol": "TRX", "name": "TRON", "network": "TRON Mainnet", "color": "#ef0027", "icon": "🔴"},
    {"symbol": "XRP", "name": "Ripple", "network": "XRP Ledger", "color": "#23292f", "icon": "✕"}
]

def generate_address_for_coin(coin: str, user_id: int) -> str:
    seed = f"{coin}:{user_id}:webwallet-salt-2026".encode()
    h = hashlib.sha256(seed).hexdigest()
    if coin == "LTC":
        return "L" + h[:33]
    elif coin == "BTC":
        return "bc1q" + h[:38]
    elif coin in ["ETH", "BNB"]:
        return "0x" + h[:40]
    elif coin in ["TRX", "USDT"]:
        return "T" + h[:33]
    elif coin == "SOL":
        return h[:44]
    elif coin == "DOGE":
        return "D" + h[:33]
    elif coin == "XRP":
        return "r" + h[:33]
    return "0x" + h[:40]

async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                discord_id TEXT UNIQUE NOT NULL,
                username TEXT NOT NULL,
                avatar TEXT,
                email TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS wallets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                coin TEXT NOT NULL,
                balance REAL DEFAULT 0.0,
                deposit_address TEXT NOT NULL,
                UNIQUE(user_id, coin)
            )
        """)

        await db.execute("""
            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                type TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                counterparty TEXT,
                coin TEXT NOT NULL,
                amount REAL NOT NULL,
                amount_usd REAL NOT NULL,
                txid TEXT,
                note TEXT,
                status TEXT DEFAULT 'completed',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        await db.commit()

async def get_or_create_user(discord_id: str, username: str, avatar: str = None, email: str = None) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM users WHERE discord_id = ?", (str(discord_id),)) as cur:
            user = await cur.fetchone()
            if not user:
                await db.execute(
                    "INSERT INTO users (discord_id, username, avatar, email) VALUES (?, ?, ?, ?)",
                    (str(discord_id), username, avatar or "", email or "")
                )
                await db.commit()
                async with db.execute("SELECT * FROM users WHERE discord_id = ?", (str(discord_id),)) as cur2:
                    user = await cur2.fetchone()

        user_dict = dict(user)
        user_id = user_dict["id"]

        # Ensure user has wallet entries for each supported coin
        for coin_info in SUPPORTED_COINS:
            coin = coin_info["symbol"]
            async with db.execute("SELECT id FROM wallets WHERE user_id = ? AND coin = ?", (user_id, coin)) as cur:
                if not await cur.fetchone():
                    addr = generate_address_for_coin(coin, user_id)
                    await db.execute(
                        "INSERT OR IGNORE INTO wallets (user_id, coin, balance, deposit_address) VALUES (?, ?, 0.0, ?)",
                        (user_id, coin, addr)
                    )
        await db.commit()
        return user_dict

async def get_user_wallets(user_id: int) -> List[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM wallets WHERE user_id = ?", (user_id,)) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

async def deposit_funds(user_id: int, coin: str, amount: float, amount_usd: float, txid: str = None) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND coin = ?",
            (amount, user_id, coin.upper())
        )
        await db.execute(
            "INSERT INTO transactions (type, user_id, counterparty, coin, amount, amount_usd, txid, note, status) VALUES ('deposit', ?, 'Blockchain Inflow', ?, ?, ?, ?, 'Automated Deposit', 'completed')",
            (user_id, coin.upper(), amount, amount_usd, txid or "on-chain-verified")
        )
        await db.commit()
        return True

async def withdraw_funds(user_id: int, coin: str, amount: float, amount_usd: float, destination_address: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT balance FROM wallets WHERE user_id = ? AND coin = ?", (user_id, coin.upper())) as cur:
            row = await cur.fetchone()
            if not row or row[0] < amount:
                return False

        await db.execute(
            "UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND coin = ?",
            (amount, user_id, coin.upper())
        )
        await db.execute(
            "INSERT INTO transactions (type, user_id, counterparty, coin, amount, amount_usd, txid, note, status) VALUES ('withdrawal', ?, ?, ?, ?, ?, 'payout-broadcast', 'External Withdrawal', 'completed')",
            (user_id, destination_address, coin.upper(), amount, amount_usd)
        )
        await db.commit()
        return True

async def tip_user(sender_id: int, receiver_identifier: str, coin: str, amount: float, amount_usd: float, memo: str = None) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        # Find receiver by discord_id or username
        async with db.execute("SELECT * FROM users WHERE discord_id = ? OR username = ? OR username = ?", 
                              (receiver_identifier, receiver_identifier, receiver_identifier.replace("@", ""))) as cur:
            receiver = await cur.fetchone()
            if not receiver:
                # If receiver doesn't exist yet, auto-create wallet account for them
                r_id = receiver_identifier.replace("@", "")
                receiver = await get_or_create_user(discord_id=r_id, username=r_id)

        rec_user_id = receiver["id"]
        if sender_id == rec_user_id:
            return False

        async with db.execute("SELECT balance FROM wallets WHERE user_id = ? AND coin = ?", (sender_id, coin.upper())) as cur:
            row = await cur.fetchone()
            if not row or row[0] < amount:
                return False

        # Execute internal transfer
        await db.execute("UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND coin = ?", (amount, sender_id, coin.upper()))
        await db.execute("UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND coin = ?", (amount, rec_user_id, coin.upper()))

        # Log for sender
        await db.execute(
            "INSERT INTO transactions (type, user_id, counterparty, coin, amount, amount_usd, note, status) VALUES ('tip_sent', ?, ?, ?, ?, ?, ?, 'completed')",
            (sender_id, f"@{receiver['username']}", coin.upper(), amount, amount_usd, memo or "P2P Tip")
        )
        # Log for receiver
        await db.execute(
            "INSERT INTO transactions (type, user_id, counterparty, coin, amount, amount_usd, note, status) VALUES ('tip_received', ?, ?, ?, ?, ?, ?, 'completed')",
            (rec_user_id, f"Sender #{sender_id}", coin.upper(), amount, amount_usd, memo or "P2P Tip")
        )
        await db.commit()
        return True

async def swap_coins(user_id: int, from_coin: str, to_coin: str, from_amount: float, to_amount: float, usd_value: float) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT balance FROM wallets WHERE user_id = ? AND coin = ?", (user_id, from_coin.upper())) as cur:
            row = await cur.fetchone()
            if not row or row[0] < from_amount:
                return False

        await db.execute("UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND coin = ?", (from_amount, user_id, from_coin.upper()))
        await db.execute("UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND coin = ?", (to_amount, user_id, to_coin.upper()))

        await db.execute(
            "INSERT INTO transactions (type, user_id, counterparty, coin, amount, amount_usd, note, status) VALUES ('swap', ?, ?, ?, ?, ?, ?, 'completed')",
            (user_id, f"{from_coin.upper()} -> {to_coin.upper()}", to_coin.upper(), to_amount, usd_value, f"Swapped {from_amount} {from_coin.upper()} for {to_amount} {to_coin.upper()}")
        )
        await db.commit()
        return True

async def get_user_transactions(user_id: int, limit: int = 50) -> List[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", (user_id, limit)) as cur:
            rows = await cur.fetchall()
            return [dict(r) for r in rows]

async def get_platform_metrics() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT COUNT(*) as users_count FROM users") as cur:
            users_count = (await cur.fetchone())["users_count"]

        async with db.execute("SELECT COUNT(*) as tx_count, COALESCE(SUM(amount_usd), 0.0) as total_volume FROM transactions") as cur:
            row = await cur.fetchone()
            tx_count = row["tx_count"]
            total_vol = row["total_volume"]

        return {
            "users_count": users_count,
            "tx_count": tx_count,
            "total_volume_usd": float(total_vol)
        }

