#!/usr/bin/env node
/**
 * Stephen — SB Detailing CEO Telegram Bot
 *
 * Long-polling Telegram bot that fronts SB Detailing (mobile car & boat
 * detailing — Destin / Fort Walton Beach / Navarre, FL) as "Stephen", the CEO,
 * and plugs into Mission Control:
 *
 *   - /ping /status /tasks give live health + board state from .mission-control/
 *   - "/task <text>" (or @mentioning the bot in a group) files a Mission
 *     Control task assigned to agent-stephen
 *   - plain DMs get a conversational reply as Stephen (Claude if
 *     ANTHROPIC_API_KEY is set, a canned CEO reply otherwise)
 *   - registers agent-stephen in .mission-control/agents/ on first run
 *
 * Zero dependencies — built-in fetch (Node 18+). Run standalone:
 *
 *   TELEGRAM_BOT_TOKEN_STEPHEN=123:abc node server/stephen-bot.js
 *   pm2 start server/stephen-bot.js --name stephen-bot
 *
 * Verify end-to-end with: ./scripts/check-stephen.sh
 * Full setup + troubleshooting: docs/STEPHEN-BOT.md
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MISSION_CONTROL_DIR = process.env.MISSION_CONTROL_DIR ||
    path.join(__dirname, '..', '.mission-control');
const CONFIG_PATH = path.join(MISSION_CONTROL_DIR, 'config', 'stephen.json');
const STATE_PATH = path.join(MISSION_CONTROL_DIR, 'config', 'stephen-state.json');

const AGENT_ID = 'agent-stephen';
const AGENT_NAME = 'Stephen';

// Overridable so check scripts / tests can point at a mock Telegram API
const TELEGRAM_API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const ANTHROPIC_API_BASE = process.env.ANTHROPIC_API_BASE || 'https://api.anthropic.com';
const AI_MODEL = process.env.STEPHEN_AI_MODEL || 'claude-sonnet-5';

const POLL_TIMEOUT_S = 50;              // Telegram long-poll timeout
const MAX_HISTORY_TURNS = 12;           // per-chat conversation memory for AI replies
const MAX_INPUT_CHARS = 4000;           // hard cap on text we process from Telegram

function loadFileConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch (e) {
        return {};
    }
}

const fileConfig = loadFileConfig();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN_STEPHEN ||
    fileConfig.token ||
    process.env.TELEGRAM_BOT_TOKEN || '';

// Optional allowlist: only reply in these chat ids (comma-separated env or array in config).
// Empty = open (chat ids are logged so you can lock down later).
const ALLOWED_CHATS = new Set(
    (process.env.STEPHEN_ALLOWED_CHATS
        ? process.env.STEPHEN_ALLOWED_CHATS.split(',')
        : (fileConfig.allowed_chats || [])
    ).map(id => String(id).trim()).filter(Boolean)
);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || fileConfig.anthropic_api_key || '';

// Same character policy as sanitizeInput() in server/index.js — strip characters
// that could break JSON-file consumers or get shell-interpolated downstream.
function sanitizeInput(val) {
    if (typeof val !== 'string') return val;
    return val.replace(/[<>"'`\\$;|&]/g, '');
}

// ---------------------------------------------------------------------------
// Persona
// ---------------------------------------------------------------------------

const BUSINESS_BLURB =
    'SB Detailing — mobile car & boat detailing on the Emerald Coast. ' +
    'We come to you: Destin, Fort Walton Beach, Navarre and nearby.';

const STEPHEN_SYSTEM_PROMPT = [
    `You are Stephen, the CEO of SB Detailing — a mobile car and boat detailing business serving Destin, Fort Walton Beach, and Navarre on Florida's Emerald Coast. You are chatting on Telegram.`,
    `Personality: direct, warm, hands-on owner-operator energy. Short messages (1-4 sentences unless asked for detail). No corporate fluff.`,
    `You can: answer questions about detailing services (interior/exterior detail, paint decontamination, boat washdowns and oxidation removal, fleet work), talk scheduling windows, and collect quote details (vehicle or boat type, size, condition, location, preferred date, phone or email).`,
    `You cannot: take payments, promise exact prices, or confirm bookings — say the owner will confirm. Never invent prices, phone numbers, or addresses.`,
    `If a message looks like a work instruction for the team (e.g. "update the website", "post the reel"), suggest they resend it as /task <what to do> so it lands on the Mission Control board.`,
].join('\n');

function cannedReply() {
    return [
        `Stephen here — CEO of SB Detailing. 🧽`,
        BUSINESS_BLURB,
        ``,
        `I can take a quote request or a job for the board:`,
        `/task <what you need> — file it for the team`,
        `/status — board + system status`,
        `/tasks — open items on my desk`,
        `/help — everything I respond to`,
        ``,
        `For a quote, tell me: car or boat, rough size/condition, where you're located, and a good contact.`,
    ].join('\n');
}

function helpText(botUsername) {
    return [
        `*Stephen — SB Detailing CEO* 🧽`,
        BUSINESS_BLURB,
        ``,
        `*Commands*`,
        `/ping — am I alive`,
        `/status — Mission Control board + bot health`,
        `/tasks — open tasks assigned to me`,
        `/task <text> — create a Mission Control task`,
        `/help — this message`,
        ``,
        `In groups, mention @${botUsername} with an instruction and I'll file it as a task.`,
        `DM me anything else and I'll answer as Stephen.`,
    ].join('\n');
}

// ---------------------------------------------------------------------------
// Telegram API helpers
// ---------------------------------------------------------------------------

function apiUrl(method) {
    return `${TELEGRAM_API_BASE}/bot${BOT_TOKEN}/${method}`;
}

// Never let the token leak into logs via error messages/URLs.
function redact(str) {
    return String(str).split(BOT_TOKEN).join('<token>');
}

async function tg(method, params = {}, { timeoutMs = 30000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(apiUrl(method), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params),
            signal: controller.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!body.ok) {
            const err = new Error(`Telegram ${method} failed: ${body.error_code || res.status} ${redact(body.description || '')}`);
            err.code = body.error_code || res.status;
            err.retryAfter = body.parameters && body.parameters.retry_after;
            throw err;
        }
        return body.result;
    } finally {
        clearTimeout(timer);
    }
}

async function sendMessage(chatId, text, { markdown = false } = {}) {
    const params = { chat_id: chatId, text: String(text).slice(0, 4096) };
    if (markdown) params.parse_mode = 'Markdown';
    try {
        return await tg('sendMessage', params);
    } catch (err) {
        if (err.retryAfter) {
            await sleep((err.retryAfter + 1) * 1000);
            return tg('sendMessage', params);
        }
        // Markdown parse errors (unbalanced * _ etc.) — retry as plain text
        if (markdown && err.code === 400) {
            delete params.parse_mode;
            return tg('sendMessage', params);
        }
        throw err;
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Mission Control integration (file-based, works with or without the server)
// ---------------------------------------------------------------------------

async function ensureAgentRegistered() {
    const agentPath = path.join(MISSION_CONTROL_DIR, 'agents', `${AGENT_ID}.json`);
    try {
        await fsp.access(agentPath);
        return false; // already registered
    } catch (e) { /* not registered yet */ }

    const now = new Date().toISOString();
    const agent = {
        id: AGENT_ID,
        name: AGENT_NAME,
        type: 'ai',
        role: 'specialist',
        designation: 'SB Detailing CEO',
        model: ANTHROPIC_API_KEY ? AI_MODEL : null,
        avatar: 'https://api.dicebear.com/7.x/bottts-neutral/svg?seed=stephen',
        status: 'active',
        parent_agent: null,
        sub_agents: [],
        capabilities: ['telegram', 'customer-contact', 'quotes', 'task-intake', 'sb-detailing'],
        personality: {
            about: 'Front-of-house CEO for SB Detailing. Talks to customers and the owner on Telegram, files work onto the Mission Control board, and keeps quotes moving.',
            tone: 'warm',
            traits: ['direct', 'customer-first', 'hands-on'],
            greeting: 'Stephen here — SB Detailing. What are we cleaning up today?',
        },
        channels: [
            { type: 'telegram', id: 'stephen-bot', notifications: ['task.assigned', 'task.commented'] },
        ],
        registered_at: now,
        last_active: now,
        current_tasks: [],
        completed_tasks: 0,
        metadata: {
            description: 'Telegram-facing CEO persona for SB Detailing (mobile car & boat detailing — Destin / Fort Walton Beach / Navarre).',
            clearance: 'BETA',
        },
    };
    await fsp.mkdir(path.dirname(agentPath), { recursive: true });
    await fsp.writeFile(agentPath, JSON.stringify(agent, null, 2));
    await logActivity(`REGISTERED: ${AGENT_ID} (Stephen — SB Detailing CEO) via stephen-bot`);
    return true;
}

