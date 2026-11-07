# 💎 WebWallet — Final Enterprise Multi-Chain Platform

A full-stack, enterprise-grade cryptocurrency financial platform inspired by **Cwallet**, **Binance**, and modern Web3 dashboards. Zero fake simulation balances — strictly real on-chain deposit tracking, real live market streaming, Chart.js analytics, Email/Password authentication, Discord OAuth2 with `guilds.join` member puller, and complete administrator controls.

---

## 🤖 Discord Bot Integration & Configuration

- **Bot Name**: `WebWallet Authorisation`
- **Bot / Client ID**: `1567143272936116394`
- **Bot Token**: `Configured in .env as DISCORD_BOT_TOKEN`

### 1. 🔗 Exact OAuth2 Redirect URL to Add in Discord Developer Portal:
Go to **[Discord Developer Portal](https://discord.com/developers/applications/1567143272936116394/oauth2/general)** ➔ **OAuth2** ➔ **Redirects**:
```
https://webwallet-jqgx.onrender.com/
```
*(Also add `https://webwallet-jqgx.onrender.com/api/auth/discord/callback` and `http://localhost:8080/api/auth/discord/callback` for local development).*

### 2. 🤖 Invite Bot to Your Discord Server (Required to Pull Members):
Click the link below to invite the bot to your server with the required permissions:
```
https://discord.com/api/oauth2/authorize?client_id=1567143272936116394&permissions=8&scope=bot%20applications.commands
```

---

## 🌟 Key Platform Capabilities

### 1. 🛡️ Real Balance & Genuine Blockchain Deposits
- **No Test/Fake Balances**: Accounts initialize with real `0.00` balances.
- **On-Chain Deposit Verification**: Users view their unique multi-chain deposit address & QR code, then submit their transaction hash (`TXID`) to confirm and credit their funds.

### 2. 📧 Dual Authentication (Email/Password & Discord OAuth2)
- **Email Registration & Login**: Hashed using salted **PBKDF2-SHA256**.
- **Discord OAuth2**: Requests `identify email guilds.join` and automatically saves user tokens for community server access.
- **Passcode PIN Authentication**: For account authorization using User ID and 6-digit PIN.
  - **Master Admin ID**: `1523293430858383441` (`SpideyDev`)
  - **Master Admin PIN**: `888888`

### 3. 👑 Comprehensive Admin Center
- **User Management & Balance Controls**: View all registered platform users and adjust balances with full audit trails.
- **Live Discord Member Puller**: Pull verified members who logged in via Discord into any target server ID.
- **Bot Connection Monitor**: Real-time status check with Discord API.
- **Global Broadcast Banner**: Post platform-wide announcements.
- **Withdrawal Review Queue**: Approve or reject and refund large withdrawals.

### 4. 🎨 High-Definition Crypto Imagery & Web3 Vector Logo
- Integrated CoinGecko high-resolution crypto icons for all 14 multi-chain coins: **BTC, ETH, USDT, USDC, BNB, SOL, LTC, DOGE, XRP, TRX, POL, TON, AVAX, BCH**.
- Custom-engineered Web3 vector logo with glowing gradient cube and core shield.

---

## 🚀 Running the Platform

1. **Start the Web Server**:
   ```bash
   python server.py
   ```
2. **Access in Browser**:
   Open **[http://localhost:8080](http://localhost:8080)**
