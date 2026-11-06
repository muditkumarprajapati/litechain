"""
WebWallet - Enterprise Multi-Cryptocurrency Platform Server
Production-grade REST APIs, Discord OAuth2 with Guild Join Permissions,
Email/Password Authentication, Multi-Chain Wallet Management, Admin Center & Member Puller.
"""

import os
import json
import time
import logging
import uuid
import secrets
import hashlib
from typing import Optional, Dict, Any, List, Tuple
import aiohttp
from aiohttp import web
import wallet_db as db
from wallet_db import SUPPORTED_ASSETS
from market import market_service

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(name)s: %(message)s")
logger = logging.getLogger("WebWallet")

BASE_DIR = os.path.dirname(__file__)
STATIC_DIR = os.path.join(BASE_DIR, "static")
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")

# Discord Application Credentials (Updated to user's new bot token)
DISCORD_CLIENT_ID = os.getenv("DISCORD_CLIENT_ID", "1567143272936116394")
DISCORD_CLIENT_SECRET = os.getenv("DISCORD_CLIENT_SECRET", "")
DISCORD_BOT_TOKEN = os.getenv("DISCORD_BOT_TOKEN", "")
DISCORD_REDIRECT_URI = os.getenv("DISCORD_REDIRECT_URI", "http://localhost:8080/api/auth/discord/callback")

# Active Sessions (in-memory fast cache backed by persistent SQLite user_sessions table)
sessions = {}

def extract_token(request: web.Request) -> Optional[str]:
    """Extract auth session token from Bearer header, X-Session-Token, or cookie."""
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:].strip()
        if token:
            return token
    x_token = request.headers.get("X-Session-Token", "").strip()
    if x_token:
        return x_token
    return request.cookies.get("webwallet_session")

async def get_current_user_id(request: web.Request) -> Optional[int]:
    """Retrieve verified user ID from active session with DB persistence fallback."""
    token = extract_token(request)
    if not token:
        return None
    if token in sessions:
        return sessions[token]["user_id"]
    uid = await db.get_session_user_id(token)
    if uid:
        sessions[token] = {"user_id": uid, "created_at": time.time()}
        return uid
    return None

async def generate_and_save_session(user_id: int) -> str:
    """Generate cryptographically secure session token and persist to database and RAM cache."""
    session_token = secrets.token_hex(32)
    sessions[session_token] = {"user_id": user_id, "created_at": time.time()}
    await db.save_session(session_token, user_id)
    return session_token

def set_session_cookie(resp: web.Response, session_token: str):
    """Set root-scoped persistent authentication cookie."""
    resp.set_cookie(
        "webwallet_session",
        session_token,
        max_age=86400 * 30, # 30 days
        path="/",           # CRUCIAL: root path so cookie is sent to all routes!
        httponly=False,
        samesite="Lax"
    )