let lastActiveWrite = 0;
async function touchLastActive() {
    // Throttled best-effort update so the dashboard shows Stephen as alive.
    if (Date.now() - lastActiveWrite < 60000) return;
    lastActiveWrite = Date.now();
    const agentPath = path.join(MISSION_CONTROL_DIR, 'agents', `${AGENT_ID}.json`);
    try {
        const agent = JSON.parse(await fsp.readFile(agentPath, 'utf-8'));
        agent.last_active = new Date().toISOString();
        await fsp.writeFile(agentPath, JSON.stringify(agent, null, 2));
    } catch (e) { /* non-fatal */ }
}

async function logActivity(line) {
    const logPath = path.join(MISSION_CONTROL_DIR, 'logs', 'activity.log');
    const entry = `${new Date().toISOString()} [${AGENT_ID}] ${line}\n`;
    try {
        await fsp.mkdir(path.dirname(logPath), { recursive: true });
        await fsp.appendFile(logPath, entry);
    } catch (e) { /* non-fatal */ }
}

async function loadTasks() {
    const tasksDir = path.join(MISSION_CONTROL_DIR, 'tasks');
    const tasks = [];
    let files = [];
    try {
        files = await fsp.readdir(tasksDir);
    } catch (e) {
        return tasks;
    }
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
            tasks.push(JSON.parse(await fsp.readFile(path.join(tasksDir, file), 'utf-8')));
        } catch (e) { /* skip unreadable/invalid task files */ }
    }
    return tasks;
}

