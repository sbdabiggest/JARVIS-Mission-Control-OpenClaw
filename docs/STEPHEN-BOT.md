# Stephen — SB Detailing CEO Telegram Bot

Stephen is the Telegram front-of-house for **SB Detailing** (mobile car & boat
detailing — Destin / Fort Walton Beach / Navarre, FL). He answers as the CEO,
takes quote requests, and files work onto the Mission Control board as
`agent-stephen`.

```
┌──────────────┐   long polling   ┌──────────────────┐   JSON files   ┌──────────────────┐
│   Telegram   │◀───────────────▶│  stephen-bot.js   │───────────────▶│ .mission-control │
│  (customers, │                  │  (Stephen persona │                │  tasks / agents  │
│   the owner) │                  │   + task intake)  │                │  activity log    │
└──────────────┘                  └──────────────────┘                └──────────────────┘
```

The bot is standalone (no npm installs, built-in `fetch`, Node 18+) and does
**not** need the Mission Control server running — it reads/writes
`.mission-control/` directly, so the dashboard picks changes up through the
normal file watcher when the server *is* running.

## Quick start

1. **Create the bot** (once): message [@BotFather](https://t.me/BotFather) on
   Telegram → `/newbot` → name it `Stephen — SB Detailing` → pick a username
   (e.g. `@SBDetailingCEO_Bot`) → copy the API token.
2. **Give the bot its token** (either way works):

   ```bash
   # Option A — environment variable (pm2/systemd)
   export TELEGRAM_BOT_TOKEN_STEPHEN="123456:ABC-DEF..."

   # Option B — config file (gitignored, survives restarts)
   cat > .mission-control/config/stephen.json << 'EOF'
   { "token": "123456:ABC-DEF..." }
   EOF
   ```

3. **Run it:**

   ```bash
   node server/stephen-bot.js            # foreground
   # or on the server:
   pm2 start server/stephen-bot.js --name stephen-bot
   pm2 save
   ```

4. **Verify it's working:**

   ```bash
   ./scripts/check-stephen.sh                    # token, API, webhook, process, registration
   ./scripts/check-stephen.sh --chat <chat_id>   # + sends a real test message
   ```

5. Open Telegram, DM the bot `/start`. You're talking to Stephen.

## Commands

| Command | What it does |
|---------|--------------|
| `/start`, `/help` | Who Stephen is + this command list |
| `/ping` | Liveness check ("Stephen online") |
| `/status` | Bot health + Mission Control board counts |
| `/tasks` | Open tasks assigned to `agent-stephen` |
| `/task <text>` | Files a Mission Control task (assigned to `agent-stephen`) |
| plain DM | Conversational reply as Stephen (Claude if `ANTHROPIC_API_KEY` is set, canned persona reply otherwise) |
| `@BotUsername <text>` in a group | Files the instruction as a task |

Tasks are written schema-valid to `.mission-control/tasks/task-tg-stephen-*.json`
(status `ASSIGNED`, labels `telegram, sb-detailing`), deduplicated within a
5-minute window, and logged to the activity log. On first run the bot registers
`.mission-control/agents/agent-stephen.json` so Stephen appears on the dashboard.

## Configuration reference

| Env var / config key | Required | Default | Notes |
|----------------------|----------|---------|-------|
| `TELEGRAM_BOT_TOKEN_STEPHEN` / `token` | **Yes** | — | Falls back to `TELEGRAM_BOT_TOKEN` last |
| `ANTHROPIC_API_KEY` / `anthropic_api_key` | No | off | Enables real conversational replies as Stephen |
| `STEPHEN_AI_MODEL` | No | `claude-sonnet-5` | Model for AI replies |
| `STEPHEN_ALLOWED_CHATS` / `allowed_chats` | No | all chats | Comma-separated chat ids; when set, everything else is ignored. Chat ids are printed in the log so you can collect yours, then lock down. |
| `STEPHEN_DROP_WEBHOOK` | No | off | `1` = delete a leftover webhook at startup so polling can run |
| `MISSION_CONTROL_DIR` | No | `../.mission-control` | Same convention as the rest of the server |
| `TELEGRAM_API_BASE` | No | `https://api.telegram.org` | Override for tests/mocks |

`.mission-control/config/stephen.json` and `stephen-state.json` (poll offset)
are deployment-specific live data and are **gitignored** — same policy as the
Telegram `agents.json` bot mapping.

## Wiring into agent-bridge routing (optional)

If you also route group @mentions through the OpenClaw agent-bridge
(`server/telegram-bridge.js`), add Stephen to the live bot mapping **on the
server** so mentions resolve to him there too:

```json
// .mission-control/config/agents.json  (live file, not in git)
{
  "botMapping": {
    "@OracleM_Bot": "agent-oracle",
    "@YourStephenBot": "agent-stephen"
  }
}
```

This is optional — stephen-bot files tasks itself; the mapping only matters for
messages that arrive via the agent-bridge path instead.

## Troubleshooting

| Symptom | Cause → fix |
|---------|-------------|
| Bot exits: "No bot token found" | Set `TELEGRAM_BOT_TOKEN_STEPHEN` or `.mission-control/config/stephen.json` |
| Bot exits: 401 Unauthorized | Token wrong/revoked → re-copy from @BotFather (`/mybots` → API Token) |
| Bot exits: "A webhook is set" | Something registered a webhook for this token; polling can't run alongside it → restart once with `STEPHEN_DROP_WEBHOOK=1` |
| Log shows repeated `409 Conflict` | Two pollers on one token (double pm2 process, or the bot running on another machine) → `pm2 list`, keep exactly one |
| Replies in DMs but silent in groups | Expected unless the message @mentions the bot. If even mentions don't arrive: BotFather **group privacy** is ON (default) — bots then only receive `/commands` and replies. `/setprivacy` → your bot → **Disable**, then *remove and re-add the bot to the group* (Telegram requirement for the change to apply). |
| "chat not found" on send/`--chat` test | That chat has never messaged the bot → send `/start` to the bot from that account first |
| Filed tasks don't show on the dashboard | Mission Control server not running, or bot points at a different `MISSION_CONTROL_DIR` — `/status` prints the dir it's using |
| DM replies are canned/robotic | `ANTHROPIC_API_KEY` not set (that's the graceful-degradation mode) |

## Security notes

- The token never appears in logs (all errors are redacted).
- Message text is sanitized with the same character policy as
  `sanitizeInput()` in `server/index.js` before touching disk; input is capped
  at 4 000 chars; bot-authored messages are ignored (no bot-loop).
- Use `STEPHEN_ALLOWED_CHATS` in production so strangers can't file tasks onto
  your board — anyone on Telegram can find a bot by username.
- Stephen never quotes prices or confirms bookings; he collects details and
  defers to the owner (see the persona prompt in `server/stephen-bot.js`).
