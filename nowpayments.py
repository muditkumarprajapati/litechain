"""
WebWallet — NOWPayments Real Blockchain Integration Engine
Handles automated real deposit address generation, on-chain transaction monitoring,
and Instant Payment Notification (IPN) webhook verification.
"""

import os
import json
import hmac
import hashlib
import time
import logging
import asyncio
import aiohttp
import aiosqlite
from typing import Dict, Any, Optional

logger = logging.getLogger("NOWPayments")

NOWPAYMENTS_API_KEY = os.getenv("NOWPAYMENTS_API_KEY", "9B3AB5J-BDBM9G5-QJNVX1H-EE47G3P")
NOWPAYMENTS_IPN_SECRET = os.getenv("NOWPAYMENTS_IPN_SECRET", "un+D9DxR6APXm0z2LLE3HM5jW1bmwH03")
NOWPAYMENTS_CALLBACK_URL = os.getenv("NOWPAYMENTS_CALLBACK_URL", "https://webwallet-jqgx.onrender.com/api/nowpayments/ipn")
NOWPAYMENTS_API_BASE = "https://api.nowpayments.io/v1"

DB_PATH = os.path.join(os.path.dirname(__file__), "webwallet.db")

COIN_MAPPINGS = {
    "BTC": "btc",
    "ETH": "eth",
    "LTC": "ltc",
    "DOGE": "doge",
    "SOL": "sol",
    "TRX": "trx",
    "BCH": "bch",
    "TON": "ton",
    "BNB": "bnbbsc",
    "XRP": "xrp",
    "AVAX": "avaxc",
    "POL": "maticmainnet",
}

def map_symbol_to_nowpayments(coin: str, network: str = "") -> str:
    c = coin.upper()
    net = (network or "").upper()
    if c == "USDT":
        if "TRC" in net or "TRON" in net:
            return "usdttrc20"
        elif "BSC" in net or "BEP" in net:
            return "usdtbsc"
        elif "SOL" in net:
            return "usdtsol"
        elif "TON" in net:
            return "usdtton"
        return "usdterc20"
    if c == "USDC":
        if "SOL" in net:
            return "usdcsol"
        elif "BSC" in net:
            return "usdcbsc"
        return "usdc"
    return COIN_MAPPINGS.get(c, c.lower())

