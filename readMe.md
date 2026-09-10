<p align="center">
<pre>
███╗   ███╗ ██████╗ ███╗   ██╗ ██████╗ ██╗     ██╗████████╗██╗  ██╗
████╗ ████║██╔═══██╗████╗  ██║██╔═══██╗██║     ██║╚══██╔══╝██║  ██║
██╔████╔██║██║   ██║██╔██╗ ██║██║   ██║██║     ██║   ██║   ███████║
██║╚██╔╝██║██║   ██║██║╚██╗██║██║   ██║██║     ██║   ██║   ██╔══██║
██║ ╚═╝ ██║╚██████╔╝██║ ╚████║╚██████╔╝███████╗██║   ██║   ██║  ██║
╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝ ╚══════╝╚═╝   ╚═╝   ╚═╝  ╚═╝
</pre>
</p>

<p align="center"><b>YOUR SERVER. NO MIDDLEMEN.</b></p>

<p align="center">
<img alt="npm version" src="https://img.shields.io/npm/v/monolith-cli">
<img alt="npm downloads" src="https://img.shields.io/npm/dm/monolith-cli">
<img alt="license" src="https://img.shields.io/npm/l/monolith-cli">
<img alt="node engine" src="https://img.shields.io/node/v/monolith-cli">
<img alt="status" src="https://img.shields.io/badge/status-early%20access-orange">
</p>

<p align="center">
A self-hosted deployment control plane — git push, zero-downtime deploys, databases, and rollbacks — running on a server <i>you</i> own, at <i>your</i> server's price, not platform egress pricing.
</p>

