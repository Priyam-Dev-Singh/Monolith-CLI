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
<img alt="npm version" src="https://img.shields.io/npm/v/monolith-engine">
<img alt="npm downloads" src="https://img.shields.io/npm/dm/monolith-engine">
<img alt="license" src="https://img.shields.io/npm/l/monolith-engine">
<img alt="node engine" src="https://img.shields.io/node/v/monolith-engine">
<img alt="status" src="https://img.shields.io/badge/status-early%20access-orange">
</p>

<p align="center">
The deployment control plane for developers who already have a server and the skill to SSH into it. Flat pricing that never moves with usage, no execution-time ceiling, and one login that manages every server and project you own.
</p>

> **📍 Current status: early access, single-maintainer project.** The core deploy/rollback/database/migration pipeline is real and working (see [Features](#-features)) — this isn't vaporware with a landing page. TLS between the CLI and your server is not wired up yet, so don't route sensitive production credentials through it (see [Known Limitations](#-known-limitations)) — that's the top priority before this is pushed on anyone harder than "try it and tell me what breaks."

---

### Table of Contents

- [Who this is for](#-who-this-is-for)
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

## 🎯 Who this is for

**You, if:** you're comfortable with git, a terminal, and SSH-ing into a box you own or rent — a $5 Hetzner VPS, a spare machine, whatever — and you'd rather point a real deploy pipeline at it than pay platform markup or hand-roll `docker build` + nginx + cert renewal yourself every time you ship.

**Not you, if:** you have zero infrastructure literacy and want something that requires no server of your own — Monolith still assumes you own or can rent a machine and can SSH into it. That's a deliberate line, not an oversight: the onboarding genuinely requires it.

Two shapes of user this tends to fit well in practice:
- **Solo builder** — one dev running a media- or AI-generation-heavy side project or early product, already on a Hobby-to-low-Pro tier of Vercel/Railway/Render, either already bill-shocked or one viral post away from it.
- **Small team (2–10 people)** — real users, real recurring infra spend, an egress- or long-execution-time-heavy workload, at least one infra-literate engineer, but no dedicated DevOps hire yet.

If you're on a static site or a low-traffic app with no real cost problem, or you need enterprise SLAs and 24/7 on-call today, Monolith isn't trying to be the right tool for that yet.

## 🔥 Why Monolith

Platform egress pricing carries a markup of **100x or more** over what bandwidth actually costs on raw infrastructure — commonly cited around $0.15/GB in Vercel overages versus roughly $1/TB-equivalent on Hetzner. That gap is invisible on a small app. It stops being invisible the moment your app serves real media, runs an AI-generation pipeline, or just has a good week — "surprise $700 bill" and "surprise $23,000 bill" are both things that have actually happened to real people, not hypotheticals.

Serverless execution limits are the other half of the same problem: a 300–800 second ceiling on how long a single request can run, which is exactly why a small industry of point-solutions exists purely to work around it while staying on the platform. Monolith's containers are always-on — there is no ceiling to work around.

**The comparison that actually matters isn't Monolith vs. a cheaper subscription — it's Monolith vs. hiring a DevOps engineer.** A fully-loaded first-year platform engineer runs anywhere from $180K to $390K once you count recruiting, onboarding, and ramp risk. Most teams under ~3 engineers shouldn't make that hire yet — the standard advice is that one generalist just handles deploys manually (SSH, `docker build`, hand-edited nginx, manual cert renewal) until the team is bigger. Monolith is what that manual process looks like automated: flat pricing, one login, `git push` to ship, without needing the hire or the DevOps learning curve to get there.

Monolith doesn't try to be a bigger, better Vercel, and it isn't trying to out-feature Coolify either — Coolify is free, mature, and does more today. Monolith is the narrower thing: point it at a server you already have and get a real deploy pipeline back, without the usage-based billing surprises of the hosted platforms or the "now you're the one keeping the platform itself alive" tax of running your own PaaS from scratch.

## ⚡ Quick Start

```bash
# 1. Install the CLI
npm i monolith-engine

# 2. Authenticate — either paste a token from your dashboard...
monolith login --token <YOUR_PAT> --url <YOUR_DASHBOARD_URL>

#    ...or skip the token and let it open a browser instead:
monolith login

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
- 🔀 **Database migration** — pull data from an existing provider (Supabase, Atlas, etc.) straight into a Monolith-provisioned database, with a live log stream while it runs
- 🔒 **Encrypted secrets vault** — environment variables stored server-side, not in your repo
- 🌐 **Bring-your-own-server** — works on any machine with a public IP; no per-provider integration required
- 🗂️ **Multi-profile auth** — hold several tokens on one machine (per workspace, client, or environment) and switch between them without re-logging in
- 🧰 **Build-tooling auto-detect** — `init` recognizes Prisma, patch-package, and Puppeteer in your `package.json` and offers to wire the right postinstall step and Docker build-cache config for you
- 📡 **Live log streaming** — tail build output or runtime logs straight from your terminal
- 🧭 **Built-in interactive guide** — `monolith guide` walks through setup and diagnoses failures per command

## 📖 Command Reference

<details>
<summary><code>monolith login</code> — authenticate the CLI with your account</summary>

```bash
# Manual: paste a Personal Access Token from Settings → Personal Access Tokens
monolith login --token <PAT> --url <YOUR_DASHBOARD_URL>

# Or: browser-based, no token to copy — opens a loopback OAuth tab and
# syncs every profile/token on your account in one shot
monolith login
```

Either way, credentials are stored locally in `~/.monolith/auth.json` (mode `0600`). Every other command reads this file automatically — you only do this once per machine. Use the manual `--token` form on headless/SSH sessions where a browser can't open.
</details>

<details>
<summary><code>monolith generate:token &lt;name&gt;</code> / <code>list:token</code> / <code>switch</code> — manage multiple profiles</summary>

```bash
monolith generate:token work     # forge a new PAT, save it as profile "work", activate it
monolith list:token              # list every token on your account (masked)
monolith switch                  # interactively pick which saved profile is active
```

Useful if you manage more than one workspace, client, or environment from the same machine — every command runs against whichever profile is currently active.
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

Detects your framework, injects any needed build scripts, and lets you tether the project to one of your registered servers. If it finds Prisma, patch-package, or Puppeteer in your `package.json`, it'll offer to add the right postinstall command and generate a `nixpacks.toml` so the Docker build cache doesn't silently drop the folders those tools need.
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
monolith db:create <db-name>
```

Choose Postgres, MySQL, Redis, or MongoDB. The connection string is auto-injected into your project's secrets vault.
</details>

<details>
<summary><code>monolith db:migrate</code> — migrate an existing database onto Monolith</summary>

```bash
monolith db:migrate
```

Detects databases already attached to your project, walks you through picking a destination, then prompts (input hidden) for your existing provider's connection URI and the destination's Monolith URI. Runs the migration on a short-lived worker and streams its logs live so you can watch it happen. Keep your old database running until you've verified the new one — this doesn't touch the source.

If you're migrating from Supabase, use the **Connection Pooler** URL (port `5432`), not the direct database URL — Monolith checks for this and will tell you if you've pasted the wrong one.

> ⚠️ Given the TLS caveat above, avoid running this against production credentials over an untrusted network until TLS lands — treat it as safe for a private network or a low-stakes migration for now.
</details>

<details>
<summary><code>monolith env:set</code> / <code>env:rm</code> — manage secrets</summary>

```bash
monolith env:set
monolith env:rm
```

Interactively add or remove environment variables in the remote vault. Keys are auto-normalized to `UPPERCASE_WITH_UNDERSCORES`. Redeploy afterward for changes to take effect.
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

An animated, in-terminal guide covering login, multi-profile auth, the full pipeline, and an expandable command reference with likely failure reasons for every command above. Type a command name or number to expand it, `q` to exit.
</details>

## ⚖️ Monolith vs. the alternatives

| | **Monolith** | **Vercel / Railway** | **Coolify** |
|---|---|---|---|
| Runs on | Your own server | Their infrastructure | Your own server |
| Pricing model | Flat, no usage-based egress | Usage-based (bandwidth, functions) — Railway's own users cite billing surprises as its biggest complaint | Free (self-managed) |
| Execution model | Always-on containers, no timeout | Serverless functions, 300–800s execution ceiling | Always-on containers |
| Setup | CLI-first, a few commands | Instant, zero setup | Full web dashboard, larger surface area |
| Ongoing ops burden | You manage the box, Monolith manages the deploy | None — fully managed | You manage everything, including the platform's own upkeep |
| Best fit | Devs who already have a server and want git-push simplicity without becoming their own devops team | Teams who want zero infrastructure thinking and can absorb usage pricing | Teams comfortable owning the whole self-hosting stack full-time |

Coolify is free, mature, and does more than Monolith does today — if you want the full self-hosted platform experience and don't mind managing it, it's a genuinely good option. Monolith exists for the narrower case in between: you want the git-push-and-forget experience, without the usage-billing anxiety of a hosted platform *or* the ongoing time cost of running your own PaaS.

## ⚠️ Known Limitations

Being upfront about this matters more than looking finished:

- **No TLS yet.** Traffic between the CLI and your server isn't encrypted in transit. Don't run sensitive production workloads — and especially don't run `db:migrate` with production credentials — over this until it's resolved. This is the current #1 priority.
- **No horizontal scaling / replicas yet.** One container per project — a real traffic spike will bottleneck it.
- **Single point of failure.** Control plane and deploy target currently share infrastructure in most setups.
- **`db:migrate` is built and tested against Postgres.** Other engines will likely work but haven't been exercised the same way yet.

None of these are secret — they're the current top-of-list priorities, in that order.

## 🗺️ Roadmap

- [ ] TLS everywhere (also unblocks marketing `db:migrate` responsibly)
- [ ] Load-balanced replicas per project (Caddy already supports this — config change, not a rewrite)
- [ ] Control-plane / data-plane separation
- [ ] Web dashboard (in progress)
- [ ] Real multi-user accounts and billing

## 🤝 Contributing

This is early and small — one maintainer, built and used on real projects before being offered to anyone else. Issues and PRs are welcome, but please open an issue to discuss first for anything beyond a small fix — the roadmap above is the current source of truth for direction.

## 📄 License

MIT — see [LICENSE](./LICENSE).

<p align="center">Let's deploy your dream project.</p>