async def init_nowpayments_db():
    """Ensure database table exists for persistent real deposit address tracking."""
    async with aiosqlite.connect(DB_PATH) as conn:
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS nowpayments_deposits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                coin TEXT NOT NULL,
                network TEXT,
                pay_address TEXT NOT NULL,
                payment_id TEXT NOT NULL,
                status TEXT DEFAULT 'waiting',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        """)
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_np_pay_address ON nowpayments_deposits (pay_address);")
        await conn.execute("CREATE INDEX IF NOT EXISTS idx_np_payment_id ON nowpayments_deposits (payment_id);")
        await conn.commit()

async def get_or_create_real_deposit_address(user_id: int, coin: str, network: str = "") -> Dict[str, Any]:
    """
    Retrieves an existing cached real deposit address for (user_id, coin)
    or contacts NOWPayments API to generate a new genuine on-chain payment address.
    """
    await init_nowpayments_db()
    coin = coin.upper()

    # 1. Check if user already has an active deposit address for this coin/network
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("""
            SELECT pay_address, payment_id FROM nowpayments_deposits
            WHERE user_id = ? AND coin = ? AND (network = ? OR network IS NULL OR network = '')
            ORDER BY id DESC LIMIT 1
        """, (user_id, coin, network))
        row = await cur.fetchone()
        if row and row["pay_address"]:
            # Ensure the wallets table is synchronized
            await conn.execute("""
                UPDATE wallets SET deposit_address = ?
                WHERE user_id = ? AND coin = ?
            """, (row["pay_address"], user_id, coin))
            await conn.commit()
            return {
                "success": True,
                "address": row["pay_address"],
                "payment_id": row["payment_id"],
                "coin": coin,
                "network": network,
                "is_cached": True
            }

    # 2. Call NOWPayments API to generate a real address
    pay_currency = map_symbol_to_nowpayments(coin, network)
    order_id = f"usr_{user_id}_{coin}_{int(time.time())}"

    payload = {
        "price_amount": 10,
        "price_currency": "usd",
        "pay_currency": pay_currency,
        "ipn_callback_url": NOWPAYMENTS_CALLBACK_URL,
        "order_id": order_id,
        "order_description": f"WebWallet Deposit - {coin} (User {user_id})"
    }

    try:
        async with aiohttp.ClientSession() as session:
            headers = {
                "x-api-key": NOWPAYMENTS_API_KEY,
                "Content-Type": "application/json"
            }
            async with session.post(f"{NOWPAYMENTS_API_BASE}/payment", json=payload, headers=headers, timeout=10) as resp:
                data = await resp.json()
                if resp.status in [200, 201] and data.get("pay_address"):
                    pay_address = data["pay_address"]
                    payment_id = str(data.get("payment_id", ""))

                    # Save to nowpayments_deposits and update wallets table
                    async with aiosqlite.connect(DB_PATH) as conn:
                        await conn.execute("""
                            INSERT INTO nowpayments_deposits (user_id, coin, network, pay_address, payment_id, status)
                            VALUES (?, ?, ?, ?, ?, 'waiting')
                        """, (user_id, coin, network, pay_address, payment_id))
                        await conn.execute("""
                            UPDATE wallets SET deposit_address = ?
                            WHERE user_id = ? AND coin = ?
                        """, (pay_address, user_id, coin))
                        await conn.commit()

                    logger.info(f"Generated real NOWPayments address for user {user_id} ({coin}): {pay_address}")
                    return {
                        "success": True,
                        "address": pay_address,
                        "payment_id": payment_id,
                        "coin": coin,
                        "network": network,
                        "is_cached": False
                    }
                else:
                    logger.error(f"NOWPayments API error: {data}")
                    return {"success": False, "error": data.get("message", "Failed to generate on-chain address")}
    except Exception as e:
        logger.error(f"NOWPayments exception: {e}")
        return {"success": False, "error": str(e)}

def verify_ipn_signature(raw_data: dict, received_signature: str) -> bool:
    """Verifies HMAC-SHA512 signature from NOWPayments IPN."""
    if not received_signature or not NOWPAYMENTS_IPN_SECRET:
        return False
    try:
        sorted_dict = dict(sorted(raw_data.items()))
        sorted_json = json.dumps(sorted_dict, separators=(",", ":"))
        calculated_sig = hmac.new(
            NOWPAYMENTS_IPN_SECRET.encode("utf-8"),
            sorted_json.encode("utf-8"),
            hashlib.sha512
        ).hexdigest()
        return hmac.compare_digest(calculated_sig.lower(), received_signature.lower())
    except Exception as e:
        logger.error(f"IPN signature verification exception: {e}")
        return False

async def handle_ipn_notification(data: dict) -> Dict[str, Any]:
    """
    Processes incoming IPN webhook, confirms on-chain deposit, and credits user wallet balance.
    """
    payment_id = str(data.get("payment_id", ""))
    payment_status = str(data.get("payment_status", "")).lower()
    pay_address = data.get("pay_address", "")
    pay_currency = data.get("pay_currency", "").upper()
    actually_paid = float(data.get("actually_paid") or data.get("pay_amount") or 0.0)
    order_id = str(data.get("order_id", ""))

    logger.info(f"NOWPayments IPN: status={payment_status}, pay_id={payment_id}, coin={pay_currency}, amount={actually_paid}")

    # Determine user_id
    user_id = None
    async with aiosqlite.connect(DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("SELECT user_id, coin, network FROM nowpayments_deposits WHERE pay_address = ? LIMIT 1", (pay_address,))
        row = await cur.fetchone()
        if row:
            user_id = row["user_id"]
            coin = row["coin"]
            network = row["network"]
        elif order_id.startswith("usr_"):
            parts = order_id.split("_")
            try:
                user_id = int(parts[1])
                coin = parts[2].upper()
                network = coin
            except Exception:
                pass

        if not user_id:
            logger.warning(f"Could not map NOWPayments deposit to user: address={pay_address}, order_id={order_id}")
            return {"success": False, "error": "User not found"}

        # If payment status is confirmed, finished, or sending, credit the funds
        if payment_status in ["finished", "confirmed", "sending"]:
            # Check if this payment_id has already been credited
            cur_tx = await conn.execute("SELECT id FROM transactions WHERE tx_hash = ?", (f"np_{payment_id}",))
            if await cur_tx.fetchone():
                return {"success": True, "already_processed": True}

            # Credit user wallet
            await conn.execute("""
                INSERT INTO wallets (user_id, coin, network, balance, deposit_address)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(user_id, coin, network) DO UPDATE SET
                balance = balance + excluded.balance,
                updated_at = CURRENT_TIMESTAMP
            """, (user_id, coin, network, actually_paid, pay_address))

            # Record in transactions table
            memo = f"NOWPayments Verified On-Chain Inflow ({payment_status.upper()})"
            await conn.execute("""
                INSERT INTO transactions (
                    tx_hash, user_id, type, coin, network, amount, amount_usd, fee, destination, memo, status, confirmations, required_confirmations
                ) VALUES (?, ?, 'DEPOSIT', ?, ?, ?, ?, 0.0, ?, ?, 'COMPLETED', 12, 12)
            """, (f"np_{payment_id}", user_id, coin, network, actually_paid, round(float(data.get("price_amount", 0.0)), 2), pay_address, memo))

            # Update status in nowpayments_deposits
            await conn.execute("UPDATE nowpayments_deposits SET status = ? WHERE payment_id = ?", (payment_status, payment_id))
            await conn.commit()

            logger.info(f"Successfully credited user {user_id}: {actually_paid} {coin} (Payment {payment_id})")
            return {"success": True, "credited": True, "user_id": user_id, "amount": actually_paid, "coin": coin}

        # If not finished yet, just update status
        await conn.execute("UPDATE nowpayments_deposits SET status = ? WHERE payment_id = ?", (payment_status, payment_id))
        await conn.commit()
        return {"success": True, "status": payment_status}