const OPEN_STATUSES = new Set(['INBOX', 'ASSIGNED', 'IN_PROGRESS', 'REVIEW', 'BLOCKED', 'pending']);

function isOpen(task) {
    return OPEN_STATUSES.has(task.status);
}

async function createStephenTask({ text, from, chatId, messageId }) {
    const clean = sanitizeInput(text).trim().slice(0, MAX_INPUT_CHARS);
    if (!clean) return { success: false, error: 'Empty task text' };

    // Dedup: same description from Telegram within 5 minutes (mirrors telegram-bridge.js)
    const existing = await loadTasks();
    const now = Date.now();
    const dup = existing.find(t => t.source === 'telegram' && t.description === clean &&
        now - new Date(t.created_at || t.createdAt || 0).getTime() < 5 * 60 * 1000);
    if (dup) return { success: false, error: 'Duplicate task (already filed within 5 min)', taskId: dup.id };

    const id = `task-tg-stephen-${now}`;
    const iso = new Date(now).toISOString();
    let title = clean.split('\n')[0];
    title = (title.charAt(0).toUpperCase() + title.slice(1)).slice(0, 100) || 'Task from Telegram';

    // Schema-valid task (.mission-control/schema/task.schema.json)
    const task = {
        id,
        title,
        description: clean,
        status: 'ASSIGNED',
        priority: 'medium',
        assignee: AGENT_ID,
        created_by: AGENT_ID,
        created_at: iso,
        updated_at: iso,
        labels: ['telegram', 'sb-detailing'],
        comments: [],
        deliverables: [],
        dependencies: [],
        blocked_by: [],
        source: 'telegram',
        sourceData: {
            chat_id: String(chatId),
            message_id: String(messageId || ''),
            from: sanitizeInput(from || 'unknown'),
        },
    };

    const taskPath = path.join(MISSION_CONTROL_DIR, 'tasks', `${id}.json`);
    await fsp.mkdir(path.dirname(taskPath), { recursive: true });
    await fsp.writeFile(taskPath, JSON.stringify(task, null, 2));
    await logActivity(`TASK_CREATED: ${id} - "${title}" (from: ${sanitizeInput(from || 'unknown')} via Telegram)`);
    return { success: true, taskId: id, task };
}