> **📍 Current status: early access, single-maintainer project.** The core deploy/rollback/database pipeline is real and working (see [Features](#-features)). TLS is not wired up yet — don't put secrets over plaintext production traffic. There's no uptime SLA or on-call support. If that's fine for your use case, welcome aboard. Details in [Known Limitations](#-known-limitations).

---

### Table of Contents

- [Why Monolith](#-why-monolith)
- [Quick Start](#-quick-start)
- [Installation](#-installation)
- [Features](#-features)
- [Command Reference](#-command-reference)
- [Monolith vs. the alternatives](#-monolith-vs-the-alternatives)
- [Known Limitations](#-known-limitations)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🔥 Why Monolith

Platforms like Vercel price bandwidth at a steep multiple over what it costs on a plain VPS — commonly cited around $0.15/GB in overages, versus roughly $1/TB-equivalent on something like Hetzner. That's invisible on a small app. It stops being invisible the moment your app serves real media, runs an AI generation pipeline, or just has a good week and gets a traffic spike — at which point "surprise $700 bill" and "surprise $23,000 bill" are both things that have actually happened to real people, not hypotheticals.

Monolith doesn't try to be a bigger, better Vercel. It's the thing you point at a server you already have — a $5 VPS, a spare machine, whatever — and get back a real deploy pipeline: `git push` to ship, instant rollback when something breaks, databases with one command, without needing to hire a devops engineer or learn Coolify's full surface area to get there.

## ⚡ Quick Start

```bash
# 1. Install the CLI
npm i monolith-engine

# 2. Get a Personal Access Token from your Monolith dashboard, then log in
monolith login --token <YOUR_PAT> --url <YOUR_DASHBOARD_URL>

# 3. Register a server you own (name, public IP, agent key)
monolith server:add

# 4. Initialize your project and tether it to that server
monolith init my-app

# 5. Ship it
monolith deploy
```

Every `git push` after that redeploys automatically if you run `monolith github:connect` once.

Run `monolith guide` at any point for a full interactive walkthrough with a command-by-command failure-diagnostics reference — it's built into the CLI itself.

## 📦 Installation

```bash
npm i monolith-engine
```

Requires Node 18+ and a server you can SSH into (any provider — Hetzner, DigitalOcean, a home server, whatever you've got).

## ✨ Features

- 🚀 **Git-push deploys** — connect a GitHub repo once, then every push ships automatically
- 🔁 **Zero-downtime blue/green deploys** — new container has to pass a health check before traffic switches to it
- ⏪ **Instant rollback** — revert to the previous working deployment with one command, no rebuild
- 🗄️ **One-command databases** — Postgres, MySQL, Redis, or MongoDB, provisioned and auto-linked into your project's vault
- 🔒 **Encrypted secrets vault** — environment variables stored server-side, not in your repo
- 🌐 **Bring-your-own-server** — works on any machine with a public IP; no per-provider integration required
- 📡 **Live log streaming** — tail build output or runtime logs straight from your terminal
- 🧭 **Built-in interactive guide** — `monolith guide` walks through setup and diagnoses failures per command

## 📖 Command Reference

<details>
<summary><code>monolith login</code> — authenticate the CLI with your account</summary>

```bash
monolith login --token <PAT> --url <YOUR_DASHBOARD_URL>
```

Generates a Personal Access Token on your web dashboard first (Settings → Personal Access Tokens), then stores it locally in `~/.monolith/auth.json`. Every other command reads this file automatically — you only do this once per machine.
</details>

<details>
<summary><code>monolith server:add</code> — register a server you own</summary>

```bash
monolith server:add
```

Interactive prompt for a name, public IPv4 address, and the agent's API key. This is what makes Monolith bring-your-own-cloud — no provider-specific integration, just an IP.
</details>

<details>
<summary><code>monolith init &lt;project-name&gt;</code> — set up a project</summary>

```bash
monolith init my-app
```

Detects your framework, injects any needed build scripts, and lets you tether the project to one of your registered servers.
</details>

<details>
<summary><code>monolith deploy</code> — ship the current directory</summary>

```bash
monolith deploy
```

Packs the project, uploads it to the tethered server, and runs a health-checked blue/green traffic switch. No downtime if the new container passes its health check; nothing changes if it doesn't.
</details>

<details>
<summary><code>monolith rollback</code> — undo the last deploy</summary>

```bash
monolith rollback
```

Flips traffic back to the previous container instantly. No rebuild.
</details>

<details>
<summary><code>monolith db:create &lt;name&gt;</code> — provision a database</summary>

```bash
monolith db:create <db_Name>
```

Choose Postgres, MySQL, Redis, or MongoDB. The connection string is auto-injected into your project's secrets vault.
</details>
<details>
<summary><code>monolith db:migrate &lt;name&gt;</code> — migrate an existing database</summary>

```bash
monolith db:migrate
```

Input the DB connection URL string IPV4 as the source and the databse URL provisioned on our server as the terminal to migrate your onw data in your server provisioned DB. ANy issues failing in this command will be related to the URL of the database.
</details>

<details>
<summary><code>monolith env:set</code> / <code>env:rm</code> — manage secrets</summary>

```bash
monolith env:set
monolith env:rm
```

Interactively add or remove environment variables in the remote vault. Redeploy afterward for changes to take effect.
</details>

<details>
<summary><code>monolith github:connect</code> — automatic deploy on push</summary>

```bash
monolith github:connect
```

Registers a webhook on your GitHub repo pointing at your tethered server. Requires a GitHub PAT with `repo` and `admin:repo_hook` scopes.
</details>

<details>
<summary><code>monolith list</code> / <code>status</code> / <code>logs</code> — see what's running</summary>

```bash
monolith list      # quick table of apps and databases
monolith status     # full diagnostic: containers, vault, rollback targets, db health
monolith logs        # stream build or runtime logs live
```
</details>

<details>
<summary><code>monolith destroy</code> / <code>app:purge</code> / <code>db:destroy</code> — tear things down</summary>

```bash
monolith destroy [project-id]        # delete a project and everything on it
monolith app:purge [container-name]  # remove just the app container, keep the db
monolith db:destroy <container-name> # delete a specific database
```

All three require typing an exact confirmation string — intentional, not a bug, so a fat-fingered Enter can't delete production.
</details>

<details>
<summary><code>monolith guide</code> — interactive walkthrough</summary>

```bash
monolith guide
```

An animated, in-terminal guide covering login, the full pipeline, and an expandable command reference with likely failure reasons for every command above. Type a command name or number to expand it, `q` to exit.
</details>

## ⚖️ Monolith vs. the alternatives

| | **Monolith** | **Vercel / Railway** | **Coolify** |
|---|---|---|---|
| Runs on | Your own server | Their infrastructure | Your own server |
| Pricing model | Flat, no usage-based egress | Usage-based (bandwidth, functions) | Free (self-managed) |
| Setup | CLI-first, a few commands | Instant, zero setup | Full web dashboard, more surface area |
| Ops burden | You manage the box, Monolith manages the deploy | None — fully managed | You manage everything |
| Execution model | Always-on containers, no timeout | Serverless functions, execution limits | Always-on containers |
| Best fit | Devs who already have a server and want git-push simplicity without learning a full platform | Teams who want zero infrastructure thinking and can absorb usage pricing | Teams comfortable owning the whole self-hosting stack |

Coolify is free, mature, and does more than Monolith does today — if you want the full self-hosted platform experience and don't mind managing it, it's a genuinely good option. Monolith exists for the narrower case: you want the git-push-and-forget experience without becoming your own devops team.

## ⚠️ Known Limitations

Being upfront about this matters more than looking finished:

- **No TLS yet.** Traffic between the CLI and your server isn't encrypted in transit. Don't run sensitive production workloads on this until that's resolved.
- **No horizontal scaling / replicas yet.** One container per project — a real traffic spike will bottleneck it.
- **Single point of failure.** Control plane and deploy target currently share infrastructure in most setups.

None of these are secret — they're the current top-of-list priorities.

## 🗺️ Roadmap

- [ ] TLS everywhere
- [ ] Load-balanced replicas per project (Caddy already supports this — config change, not a rewrite)
- [ ] Control-plane / data-plane separation
- [ ] Web dashboard (in progress)
- [ ] Real multi-user accounts and billing

## 🤝 Contributing

This is early and small. Issues and PRs are welcome, but please open an issue to discuss first for anything beyond a small fix — the roadmap above is the current source of truth for direction.

## 📄 License

MIT — see [LICENSE](./LICENSE).

<p align="center">Let's deploy your dream project.</p>