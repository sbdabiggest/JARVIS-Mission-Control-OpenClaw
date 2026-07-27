#!/bin/bash
set -uo pipefail

# check-stephen.sh - Verify the Stephen (SB Detailing CEO) Telegram bot is working
#
# Runs the full health checklist against the live Telegram API and the local
# Mission Control data dir, and prints a PASS/WARN/FAIL summary. Run it on the
# machine that has the bot token (e.g. the production server).
#
# Usage:
#   ./scripts/check-stephen.sh                 # token + API + process checks
#   ./scripts/check-stephen.sh --chat 12345    # ALSO send a live test message to that chat id
#
# Token resolution (same order as server/stephen-bot.js):
#   1. $TELEGRAM_BOT_TOKEN_STEPHEN
#   2. "token" in .mission-control/config/stephen.json
#   3. $TELEGRAM_BOT_TOKEN

show_help() {
    sed -n '4,16p' "$0" | sed 's/^# \{0,1\}//'
}

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MISSION_CONTROL_DIR="${MISSION_CONTROL_DIR:-$REPO_DIR/.mission-control}"
CONFIG_FILE="$MISSION_CONTROL_DIR/config/stephen.json"
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"

TEST_CHAT=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --chat) TEST_CHAT="${2:-}"; shift 2 ;;
        --help|-h) show_help; exit 0 ;;
        *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
    esac
done

PASS=0; WARN=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

json_get() { # json_get <json> <js-expression over `d`>
    node -e 'const d=JSON.parse(process.argv[1]||"{}");const v=(function(d){return eval(process.argv[2])})(d);process.stdout.write(v===undefined||v===null?"":String(v))' "$1" "$2" 2>/dev/null
}

echo "🧽 Stephen — SB Detailing CEO bot · health check"
echo "─────────────────────────────────────────────────"

# 1. Token
TOKEN="${TELEGRAM_BOT_TOKEN_STEPHEN:-}"
SOURCE="TELEGRAM_BOT_TOKEN_STEPHEN"
if [[ -z "$TOKEN" && -f "$CONFIG_FILE" ]]; then
    TOKEN="$(json_get "$(cat "$CONFIG_FILE")" 'd.token')"
    SOURCE="$CONFIG_FILE"
fi
if [[ -z "$TOKEN" ]]; then
    TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    SOURCE="TELEGRAM_BOT_TOKEN"
fi

echo "[1/6] Bot token"
if [[ -z "$TOKEN" ]]; then
    bad "No token found. Set TELEGRAM_BOT_TOKEN_STEPHEN or put {\"token\": \"...\"} in $CONFIG_FILE"
    echo "      → Get one from @BotFather on Telegram (/newbot). Setup: docs/STEPHEN-BOT.md"
else
    ok "Token found (via $SOURCE)"
fi

# 2. Telegram getMe
echo "[2/6] Telegram API (getMe)"
BOT_USERNAME=""
if [[ -n "$TOKEN" ]]; then
    ME="$(curl -sS --max-time 15 "$API_BASE/bot$TOKEN/getMe" 2>/dev/null || echo '{}')"
    if [[ "$(json_get "$ME" 'd.ok')" == "true" ]]; then
        BOT_USERNAME="$(json_get "$ME" 'd.result.username')"
        ok "Bot is live: @$BOT_USERNAME ($(json_get "$ME" 'd.result.first_name'))"
    elif [[ "$(json_get "$ME" 'd.error_code')" == "401" ]]; then
        bad "Token rejected (401) — re-copy it from @BotFather (/mybots → API Token)"
    else
        bad "getMe failed: $(json_get "$ME" 'd.description') — check network/proxy to $API_BASE"
    fi
else
    bad "Skipped (no token)"
fi

# 3. Webhook conflict (stephen-bot uses long polling)
echo "[3/6] Webhook state (must be empty for polling)"
if [[ -n "$TOKEN" && -n "$BOT_USERNAME" ]]; then
    WH="$(curl -sS --max-time 15 "$API_BASE/bot$TOKEN/getWebhookInfo" 2>/dev/null || echo '{}')"
    WH_URL="$(json_get "$WH" 'd.result.url')"
    PENDING="$(json_get "$WH" 'd.result.pending_update_count')"
    LAST_ERR="$(json_get "$WH" 'd.result.last_error_message')"
    if [[ -n "$WH_URL" ]]; then
        bad "A webhook is set ($WH_URL) — long polling will not receive messages."
        echo "      → Start once with STEPHEN_DROP_WEBHOOK=1, or: curl \"$API_BASE/bot<token>/deleteWebhook\""
    else
        ok "No webhook set — polling is free to run (pending updates: ${PENDING:-0})"
    fi
    [[ -n "$LAST_ERR" ]] && warn "Last Telegram delivery error: $LAST_ERR"
else
    bad "Skipped (no working token)"
fi

# 4. Bot process
echo "[4/6] Bot process"
if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name":"stephen-bot"'; then
    PM2_STATUS="$(pm2 jlist 2>/dev/null | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=l.find(x=>x.name==="stephen-bot");process.stdout.write(p?p.pm2_env.status:"")')"
    if [[ "$PM2_STATUS" == "online" ]]; then
        ok "pm2 process 'stephen-bot' is online"
    else
        bad "pm2 process 'stephen-bot' exists but is '$PM2_STATUS' — pm2 restart stephen-bot && pm2 logs stephen-bot"
    fi
elif pgrep -f "stephen-bot.js" >/dev/null 2>&1; then
    ok "stephen-bot.js is running (outside pm2)"
else
    warn "stephen-bot is not running here. Start: pm2 start server/stephen-bot.js --name stephen-bot"
fi

# 5. Mission Control registration
echo "[5/6] Mission Control agent registration"
if [[ -f "$MISSION_CONTROL_DIR/agents/agent-stephen.json" ]]; then
    ok "agent-stephen registered ($MISSION_CONTROL_DIR/agents/agent-stephen.json)"
else
    warn "agent-stephen not registered yet — the bot self-registers on first start"
fi

# 6. Optional live send test
echo "[6/6] Live message test"
if [[ -n "$TEST_CHAT" && -n "$TOKEN" && -n "$BOT_USERNAME" ]]; then
    SENT="$(curl -sS --max-time 15 -X POST "$API_BASE/bot$TOKEN/sendMessage" \
        -H 'Content-Type: application/json' \
        -d "{\"chat_id\": \"$TEST_CHAT\", \"text\": \"🧽 Stephen health check — bot token + send path OK ($(date -u +%H:%M:%SZ))\"}" 2>/dev/null || echo '{}')"
    if [[ "$(json_get "$SENT" 'd.ok')" == "true" ]]; then
        ok "Test message delivered to chat $TEST_CHAT"
    else
        bad "Send failed: $(json_get "$SENT" 'd.description')"
        echo "      → 'chat not found' means that chat hasn't messaged the bot yet — open Telegram, send /start to @$BOT_USERNAME first."
    fi
else
    warn "Skipped — pass --chat <chat_id> to send a real test message (DM the bot /start first, then use your chat id)"
fi

echo "─────────────────────────────────────────────────"
echo "Result: $PASS passed · $WARN warnings · $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
    echo "❌ Stephen is NOT fully working — fix the ❌ items above (see docs/STEPHEN-BOT.md)."
    exit 1
elif [[ $WARN -gt 0 ]]; then
    echo "🟡 Stephen is reachable but not fully verified — clear the ⚠️ items to be sure."
    exit 0
else
    echo "🟢 Stephen is working."
    exit 0
fi
