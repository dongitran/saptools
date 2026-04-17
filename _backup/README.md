<div align="center">

# ⚡ saptools

**Extract SAP HANA credentials from Cloud Foundry — straight into your SQLTools config.**

[![npm version](https://img.shields.io/npm/v/saptools?style=flat-square&color=0ea5e9&label=npm)](https://www.npmjs.com/package/saptools)
[![npm downloads](https://img.shields.io/npm/dm/saptools?style=flat-square&color=8b5cf6)](https://www.npmjs.com/package/saptools)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-f59e0b?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Tests](https://img.shields.io/badge/tests-105%20passed-22c55e?style=flat-square)](./src/__tests__)

<br/>

> Stop copy-pasting credentials manually.  
> `saptools` connects to CF, finds your HANA bindings, and writes your SQLTools connections — in seconds.

</div>

---

## ✨ Features

- 🔍 **Interactive extraction** — guided prompts to pick region → org → space → apps
- ⚡ **Local cache** — orgs and apps are cached locally; subsequent runs are near-instant even with 30+ apps
- 🔄 **Background sync** — run a `launchd` daemon to keep cache fresh every 15 minutes
- 🎯 **SQLTools-ready** — auto-updates `.vscode/settings.json` with `sqltools.connections`
- 🌏 **Multi-region** — supports common SAP BTP CF regions across AWS/Azure/GCP/SAP infrastructure (including CA20)
- 🖥️ **Spinner UX** — real-time `ora` progress for every step, no silent waiting

---

## 📦 Installation

```bash
npm install -g saptools
```

Set your credentials once:

```bash
export SAP_EMAIL=your@email.com
export SAP_PASSWORD=your-password
```

> **Tip:** Add these to your `~/.zshrc` or `~/.bashrc` so they persist across sessions.

---

## 🚀 Quick Start

```bash
saptools
```

You'll be guided through an interactive menu:

```
? What would you like to do?
❯ 🔍 Extract to SQLTools Config
  🔄 Refresh Data Cache (Sync All)
```

Pick **Extract**, select your region, org, space, and apps — done. Your `.vscode/settings.json` is updated automatically.

---

## 🛠️ Commands

| Command | Description |
|---|---|
| `saptools` | Launch interactive mode |
| `saptools sync` | Manually sync all regions to local cache |
| `saptools cronjob enable` | Install background sync daemon (`launchd` on macOS) |
| `saptools cronjob disable` | Remove background sync daemon |
| `saptools cronjob status` | Check daemon status |

---

## ⚙️ How It Works

```
saptools
   ↓
Interactive menu → Select region, org, space, apps
   ↓
CF API  →  VCAP_SERVICES  →  Extract HANA credentials
   ↓
Write  →  .vscode/settings.json (sqltools.connections)
          ~/.config/saptools/output.json
```

**Cache architecture:** On first run, orgs and app lists are fetched from CF and stored in `~/.config/saptools/cache.json`. Subsequent runs read from cache — making selection near-instant. Run `saptools sync` or enable the background daemon to keep cache fresh.

---

## 🔄 Background Sync

```bash
# Enable auto-sync every 15 minutes (launchd on macOS, crontab on Linux/WSL)
saptools cronjob enable

# Check sync logs
tail -f ~/.config/saptools/sync.log
```

The daemon runs silently and keeps your local cache up-to-date, so the CLI always loads instantly.

---

## 🔐 Credentials

saptools reads credentials from environment variables only — **nothing is ever stored on disk**.

```bash
export SAP_EMAIL=your@email.com
export SAP_PASSWORD=your-password
```

---

## 🧪 Development

```bash
git clone https://github.com/dongitran/saptools
cd saptools
npm install

npm run check    # typecheck + lint + spell + tests
npm run test     # unit tests with coverage
npm run build    # compile TypeScript
```

---

## 📄 License

MIT © [dongitran](https://github.com/dongitran)