// ---------------------------------------------------------------------------
// AI replies (optional — degrades to canned persona reply without a key)
// ---------------------------------------------------------------------------

const chatHistories = new Map(); // chatId -> [{role, content}]

async function aiReply(chatId, userText) {
    const history = chatHistories.get(chatId) || [];
    history.push({ role: 'user', content: userText });
    while (history.length > MAX_HISTORY_TURNS) history.shift();

    const res = await fetch(`${ANTHROPIC_API_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: AI_MODEL,
            max_tokens: 500,
            system: STEPHEN_SYSTEM_PROMPT,
            messages: history,
        }),
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Anthropic API ${res.status}: ${errBody.slice(0, 200)}`);
    }
    const data = await res.json();
    const reply = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (reply) {
        history.push({ role: 'assistant', content: reply });
        chatHistories.set(chatId, history);
    }
    return reply || cannedReply();
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

let BOT_USERNAME = '';
const startedAt = Date.now();

function fmtUptime() {
    const s = Math.floor((Date.now() - startedAt) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

async function statusText() {
    const tasks = await loadTasks();
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const mine = tasks.filter(t => t.assignee === AGENT_ID && isOpen(t));
    const countLine = Object.keys(counts).length
        ? Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ')
        : 'board is empty';
    return [
        `🟢 Stephen online — @${BOT_USERNAME}`,
        `Uptime: ${fmtUptime()} · AI replies: ${ANTHROPIC_API_KEY ? `on (${AI_MODEL})` : 'off (canned)'}`,
        `Board: ${countLine}`,
        `On my desk: ${mine.length} open task${mine.length === 1 ? '' : 's'}`,
        `Data dir: ${path.basename(path.dirname(MISSION_CONTROL_DIR))}/${path.basename(MISSION_CONTROL_DIR)}`,
    ].join('\n');
}

async function tasksText() {
    const tasks = (await loadTasks())
        .filter(t => t.assignee === AGENT_ID && isOpen(t))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
        .slice(0, 8);
    if (!tasks.length) return 'Desk is clear — no open tasks assigned to me. File one with /task <text>.';
    return ['📋 Open tasks on my desk:', ...tasks.map(t => `• [${t.status}] ${t.title} (${t.id})`)].join('\n');
}

function parseCommand(text) {
    const m = text.match(/^\/([a-zA-Z0-9_]+)(?:@(\S+))?(?:\s+([\s\S]*))?$/);
    if (!m) return null;
    // Ignore commands addressed to a different bot in the same group
    if (m[2] && BOT_USERNAME && m[2].toLowerCase() !== BOT_USERNAME.toLowerCase()) return { command: null };
    return { command: m[1].toLowerCase(), args: (m[3] || '').trim() };
}

async function handleMessage(msg) {
    if (!msg || !msg.text || (msg.from && msg.from.is_bot)) return;
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    const fromName = [msg.from && msg.from.first_name, msg.from && msg.from.last_name]
        .filter(Boolean).join(' ') || (msg.from && msg.from.username) || 'unknown';
    const text = msg.text.slice(0, MAX_INPUT_CHARS);

    if (ALLOWED_CHATS.size && !ALLOWED_CHATS.has(String(chatId))) {
        console.log(`[stephen] Ignoring chat ${chatId} (not in STEPHEN_ALLOWED_CHATS)`);
        return;
    }
    console.log(`[stephen] ${isGroup ? 'group' : 'dm'} ${chatId} <${fromName}>: ${text.slice(0, 80)}`);
    touchLastActive();

    const cmd = parseCommand(text);
    if (cmd) {
        if (cmd.command === null) return; // another bot's command
        switch (cmd.command) {
            case 'start':
            case 'help':
                return sendMessage(chatId, helpText(BOT_USERNAME), { markdown: true });
            case 'ping':
                return sendMessage(chatId, `🟢 Stephen online — SB Detailing HQ. Uptime ${fmtUptime()}.`);
            case 'status':
                return sendMessage(chatId, await statusText());
            case 'tasks':
                return sendMessage(chatId, await tasksText());
            case 'task': {
                if (!cmd.args) return sendMessage(chatId, 'Give me something to file: /task <what needs doing>');
                const result = await createStephenTask({ text: cmd.args, from: fromName, chatId, messageId: msg.message_id });
                return sendMessage(chatId, result.success
                    ? `✅ Filed on the board: "${result.task.title}" (${result.taskId})`
                    : `⚠️ Not filed — ${result.error}`);
            }
            default:
                return sendMessage(chatId, `Don't know /${cmd.command} — try /help.`);
        }
    }

    // Group message that @mentions the bot → treat as a task instruction
    if (isGroup) {
        const mention = BOT_USERNAME && text.toLowerCase().includes(`@${BOT_USERNAME.toLowerCase()}`);
        if (!mention) return; // stay quiet in groups unless addressed
        const stripped = text.replace(new RegExp(`@${BOT_USERNAME}`, 'gi'), '').trim();
        if (!stripped) return sendMessage(chatId, `Here — what do you need? /help for commands.`);
        const result = await createStephenTask({ text: stripped, from: fromName, chatId, messageId: msg.message_id });
        return sendMessage(chatId, result.success
            ? `✅ On it — filed "${result.task.title}" (${result.taskId})`
            : `⚠️ Not filed — ${result.error}`);
    }

    // Plain DM → conversational reply as Stephen
    if (ANTHROPIC_API_KEY) {
        try {
            return await sendMessage(chatId, await aiReply(String(chatId), text));
        } catch (err) {
            console.error('[stephen] AI reply failed, using canned reply:', redact(err.message));
        }
    }
    return sendMessage(chatId, cannedReply());
}

// ---------------------------------------------------------------------------
// Polling loop
// ---------------------------------------------------------------------------

async function loadOffset() {
    try {
        const state = JSON.parse(await fsp.readFile(STATE_PATH, 'utf-8'));
        return Number(state.offset) || 0;
    } catch (e) {
        return 0;
    }
}

async function saveOffset(offset) {
    try {
        await fsp.mkdir(path.dirname(STATE_PATH), { recursive: true });
        await fsp.writeFile(STATE_PATH, JSON.stringify({ offset, updated_at: new Date().toISOString() }, null, 2));
    } catch (e) { /* non-fatal */ }
}

let running = true;

async function pollLoop() {
    let offset = await loadOffset();
    let backoffMs = 1000;
    while (running) {
        try {
            const updates = await tg('getUpdates', {
                offset,
                timeout: POLL_TIMEOUT_S,
                allowed_updates: ['message'],
            }, { timeoutMs: (POLL_TIMEOUT_S + 10) * 1000 });
            backoffMs = 1000;
            for (const update of updates) {
                offset = update.update_id + 1;
                try {
                    await handleMessage(update.message);
                } catch (err) {
                    console.error('[stephen] Failed handling update:', redact(err.message));
                }
            }
            if (updates.length) await saveOffset(offset);
        } catch (err) {
            if (!running) break;
            if (err.code === 409) {
                console.error('[stephen] 409 Conflict — another process is polling this bot token ' +
                    '(a second stephen-bot instance, or a webhook grabbing updates). ' +
                    'Stop the other consumer, then restart. Retrying in 30s…');
                await sleep(30000);
            } else {
                console.error('[stephen] Poll error:', redact(err.message), `— retrying in ${backoffMs / 1000}s`);
                await sleep(backoffMs);
                backoffMs = Math.min(backoffMs * 2, 60000);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function main() {
    if (!BOT_TOKEN) {
        console.error(
            '[stephen] No bot token found. Set TELEGRAM_BOT_TOKEN_STEPHEN (or "token" in ' +
            `${CONFIG_PATH}).\n` +
            '[stephen] Get a token from @BotFather on Telegram: /newbot → name "Stephen — SB Detailing" → copy the token.\n' +
            '[stephen] Full setup: docs/STEPHEN-BOT.md'
        );
        process.exit(1);
    }

    let me;
    try {
        me = await tg('getMe');
    } catch (err) {
        if (err.code === 401) {
            console.error('[stephen] Telegram rejected the token (401 Unauthorized). ' +
                'Re-copy it from @BotFather (/mybots → API Token) — the current value is wrong or revoked.');
            process.exit(1);
        }
        console.error('[stephen] Could not reach Telegram:', redact(err.message));
        process.exit(1);
    }
    BOT_USERNAME = me.username;

    // Long polling and webhooks are mutually exclusive on Telegram's side.
    try {
        const webhook = await tg('getWebhookInfo');
        if (webhook && webhook.url) {
            if (process.env.STEPHEN_DROP_WEBHOOK === '1') {
                await tg('deleteWebhook', { drop_pending_updates: false });
                console.log('[stephen] Removed existing webhook (STEPHEN_DROP_WEBHOOK=1) — polling instead.');
            } else {
                console.error(`[stephen] A webhook is set for @${BOT_USERNAME} (${redact(webhook.url)}). ` +
                    'Polling cannot run while a webhook is registered. ' +
                    'Re-run with STEPHEN_DROP_WEBHOOK=1 to remove it, or keep the webhook and skip this bot.');
                process.exit(1);
            }
        }
    } catch (err) {
        console.error('[stephen] Could not check webhook state:', redact(err.message));
    }

    const registered = await ensureAgentRegistered();
    console.log(`[stephen] 🧽 Stephen online as @${BOT_USERNAME} (${me.first_name})`);
    console.log(`[stephen] Mission Control dir: ${MISSION_CONTROL_DIR}`);
    console.log(`[stephen] Agent ${AGENT_ID}: ${registered ? 'registered' : 'already registered'}`);
    console.log(`[stephen] AI replies: ${ANTHROPIC_API_KEY ? `enabled (${AI_MODEL})` : 'disabled — canned persona replies (set ANTHROPIC_API_KEY to enable)'}`);
    console.log(`[stephen] Allowed chats: ${ALLOWED_CHATS.size ? [...ALLOWED_CHATS].join(', ') : 'all (set STEPHEN_ALLOWED_CHATS to restrict)'}`);
    await logActivity(`ONLINE: stephen-bot connected as @${BOT_USERNAME}`);

    await pollLoop();
}

function shutdown(signal) {
    console.log(`[stephen] ${signal} received — shutting down.`);
    running = false;
    // Give the in-flight poll a moment to unwind, then exit.
    setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
    main().catch(err => {
        console.error('[stephen] Fatal:', redact(err && err.stack || err));
        process.exit(1);
    });
}

module.exports = { parseCommand, createStephenTask, sanitizeInput };