async def handle_home(request: web.Request):
    html_path = os.path.join(TEMPLATES_DIR, "home.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return web.Response(text=f.read(), content_type="text/html")
    return await handle_index(request)

async def handle_terms(request: web.Request):
    html_path = os.path.join(TEMPLATES_DIR, "terms.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return web.Response(text=f.read(), content_type="text/html")
    return web.Response(text="<h1>Terms of Service Template Missing</h1>", content_type="text/html", status=404)

async def handle_index(request: web.Request):
    html_path = os.path.join(TEMPLATES_DIR, "index.html")
    if os.path.exists(html_path):
        with open(html_path, "r", encoding="utf-8") as f:
            return web.Response(text=f.read(), content_type="text/html")
    return web.Response(text="<h1>WebWallet Application Template Missing</h1>", content_type="text/html", status=404)

# ================= AUTHENTICATION APIS =================

async def handle_auth_me(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"authenticated": False})

    import aiosqlite
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("""
            SELECT id, discord_id, username, avatar, email, is_admin, is_2fa_enabled, currency, created_at, last_login
            FROM users WHERE id = ?
        """, (uid,))
        user = await cur.fetchone()
        if not user:
            return web.json_response({"authenticated": False})
        return web.json_response({
            "authenticated": True,
            "user": dict(user)
        })

async def handle_auth_email_register(request: web.Request):
    data = await request.json() if request.can_read_body else {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip()
    username = data.get("username", "").strip()

    if not email or "@" not in email:
        return web.json_response({"error": "Please provide a valid email address"}, status=400)
    if not password or len(password) < 6:
        return web.json_response({"error": "Password must be at least 6 characters long"}, status=400)
    if not username or len(username) < 2:
        return web.json_response({"error": "Username must be at least 2 characters long"}, status=400)

    result = await db.register_email_user(email, password, username)
    if not result["success"]:
        return web.json_response(result, status=400)

    user = result["user"]
    session_token = await generate_and_save_session(user["id"])

    resp = web.json_response({"success": True, "user": user, "token": session_token})
    set_session_cookie(resp, session_token)
    return resp

async def handle_auth_email_login(request: web.Request):
    data = await request.json() if request.can_read_body else {}
    email = data.get("email", "").strip()
    password = data.get("password", "").strip()

    if not email or not password:
        return web.json_response({"error": "Email and password are required"}, status=400)

    result = await db.login_email_user(email, password)
    if not result["success"]:
        return web.json_response(result, status=401)

    user = result["user"]
    session_token = await generate_and_save_session(user["id"])

    resp = web.json_response({"success": True, "user": user, "token": session_token})
    set_session_cookie(resp, session_token)
    return resp

async def handle_auth_login_passcode(request: web.Request):
    data = await request.json() if request.can_read_body else {}
    identifier = data.get("identifier", "").strip()
    pin = data.get("pin", "").strip()

    if not identifier or not pin:
        return web.json_response({"error": "Identifier and Security PIN are required"}, status=400)

    import aiosqlite
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("""
            SELECT * FROM users WHERE discord_id = ? OR LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)
        """, (identifier, identifier, identifier))
        user = await cur.fetchone()

        if not user:
            return web.json_response({"error": "User not found. Please register an account first."}, status=404)

        is_valid = await db.verify_user_pin(user["id"], pin)
        if not is_valid:
            return web.json_response({"error": "Invalid Security PIN or Secret Key. Access denied."}, status=401)

        session_token = await generate_and_save_session(user["id"])

        resp = web.json_response({
            "success": True,
            "user": {
                "id": user["id"],
                "discord_id": user["discord_id"],
                "username": user["username"],
                "avatar": user["avatar"],
                "is_admin": user["is_admin"]
            },
            "token": session_token
        })
        set_session_cookie(resp, session_token)
        return resp

async def handle_auth_discord_login(request: web.Request):
    state = secrets.token_urlsafe(16)
    # If client secret is configured in environment, use code flow; otherwise use implicit token grant
    resp_type = "code" if DISCORD_CLIENT_SECRET else "token"
    oauth_url = (
        f"https://discord.com/api/oauth2/authorize?client_id={DISCORD_CLIENT_ID}"
        f"&redirect_uri={DISCORD_REDIRECT_URI}&response_type={resp_type}&scope=identify%20email%20guilds.join&state={state}"
    )
    raise web.HTTPFound(oauth_url)

async def handle_auth_discord_callback(request: web.Request):
    code = request.query.get("code")
    error = request.query.get("error")

    if error:
        raise web.HTTPFound(f"/?error={error}")

    # If code is provided and DISCORD_CLIENT_SECRET is available, exchange it server-side
    if code and DISCORD_CLIENT_SECRET:
        try:
            async with aiohttp.ClientSession() as session:
                payload = {
                    "client_id": DISCORD_CLIENT_ID,
                    "client_secret": DISCORD_CLIENT_SECRET,
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": DISCORD_REDIRECT_URI
                }
                headers = {"Content-Type": "application/x-www-form-urlencoded"}
                async with session.post("https://discord.com/api/oauth2/token", data=payload, headers=headers) as token_resp:
                    token_data = await token_resp.json()
                    access_token = token_data.get("access_token")
                    refresh_token = token_data.get("refresh_token", "")

                if not access_token:
                    raise Exception("Failed to retrieve Discord access token")

                async with session.get("https://discord.com/api/users/@me", headers={"Authorization": f"Bearer {access_token}"}) as user_resp:
                    u = await user_resp.json()

                discord_id = str(u["id"])
                username = u.get("global_name") or u.get("username", "DiscordUser")
                avatar_hash = u.get("avatar")
                avatar_url = f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png" if avatar_hash else "https://cdn.discordapp.com/embed/avatars/0.png"
                email = u.get("email", "")

                is_admin = 1 if discord_id == db.OWNER_DISCORD_ID else 0

                user = await db.get_or_create_user(
                    discord_id=discord_id,
                    username=username,
                    avatar=avatar_url,
                    email=email,
                    is_admin=is_admin,
                    access_token=access_token,
                    refresh_token=refresh_token
                )
                session_token = await generate_and_save_session(user["id"])

                resp = web.HTTPFound("/app?login_success=1")
                set_session_cookie(resp, session_token)
                return resp
        except Exception as e:
            logger.error(f"Discord OAuth2 Exception: {e}")
            raise web.HTTPFound("/?error=auth_failed")

    # If implicit token grant (or client secret not set), serve fast client-side redirect handler
    callback_html = """<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Authenticating with Discord...</title>
  <style>
    body { background: #060911; color: #fff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .loader { text-align: center; }
    .spinner { width: 44px; height: 44px; border: 4px solid rgba(255,255,255,0.1); border-top-color: #5865F2; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <div style="font-weight: 700; font-size: 1.15rem; margin-bottom: 6px;">Authenticating with Discord...</div>
    <div style="color: #94a3b8; font-size: 0.85rem;">Securing your WebWallet session</div>
  </div>
  <script>
    (async function() {
      const hash = window.location.hash.substring(1);
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      const searchParams = new URLSearchParams(window.location.search);
      const error = searchParams.get('error');

      if (error) {
        window.location.href = '/?error=' + encodeURIComponent(error);
        return;
      }

      if (accessToken) {
        try {
          const res = await fetch('/api/auth/discord/token-login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ access_token: accessToken })
          });
          const data = await res.json();
          if (data.success) {
            if (data.token) {
              localStorage.setItem('webwallet_session_token', data.token);
            }
            window.location.href = '/app?login_success=1';
          } else {
            window.location.href = '/?error=' + encodeURIComponent(data.error || 'Authentication failed');
          }
        } catch (e) {
          window.location.href = '/?error=connection_failed';
        }
      } else {
        window.location.href = '/app';
      }
    })();
  </script>
</body>
</html>"""
    return web.Response(text=callback_html, content_type="text/html")

async def handle_auth_discord_token_login(request: web.Request):
    data = await request.json() if request.can_read_body else {}
    access_token = data.get("access_token", "").strip()

    if not access_token:
        return web.json_response({"error": "Missing Discord access token"}, status=400)

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get("https://discord.com/api/users/@me", headers={"Authorization": f"Bearer {access_token}"}) as user_resp:
                if user_resp.status != 200:
                    return web.json_response({"error": "Failed to verify Discord session with Discord API"}, status=401)
                u = await user_resp.json()

        discord_id = str(u["id"])
        username = u.get("global_name") or u.get("username", "DiscordUser")
        avatar_hash = u.get("avatar")
        avatar_url = f"https://cdn.discordapp.com/avatars/{discord_id}/{avatar_hash}.png" if avatar_hash else "https://cdn.discordapp.com/embed/avatars/0.png"
        email = u.get("email", "")

        is_admin = 1 if discord_id == db.OWNER_DISCORD_ID else 0

        user = await db.get_or_create_user(
            discord_id=discord_id,
            username=username,
            avatar=avatar_url,
            email=email,
            is_admin=is_admin,
            access_token=access_token
        )
        session_token = await generate_and_save_session(user["id"])

        resp = web.json_response({"success": True, "user": user, "token": session_token})
        set_session_cookie(resp, session_token)
        return resp
    except Exception as e:
        logger.error(f"Discord Token Login Exception: {e}")
        return web.json_response({"error": "Discord authentication failed"}, status=500)

async def handle_auth_discord_direct(request: web.Request):
    """
    Direct Discord login using Discord username or User ID.
    Always logs in as THAT specific user with is_admin=0 (unless their ID is the master admin ID).
    """
    data = await request.json() if request.can_read_body else {}
    username = data.get("username", "").strip()
    discord_id = data.get("discord_id", "").strip()

    if not username and not discord_id:
        return web.json_response({"error": "Please provide your Discord username or Discord ID"}, status=400)

    if not discord_id:
        # Deterministic ID for this username
        clean_user = username.lower().replace(" ", "_")
        h = hashlib.md5(clean_user.encode()).hexdigest()[:14]
        discord_id = f"discord_{h}"

    if not username:
        username = f"Discord_{discord_id[-6:]}"

    avatar = f"https://api.dicebear.com/7.x/identicon/svg?seed={username}"

    # Only master owner gets admin; normal users ALWAYS get is_admin=0
    is_admin = 1 if discord_id == db.OWNER_DISCORD_ID else 0

    user = await db.get_or_create_user(
        discord_id=discord_id,
        username=username,
        avatar=avatar,
        is_admin=is_admin,
        access_token=f"direct_token_{secrets.token_hex(16)}"
    )

    session_token = await generate_and_save_session(user["id"])

    resp = web.json_response({"success": True, "user": user, "token": session_token})
    set_session_cookie(resp, session_token)
    return resp

async def handle_auth_logout(request: web.Request):
    token = extract_token(request)
    if token:
        if token in sessions:
            del sessions[token]
        await db.delete_session(token)
    resp = web.json_response({"success": True})
    resp.del_cookie("webwallet_session", path="/")
    return resp

# ================= WALLET & PORTFOLIO APIS =================

async def handle_wallet_portfolio(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    wallets = await db.get_user_wallets(uid)
    market_data = await market_service.get_all_prices()
    prices = market_data["prices"]
    changes = market_data["changes_24h"]

    meta_map = {a["symbol"]: a for a in SUPPORTED_ASSETS}

    total_usd = 0.0
    assets_grouped = {}

    for w in wallets:
        coin = w["coin"]
        net = w["network"]
        bal = float(w["balance"])
        price = prices.get(coin, 1.0)
        usd_val = bal * price
        total_usd += usd_val

        meta = meta_map.get(coin, {})

        if coin not in assets_grouped:
            assets_grouped[coin] = {
                "symbol": coin,
                "name": meta.get("name", coin),
                "icon": meta.get("icon", "🪙"),
                "icon_url": meta.get("icon_url", ""),
                "color": meta.get("color", "#00f2fe"),
                "total_balance": 0.0,
                "price_usd": price,
                "change_24h": changes.get(coin, 0.0),
                "total_usd": 0.0,
                "networks": []
            }

        assets_grouped[coin]["total_balance"] += bal
        assets_grouped[coin]["total_usd"] += usd_val
        assets_grouped[coin]["networks"].append({
            "network": net,
            "balance": bal,
            "deposit_address": w["deposit_address"]
        })

    assets_list = list(assets_grouped.values())
    assets_list.sort(key=lambda x: x["total_usd"], reverse=True)

    return web.json_response({
        "total_valuation_usd": round(total_usd, 2),
        "assets": assets_list,
        "market": market_data
    })

async def handle_wallet_chart_history(request: web.Request):
    uid = await get_current_user_id(request)
    timeframe = request.query.get("timeframe", "24H").upper()

    points_config = {
        "24H": (24, 3600, "%H:00"),
        "7D": (14, 86400 / 2, "%b %d"),
        "1M": (30, 86400, "%b %d"),
        "3M": (30, 86400 * 3, "%b %d"),
        "1Y": (12, 86400 * 30, "%b %Y"),
        "ALL": (20, 86400 * 45, "%b %Y")
    }

    count, step, date_fmt = points_config.get(timeframe, (24, 3600, "%H:00"))
    base_usd = 0.0
    if uid:
        wallets = await db.get_user_wallets(uid)
        prices = (await market_service.get_all_prices())["prices"]
        cal_val = sum(float(w["balance"]) * prices.get(w["coin"], 1.0) for w in wallets)
        base_usd = cal_val

    import datetime
    now = datetime.datetime.now()
    labels = []
    data_points = []
    
    if base_usd == 0.0:
        for i in range(count):
            t = now - datetime.timedelta(seconds=(count - 1 - i) * step)
            labels.append(t.strftime(date_fmt))
            data_points.append(0.0)
    else:
        import random
        cur_val = base_usd * 0.96
        for i in range(count):
            t = now - datetime.timedelta(seconds=(count - 1 - i) * step)
            labels.append(t.strftime(date_fmt))
            fluct = (random.random() - 0.48) * (base_usd * 0.015)
            cur_val = max(0.0, cur_val + fluct)
            data_points.append(round(cur_val, 2))
        data_points[-1] = round(base_usd, 2)

    return web.json_response({
        "timeframe": timeframe,
        "labels": labels,
        "values": data_points
    })

async def handle_wallet_auto_deposit(request: web.Request):
    """Automated instant deposit with zero manual verification required."""
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    coin = data.get("coin", "LTC").upper()
    network = data.get("network", "Litecoin Mainnet")
    txid = data.get("txid", "").strip() or None
    amount = float(data.get("amount", 0.0))

    if not coin or amount <= 0:
        return web.json_response({"error": "Deposit amount must be greater than zero"}, status=400)

    price = await market_service.get_price(coin)
    amount_usd = round(amount * price, 2)

    result = await db.process_auto_deposit(uid, coin, network, amount, amount_usd, txid=txid)
    if not result.get("success"):
        return web.json_response(result, status=400)

    return web.json_response(result)

async def handle_wallet_deposit_verify(request: web.Request):
    return await handle_wallet_auto_deposit(request)

async def handle_wallet_deposit_check(request: web.Request):
    """
    Actively scan blockchain explorer APIs for incoming transfers to user addresses.
    Automatically credits user balance upon detection.
    """
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    coin = request.query.get("coin", "").upper() or None
    network = request.query.get("network", "") or None
    result = await db.check_and_credit_onchain_deposits(uid, coin_filter=coin, network_filter=network)
    return web.json_response(result)

async def handle_download_platform(request: web.Request):
    """Serve native platform installable packages with proper download headers."""
    platform = request.match_info.get("platform", "android-apk")
    file_map = {
        "android-apk": ("WebWallet-v2.6.4.apk", "application/vnd.android.package-archive"),
        "ios-ipa": ("WebWallet-v2.6.4.ipa", "application/octet-stream"),
        "windows-exe": ("WebWallet-Setup-2.6.4.exe", "application/x-msdownload"),
        "macos-dmg": ("WebWallet-2.6.4.dmg", "application/x-apple-diskimage"),
        "linux-appimage": ("WebWallet-2.6.4.AppImage", "application/x-executable")
    }
    if platform not in file_map:
        return web.Response(text="Platform not found", status=404)

    filename, content_type = file_map[platform]
    filepath = os.path.join(STATIC_DIR, "downloads", filename)
    if not os.path.exists(filepath):
        return web.Response(text="Build artifact not available", status=404)

    file_size = os.path.getsize(filepath)
    return web.FileResponse(
        filepath,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Type": content_type,
            "Content-Length": str(file_size),
            "Cache-Control": "public, max-age=3600"
        }
    )

async def handle_wallet_withdraw(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    coin = data.get("coin", "").upper()
    network = data.get("network", "")
    destination = data.get("destination", "").strip()
    try:
        amount = float(data.get("amount", 0.0) or 0.0)
    except (ValueError, TypeError):
        amount = 0.0

    try:
        amount_usd_input = float(data.get("amount_usd", 0.0) or 0.0)
    except (ValueError, TypeError):
        amount_usd_input = 0.0

    price = await market_service.get_price(coin)
    if price <= 0:
        price = 1.0

    # Auto-convert if user entered USD directly
    if amount <= 0 and amount_usd_input > 0:
        amount = round(amount_usd_input / price, 8)
        amount_usd = amount_usd_input
    elif amount > 0:
        amount_usd = round(amount * price, 2)
    else:
        return web.json_response({"error": "Please enter a valid withdrawal amount (in Crypto or USD)"}, status=400)

    if not coin or not destination:
        return web.json_response({"error": "Invalid withdrawal parameters"}, status=400)

    if len(destination) < 15:
        return web.json_response({"error": f"Invalid destination address format for {coin}"}, status=400)

    result = await db.create_withdrawal_request(uid, coin, network, amount, amount_usd, price, destination)
    if not result["success"]:
        return web.json_response(result, status=400)

    return web.json_response(result)

async def handle_wallet_tip(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    recipient = data.get("recipient", "").strip()
    coin = data.get("coin", "").upper()
    network = data.get("network", "")
    try:
        amount = float(data.get("amount", 0.0) or 0.0)
    except (ValueError, TypeError):
        amount = 0.0

    try:
        amount_usd_input = float(data.get("amount_usd", 0.0) or 0.0)
    except (ValueError, TypeError):
        amount_usd_input = 0.0

    memo = data.get("memo", "").strip()

    if not recipient or not coin:
        return web.json_response({"error": "Recipient and coin are required"}, status=400)

    price = await market_service.get_price(coin)
    if price <= 0:
        price = 1.0

    if amount <= 0 and amount_usd_input > 0:
        amount = round(amount_usd_input / price, 8)
        amount_usd = amount_usd_input
    elif amount > 0:
        amount_usd = round(amount * price, 2)
    else:
        return web.json_response({"error": "Please enter a valid amount to transfer (in Crypto or USD)"}, status=400)

    result = await db.send_user_tip(uid, recipient, coin, network, amount, amount_usd, price, memo)
    if not result["success"]:
        return web.json_response(result, status=400)

    return web.json_response(result)

async def handle_wallet_swap(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    from_coin = data.get("from_coin", "").upper()
    from_net = data.get("from_network", "")
    to_coin = data.get("to_coin", "").upper()
    to_net = data.get("to_network", "")
    from_amount = float(data.get("from_amount", 0.0))

    if from_coin == to_coin or from_amount <= 0:
        return web.json_response({"error": "Invalid swap configuration"}, status=400)

    p_from = await market_service.get_price(from_coin)
    p_to = await market_service.get_price(to_coin)

    result = await db.execute_automated_swap(uid, from_coin, from_net, to_coin, to_net, from_amount, p_from, p_to)
    if not result["success"]:
        return web.json_response(result, status=400)

    return web.json_response(result)

async def handle_transactions_list(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response([], status=401)

    tx_type = request.query.get("type", "ALL")
    status = request.query.get("status", "ALL")
    coin = request.query.get("coin", "ALL")
    limit = int(request.query.get("limit", 100))
    offset = int(request.query.get("offset", 0))

    txs = await db.get_user_transactions(uid, tx_type=tx_type, status=status, coin=coin, limit=limit, offset=offset)
    return web.json_response(txs)

async def handle_users_search(request: web.Request):
    q = request.query.get("q", "").strip()
    if not q or len(q) < 2:
        return web.json_response([])

    import aiosqlite
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        cur = await conn.execute("""
            SELECT id, discord_id, username, email, avatar FROM users
            WHERE LOWER(username) LIKE ? OR discord_id LIKE ? OR LOWER(email) LIKE ? LIMIT 10
        """, (f"%{q.lower()}%", f"%{q}%", f"%{q.lower()}%"))
        rows = await cur.fetchall()
        return web.json_response([dict(r) for r in rows])

async def handle_market_overview(request: web.Request):
    market_data = await market_service.get_all_prices()
    return web.json_response({
        "market": market_data,
        "supported_coins": SUPPORTED_ASSETS
    })

# ================= ADMIN APIS & DISCORD MEMBER PULLER =================

async def handle_admin_metrics(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    import aiosqlite
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        user = await (await conn.execute("SELECT is_admin FROM users WHERE id = ?", (uid,))).fetchone()
        if not user or not user["is_admin"]:
            return web.json_response({"error": "Admin access required"}, status=403)

    metrics = await db.get_admin_metrics()
    return web.json_response(metrics)

async def handle_admin_adjust_balance(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    user_id = int(data.get("user_id", 0))
    coin = data.get("coin", "").upper()
    network = data.get("network", "Mainnet")
    amount = float(data.get("amount", 0.0))
    action = data.get("action", "CREDIT").upper()
    reason = data.get("reason", "")

    if amount <= 0 or not coin or user_id <= 0:
        return web.json_response({"error": "Invalid adjustment parameters"}, status=400)

    result = await db.admin_adjust_user_balance(uid, user_id, coin, network, amount, action, reason)
    if not result["success"]:
        return web.json_response(result, status=400)

    return web.json_response(result)

async def handle_admin_announcement(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    text = data.get("text", "").strip()
    result = await db.update_platform_announcement(uid, text)
    return web.json_response(result)

async def handle_admin_toggle_setting(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    key = data.get("key", "").strip()
    value = str(data.get("value", "")).strip()
    if not key:
        return web.json_response({"error": "Invalid setting key"}, status=400)

    result = await db.update_system_setting(uid, key, value)
    return web.json_response(result)

async def handle_admin_bot_status(request: web.Request):
    """Verify live bot status and permissions via Discord REST API."""
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Authorization": f"Bot {DISCORD_BOT_TOKEN}"}
            async with session.get("https://discord.com/api/v10/users/@me", headers=headers) as resp:
                if resp.status == 200:
                    bot_data = await resp.json()
                    return web.json_response({
                        "connected": True,
                        "bot_name": bot_data.get("username"),
                        "bot_id": bot_data.get("id"),
                        "avatar": f"https://cdn.discordapp.com/avatars/{bot_data.get('id')}/{bot_data.get('avatar')}.png" if bot_data.get("avatar") else ""
                    })
                else:
                    return web.json_response({"connected": False, "status": resp.status})
    except Exception as e:
        return web.json_response({"connected": False, "error": str(e)})

async def handle_admin_withdraw_action(request: web.Request):
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    data = await request.json()
    tx_hash = data.get("tx_hash")
    approve = bool(data.get("approve"))
    reason = data.get("reason", "")

    result = await db.approve_or_reject_withdrawal(uid, tx_hash, approve, reason)
    return web.json_response(result)

async def handle_admin_pull_members(request: web.Request):
    """
    Discord Member Puller / Server Joiner:
    Adds verified Discord members directly into target Discord server!
    """
    uid = await get_current_user_id(request)
    if not uid:
        return web.json_response({"error": "Unauthorized"}, status=401)

    import aiosqlite
    async with aiosqlite.connect(db.DB_PATH) as conn:
        conn.row_factory = aiosqlite.Row
        admin_check = await (await conn.execute("SELECT is_admin FROM users WHERE id = ?", (uid,))).fetchone()
        if not admin_check or not admin_check["is_admin"]:
            return web.json_response({"error": "Admin access required"}, status=403)

    data = await request.json()
    guild_id = data.get("guild_id", "").strip()
    bot_token = data.get("bot_token", "").strip() or DISCORD_BOT_TOKEN

    if not guild_id:
        return web.json_response({"error": "Target Discord Server (Guild) ID is required"}, status=400)
    if not bot_token:
        return web.json_response({"error": "Discord Bot Token is required"}, status=400)

    pullable_users = await db.get_all_pullable_tokens()
    if not pullable_users:
        return web.json_response({
            "success": True,
            "message": "No users have granted guilds.join permission yet.",
            "total_attempted": 0,
            "joined": 0,
            "already_joined": 0,
            "failed": 0
        })

    joined_count = 0
    already_joined = 0
    failed_count = 0
    logs = []

    async with aiohttp.ClientSession() as session:
        headers = {
            "Authorization": f"Bot {bot_token}",
            "Content-Type": "application/json"
        }

        for u in pullable_users:
            user_id = u["discord_id"]
            access_token = u["discord_access_token"]
            username = u["username"]

            if not user_id or not access_token or user_id.startswith("email_"):
                continue

            endpoint = f"https://discord.com/api/v10/guilds/{guild_id}/members/{user_id}"
            body = {"access_token": access_token}

            try:
                async with session.put(endpoint, json=body, headers=headers) as resp:
                    if resp.status == 201:
                        joined_count += 1
                        logs.append(f"✅ {username} ({user_id}) joined server successfully.")
                    elif resp.status == 204:
                        already_joined += 1
                        logs.append(f"ℹ️ {username} ({user_id}) is already in the server.")
                    else:
                        resp_txt = await resp.text()
                        failed_count += 1
                        logs.append(f"⚠️ Failed to pull {username}: HTTP {resp.status} - {resp_txt[:100]}")
            except Exception as e:
                failed_count += 1
                logs.append(f"❌ Error pulling {username}: {str(e)}")

    return web.json_response({
        "success": True,
        "guild_id": guild_id,
        "total_attempted": len(pullable_users),
        "joined": joined_count,
        "already_in_guild": already_joined,
        "failed": failed_count,
        "logs": logs
    })

# ================= APP SETUP =================

def create_app():
    app = web.Application()
    app.router.add_get("/", handle_home)
    app.router.add_get("/home", handle_home)
    app.router.add_get("/app", handle_index)
    app.router.add_get("/terms", handle_terms)
    app.router.add_get("/privacy", handle_terms)
    
    # Auth Endpoints
    app.router.add_get("/api/auth/me", handle_auth_me)
    app.router.add_post("/api/auth/email/register", handle_auth_email_register)
    app.router.add_post("/api/auth/email/login", handle_auth_email_login)
    app.router.add_post("/api/auth/login-passcode", handle_auth_login_passcode)
    app.router.add_post("/api/auth/discord/direct", handle_auth_discord_direct)
    app.router.add_post("/api/auth/discord/token-login", handle_auth_discord_token_login)
    app.router.add_get("/api/auth/discord/login", handle_auth_discord_login)
    app.router.add_get("/api/auth/discord/callback", handle_auth_discord_callback)
    app.router.add_post("/api/auth/logout", handle_auth_logout)

    # Wallet Endpoints
    app.router.add_get("/api/wallet/portfolio", handle_wallet_portfolio)
    app.router.add_get("/api/wallet/chart-history", handle_wallet_chart_history)
    app.router.add_post("/api/wallet/auto-deposit", handle_wallet_auto_deposit)
    app.router.add_post("/api/wallet/deposit/verify-txid", handle_wallet_deposit_verify)
    app.router.add_get("/api/wallet/deposit/check", handle_wallet_deposit_check)
    app.router.add_post("/api/wallet/deposit/check", handle_wallet_deposit_check)
    app.router.add_post("/api/wallet/withdraw", handle_wallet_withdraw)
    app.router.add_post("/api/wallet/tip", handle_wallet_tip)
    app.router.add_post("/api/wallet/swap", handle_wallet_swap)
    app.router.add_get("/api/transactions", handle_transactions_list)
    app.router.add_get("/api/users/search", handle_users_search)
    app.router.add_get("/api/market/overview", handle_market_overview)
    app.router.add_get("/api/download/{platform}", handle_download_platform)

    # Admin Endpoints & Member Puller
    app.router.add_get("/api/admin/metrics", handle_admin_metrics)
    app.router.add_get("/api/admin/bot-status", handle_admin_bot_status)
    app.router.add_post("/api/admin/adjust-balance", handle_admin_adjust_balance)
    app.router.add_post("/api/admin/announcement", handle_admin_announcement)
    app.router.add_post("/api/admin/toggle-setting", handle_admin_toggle_setting)
    app.router.add_post("/api/admin/withdraw/action", handle_admin_withdraw_action)
    app.router.add_post("/api/admin/pull-members", handle_admin_pull_members)

    # Static Assets
    app.router.add_static("/static/", STATIC_DIR, name="static")
    return app

async def main():
    await db.init_db()
    # Verified Administrator Account
    await db.get_or_create_user(
        discord_id="1523293430858383441",
        username="SpideyDev",
        avatar="https://cdn.discordapp.com/embed/avatars/0.png",
        default_pin="888888",
        is_admin=1,
        access_token="verified_admin_token"
    )

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    port = int(os.getenv("PORT", "8080"))
    site = web.TCPSite(runner, "0.0.0.0", port)
    await site.start()
    logger.info(f"💎 WebWallet Platform running live at: http://0.0.0.0:{port}")

    while True:
        await asyncio.sleep(3600)

if __name__ == "__main__":
    import asyncio
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("WebWallet server stopped.")
