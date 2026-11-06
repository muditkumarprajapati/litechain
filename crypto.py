import aiohttp
import asyncio
import time
import re
from typing import Tuple, Dict, Any, Optional

class CryptoService:
    def __init__(self):
        self._cached_price_data: Optional[Dict[str, Any]] = None
        self._last_price_fetch: float = 0.0
        self._cache_ttl = 45.0  # seconds

    async def get_ltc_market(self) -> Dict[str, Any]:
        """Fetch current LTC market data from CoinGecko or Binance with caching."""
        now = time.time()
        if self._cached_price_data and (now - self._last_price_fetch < self._cache_ttl):
            return self._cached_price_data

        # Try Binance API first (fast & reliable)
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get("https://api.binance.com/api/v3/ticker/24hr?symbol=LTCUSDT", timeout=4) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        price = float(data.get("lastPrice", 90.0))
                        change = float(data.get("priceChangePercent", 0.0))
                        high = float(data.get("highPrice", price))
                        low = float(data.get("lowPrice", price))
                        vol = float(data.get("quoteVolume", 0.0))
                        
                        self._cached_price_data = {
                            "price": round(price, 2),
                            "change_24h": round(change, 2),
                            "high_24h": round(high, 2),
                            "low_24h": round(low, 2),
                            "volume": round(vol, 2),
                            "source": "Binance"
                        }
                        self._last_price_fetch = now
                        return self._cached_price_data
        except Exception:
            pass

        # Fallback to CoinGecko
        try:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    "https://api.coingecko.com/api/v3/simple/price?ids=litecoin&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true",
                    timeout=5
                ) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        ltc = data.get("litecoin", {})
                        price = float(ltc.get("usd", 90.0))
                        change = float(ltc.get("usd_24h_change", 0.0))
                        vol = float(ltc.get("usd_24h_vol", 0.0))

                        self._cached_price_data = {
                            "price": round(price, 2),
                            "change_24h": round(change, 2),
                            "high_24h": round(price * 1.05, 2),
                            "low_24h": round(price * 0.95, 2),
                            "volume": round(vol, 2),
                            "source": "CoinGecko"
                        }
                        self._last_price_fetch = now
                        return self._cached_price_data
        except Exception:
            pass

        # If previously cached data exists, return that even if expired
        if self._cached_price_data:
            return self._cached_price_data

        # Final static fallback if completely offline
        return {
            "price": 90.00,
            "change_24h": 0.00,
            "high_24h": 92.50,
            "low_24h": 87.50,
            "volume": 25000000.0,
            "source": "Fallback"
        }

    async def get_current_price(self) -> float:
        data = await self.get_ltc_market()
        return float(data.get("price", 90.0))

    def parse_amount(self, text: str, ltc_price: float) -> Tuple[float, float, str]:
        """
        Parses amount input from user:
        - 20$, $20, 20.50$, $20.50 -> USD mode
        - 20, 0.05, 20ltc, 0.5 ltc -> LTC mode
        Returns (amount_usd, amount_ltc, mode_str)
        """
        raw = text.strip().lower()
        if not raw:
            raise ValueError("Amount cannot be empty.")

        # Check for USD symbols: $, usd
        is_usd = False
        if raw.startswith("$") or raw.endswith("$"):
            is_usd = True
            raw = raw.replace("$", "").strip()
        elif raw.endswith("usd"):
            is_usd = True
            raw = raw[:-3].strip()
        elif raw.endswith("ltc"):
            is_usd = False
            raw = raw[:-3].strip()

        try:
            val = float(raw)
        except ValueError:
            raise ValueError(f"Invalid numeric amount: `{text}`")

        if val <= 0:
            raise ValueError("Amount must be greater than zero.")

        if is_usd:
            amount_usd = val
            amount_ltc = val / ltc_price if ltc_price > 0 else 0.0
            mode = "USD"
        else:
            amount_ltc = val
            amount_usd = val * ltc_price
            mode = "LTC"

        return round(amount_usd, 4), round(amount_ltc, 8), mode

    async def verify_ltc_transaction(self, txid: str, deposit_address: str) -> Tuple[bool, float, str]:
        """
        Verifies a transaction hash on the Litecoin blockchain.
        Checks if output contains deposit_address and returns LTC amount received.
        """
        clean_txid = txid.strip().lower()
        if not re.match(r"^[a-f0-9]{64}$", clean_txid):
            return False, 0.0, "Invalid TXID format. Litecoin transaction hashes are 64 hex characters."

        # 1. Try Blockchair API
        try:
            async with aiohttp.ClientSession() as session:
                url = f"https://api.blockchair.com/litecoin/dashboards/transaction/{clean_txid}"
                async with session.get(url, timeout=8) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        tx_data = data.get("data", {}).get(clean_txid)
                        if tx_data:
                            outputs = tx_data.get("outputs", [])
                            total_sats = 0
                            for out in outputs:
                                recipient = out.get("recipient")
                                if recipient and recipient.strip() == deposit_address.strip():
                                    total_sats += out.get("value", 0)

                            if total_sats > 0:
                                ltc_val = total_sats / 100000000.0
                                return True, round(ltc_val, 8), "Verified via Blockchair"
                            else:
                                return False, 0.0, f"Transaction found, but no output sent to bot address `{deposit_address}`."
        except Exception:
            pass

        # 2. Try SoChain API
        try:
            async with aiohttp.ClientSession() as session:
                url = f"https://chain.so/api/v2/get_tx/LTC/{clean_txid}"
                async with session.get(url, timeout=8) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        tx = data.get("data", {})
                        outputs = tx.get("outputs", [])
                        total_ltc = 0.0
                        for out in outputs:
                            address = out.get("address")
                            if address and address.strip() == deposit_address.strip():
                                total_ltc += float(out.get("value", 0.0))

                        if total_ltc > 0:
                            return True, round(total_ltc, 8), "Verified via SoChain"
                        else:
                            return False, 0.0, f"Transaction found, but no output sent to bot address `{deposit_address}`."
        except Exception:
            pass

        # 3. Try litecoinspace / mempool API
        try:
            async with aiohttp.ClientSession() as session:
                url = f"https://litecoinspace.org/api/tx/{clean_txid}"
                async with session.get(url, timeout=8) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        vout = data.get("vout", [])
                        total_sats = 0
                        for out in vout:
                            scriptpubkey_address = out.get("scriptpubkey_address")
                            if scriptpubkey_address and scriptpubkey_address.strip() == deposit_address.strip():
                                total_sats += out.get("value", 0)

                        if total_sats > 0:
                            ltc_val = total_sats / 100000000.0
                            return True, round(ltc_val, 8), "Verified via LitecoinSpace"
                        else:
                            return False, 0.0, f"Transaction found, but no output sent to bot address `{deposit_address}`."
        except Exception:
            pass

        return False, 0.0, "Transaction not found on Litecoin network or still unconfirmed. Please wait a few moments and try again."

crypto_service = CryptoService()

