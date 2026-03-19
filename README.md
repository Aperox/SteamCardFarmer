<div align="center">

# 🌾 Steam Card Farmer

**A high-performance, modern, and intelligent background card dropping tool for Steam.**  
*Farm your Steam trading cards safely, efficiently, and completely automatically without relying on heavy game clients.*

[![Node.js Requirement](https://img.shields.io/badge/Node.js-%3E%3D%2018.0.0-green.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)]()
[![License](https://img.shields.io/badge/license-MIT-purple.svg)]()

</div>

## 🚀 Features & Architecture

Steam Card Farmer relies on a series of intelligent features inspired by the most reliable farming tools on the market, combined with an extremely modern Web Dashboard UI.

- ⏱ **2-Hour Bypass Protocol:** Game refunds prevent card drops in the first 120 minutes of playtime. Our bot automatically bridges this gap by bundling and simulating up to 32 games simultaneously to exhaust the timer efficiently.
- ⚡ **Turbo Solo Mode:** Once the refund period ends, algorithm immediately drops all instances and executes games completely "Solo" (individually). This triggers Steam's internal logic to drop cards significantly faster (usually within 10-15 minutes).
- 🛡️ **VAC & Anti-Cheat Safety:** Built-in competitive filtering mechanism automatically isolates and skips titles like *CS2, Dota 2, TF2, Rust, and PUBG*, protecting your account from overlapping playtimes or VAC risks.
- 🕒 **Smart Scheduler:** Configure the background job to automatically wake up, start farming, and shut down based on precise server-time rules. Perfect for overnight grinding cycles.
- 🧠 **Cache-Busting Emulation:** Bypasses stale Steam CDN caches to actively and instantly catch whenever a new card drops into your inventory, stopping the farm gracefully.

## 🌍 Language Support (Multilingual)
The sleek graphical interface natively supports **7 Languages**: English, Turkish, Chinese, Spanish, Russian, German, and Japanese.

## 📦 Installation & Usage

1. **Prerequisites:** Ensure you have [Node.js](https://nodejs.org/en) installed on your system.
2. **Download:** Grab the latest `Source code` from the [Releases](#) tab and extract it.
3. **Run the Server:** Double-click the `SteamCardFarmer.bat` file.
4. **Dashboard:** A stylish, dark-mode browser window will automatically launch at `http://localhost:3000`.

### 🔑 Security & Accounts
- Enter your Username/Password, and your Steam Guard Mobile token directly into the Dashboard. Your credentials only communicate with official Steam Authentication APIs. No data is stored externally. Your `session.json` is safely encrypted and kept fully locally inside the application folder!

## ⚠️ Important Rules

> [!WARNING]
> Free-to-Play games (such as CS2, TF2) do **not** yield trading cards unless you have spent real-world currency inside the in-game store (DLCs, keys, crates). Purchasing the game grants you a specific allowance of drops. Blank F2P games will be automatically ignored by the farmer.

---
*Created with ❤️ for completionists and Steam level hunters.*
