/**
 * Live NBA Scores — Stream Deck Plugin
 * NBA, WNBA, and NBA G League scores via ESPN's public site API.
 * Uses Node.js built-in modules only (net, https, crypto, zlib).
 * No npm packages required.
 */

'use strict';

const net    = require('net');
const https  = require('https');
const crypto = require('crypto');
const events = require('events');
const path   = require('path');
const fs     = require('fs');
const zlib   = require('zlib');

// ── Logging ───────────────────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, 'plugin.log');
try { fs.writeFileSync(LOG_FILE, `=== NBA Plugin ${new Date().toISOString()} ===\nNode: ${process.version}\nArgs: ${process.argv.slice(2).join(' ')}\n`); } catch (e) { /* ignore */ }

function log(...args) {
    const ts   = new Date().toISOString().slice(11, 19);
    const line = `[${ts}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) { /* ignore */ }
}

process.on('uncaughtException',  err => log('CRASH:', err.stack || err.message));
process.on('unhandledRejection', err => log('UNHANDLED:', String(err)));

// ── TEST MODE (dev only) ────────────────────────────────────────────────────
// Set to a date string (e.g. '2026-03-15') to make the plugin think "today" is
// that date, so it pulls that day's scoreboard for testing and screenshots.
// MUST be set back to null before shipping a release.
const DEBUG_ANCHOR_DATE = null;
if (DEBUG_ANCHOR_DATE) log('*** TEST MODE: pretending today is ' + DEBUG_ANCHOR_DATE + ' ***');

// Keyed by '<league>:<teamId>' — skips the ESPN fetch for that team only and
// renders the fixed game below instead, so each key can show a different test
// state at the same time (handy for lining up Marketplace screenshots without
// waiting for real games). A value of `null` forces the "No Game" state.
// MUST be set back to {} before shipping a release.
// Example:
// const DEBUG_FAKE_GAMES = {
//     'nba:18': {   // Knicks — pre-game
//         state: 'preview', matchup: 'BOS @ NY', awayId: '2', homeId: '18',
//         awayAbbr: 'BOS', homeAbbr: 'NY', time: '7:30 PM', link: 'https://www.espn.com/nba/',
//     },
//     'nba:13': {   // Lakers — live, clutch time (red clock)
//         state: 'live', matchup: 'LAL @ GS', awayId: '13', homeId: '9', awayAbbr: 'LAL', homeAbbr: 'GS',
//         awayScore: 108, homeScore: 110, period: 4, clock: '1:12', statusName: 'STATUS_IN_PROGRESS',
//         link: 'https://www.espn.com/nba/',
//     },
//     'wnba:9': {   // Liberty — final
//         state: 'final', matchup: 'NY @ LV', awayId: '9', homeId: '17', awayAbbr: 'NY', homeAbbr: 'LV',
//         awayScore: 88, homeScore: 81, period: 4, link: 'https://www.espn.com/wnba/',
//     },
// };
const DEBUG_FAKE_GAMES = {};
if (Object.keys(DEBUG_FAKE_GAMES).length) log('*** TEST MODE: returning fake games for ' + Object.keys(DEBUG_FAKE_GAMES).join(', ') + ' ***');

// ── Parse Stream Deck launch arguments ────────────────────────────────────────
let sdPort, pluginUUID, registerEvent;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-port')          sdPort        = argv[i + 1];
    if (argv[i] === '-pluginUUID')    pluginUUID    = argv[i + 1];
    if (argv[i] === '-registerEvent') registerEvent = argv[i + 1];
}

log('port=' + sdPort + ' uuid=' + pluginUUID + ' event=' + registerEvent);

if (!sdPort || !pluginUUID || !registerEvent) {
    log('ERROR: Missing required args. Stream Deck may not have launched this plugin correctly.');
    process.exit(1);
}

// ── Minimal WebSocket client (no external deps) ───────────────────────────────
class SimpleWS extends events.EventEmitter {
    constructor(port, host) {
        super();
        this.readyState  = 0; // CONNECTING
        this._buf        = Buffer.alloc(0);
        this._handshaked = false;

        this._sock = net.createConnection(parseInt(port, 10), host || '127.0.0.1');

        this._sock.on('connect', () => {
            log('TCP connected, sending WS upgrade...');
            const key = crypto.randomBytes(16).toString('base64');
            this._sock.write([
                'GET / HTTP/1.1',
                `Host: 127.0.0.1:${port}`,
                'Upgrade: websocket',
                'Connection: Upgrade',
                `Sec-WebSocket-Key: ${key}`,
                'Sec-WebSocket-Version: 13',
                '', '',
            ].join('\r\n'));
        });

        this._sock.on('data',  chunk => this._onData(chunk));
        this._sock.on('error', err   => { log('TCP error:', err.message); this.emit('error', err); });
        this._sock.on('close', ()    => { this.readyState = 3; log('TCP closed'); this.emit('close'); });
    }

    _onData(chunk) {
        this._buf = Buffer.concat([this._buf, chunk]);

        if (!this._handshaked) {
            let end = -1;
            for (let i = 0; i <= this._buf.length - 4; i++) {
                if (this._buf[i]===13 && this._buf[i+1]===10 &&
                    this._buf[i+2]===13 && this._buf[i+3]===10) { end = i + 4; break; }
            }
            if (end === -1) return;

            const header = this._buf.slice(0, end).toString('ascii');
            log('HTTP response:', header.split('\r\n')[0]);

            if (!header.includes('101')) {
                log('WS upgrade failed!');
                this.emit('error', new Error('WebSocket upgrade rejected'));
                return;
            }

            this._handshaked = true;
            this.readyState  = 1; // OPEN
            this._buf        = this._buf.slice(end);
            log('WS handshake OK');
            this.emit('open');
        }

        this._parseFrames();
    }

    _parseFrames() {
        while (this._buf.length >= 2) {
            const b0       = this._buf[0];
            const b1       = this._buf[1];
            const opcode   = b0 & 0x0f;
            const isMasked = !!(b1 & 0x80);
            let   plen     = b1 & 0x7f;
            let   offset   = 2;

            if (plen === 126) {
                if (this._buf.length < 4) return;
                plen = this._buf.readUInt16BE(2); offset = 4;
            } else if (plen === 127) {
                if (this._buf.length < 10) return;
                plen = Number(this._buf.readBigUInt64BE(2)); offset = 10;
            }

            const maskLen = isMasked ? 4 : 0;
            const total   = offset + maskLen + plen;
            if (this._buf.length < total) return;

            let payload = Buffer.from(this._buf.slice(offset + maskLen, total));
            if (isMasked) {
                const mask = this._buf.slice(offset, offset + 4);
                for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
            }
            this._buf = this._buf.slice(total);

            if      (opcode === 0x1) this.emit('message', payload.toString('utf8'));
            else if (opcode === 0x8) { this.readyState = 3; log('WS close frame'); this.emit('close'); return; }
            else if (opcode === 0x9) this._sendFrame(0x8a, payload); // pong — must echo ping payload per RFC 6455
        }
    }

    send(str) {
        if (this.readyState !== 1) { log('WARN: send() called but WS not open (state=' + this.readyState + ')'); return; }
        this._sendFrame(0x81, Buffer.from(String(str), 'utf8'));
    }

    // Write one WebSocket frame. Client frames must be masked per RFC 6455.
    _sendFrame(opcode, payload) {
        const len  = payload.length;
        const mask = crypto.randomBytes(4);
        let   hdr;

        if (len < 126) {
            hdr = Buffer.alloc(6);
            hdr[0] = opcode; hdr[1] = 0x80 | len;
            mask.copy(hdr, 2);
        } else if (len < 65536) {
            hdr = Buffer.alloc(8);
            hdr[0] = opcode; hdr[1] = 0x80 | 126;
            hdr.writeUInt16BE(len, 2);
            mask.copy(hdr, 4);
        } else {
            log('WS: payload too large (' + len + ' bytes)'); return;
        }

        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
        this._sock.write(Buffer.concat([hdr, masked]));
    }
}

// ── Plugin state ──────────────────────────────────────────────────────────────
const instances     = new Map(); // context -> settings ({ league, teamId, teamAbbr, teamName, linkType, customLink, bgColor, bgOpacity })
const prevLeader    = new Map(); // context -> { eventId, leaderId } — last team that held the lead (ties don't reset it)
const prevState     = new Map(); // context -> last known game state string
const flashing      = new Set(); // contexts mid-flash animation
const refreshing    = new Set(); // contexts mid-async refresh
const lastRender    = new Map(); // context -> JSON key of last rendered lines
const currentGame   = new Map(); // context -> parsed game object | null
const refreshTimers = new Map(); // context -> timeoutId (self-rescheduling; cadence varies, see scheduleNextRefresh)
const gameFinalAt   = new Map(); // context -> timestamp when live→final was detected (drives the Custom Link post-final grace window)

// ── Connect to Stream Deck ────────────────────────────────────────────────────
log('Connecting to Stream Deck on port', sdPort);
const ws = new SimpleWS(sdPort);

ws.on('open', () => {
    log('WS open — registering plugin');
    ws.send(JSON.stringify({ event: registerEvent, uuid: pluginUUID }));
});

ws.on('message', raw => {
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { log('Bad JSON:', e.message); return; }
    log('← SD event:', ev.event, ev.context ? ev.context.slice(0, 8) : '');
    try { handleEvent(ev); } catch (e) { log('handleEvent crash:', e.stack || e.message); }
});

ws.on('error', err => log('WS error:', err.message));
ws.on('close', ()  => {
    log('WS closed — exiting so Stream Deck can restart');
    setTimeout(() => process.exit(0), 2000);
});

// ── Stream Deck event handler ─────────────────────────────────────────────────
function handleEvent({ event, context, payload }) {
    switch (event) {

        case 'willAppear':
            instances.set(context, (payload && payload.settings) || {});
            log('willAppear — settings:', instances.get(context));
            if (refreshTimers.has(context)) clearTimeout(refreshTimers.get(context));
            refreshButton(context);
            scheduleNextRefresh(context);
            break;

        case 'willDisappear':
            instances.delete(context);
            prevLeader.delete(context);
            prevState.delete(context);
            lastRender.delete(context);
            currentGame.delete(context);
            gameFinalAt.delete(context);
            refreshing.delete(context);
            flashing.delete(context);
            if (refreshTimers.has(context)) {
                clearTimeout(refreshTimers.get(context));
                refreshTimers.delete(context);
            }
            break;

        case 'didReceiveSettings':
            instances.set(context, (payload && payload.settings) || {});
            log('didReceiveSettings:', instances.get(context));
            lastRender.delete(context);
            refreshButton(context);
            break;

        case 'keyUp': {
            const cfg  = instances.get(context) || {};
            const game = currentGame.get(context);
            const url  = resolveLink(cfg, game, context);
            log('keyUp — opening URL:', url);
            if (url) ws.send(JSON.stringify({ event: 'openUrl', payload: { url } }));
            if (!(game && game.link)) {
                lastRender.delete(context);
                refreshButton(context);
            }
            break;
        }

        case 'sendToPlugin':
            if (payload && payload.event === 'requestTeams') {
                sendLiveTeams(context).catch(e => log('sendLiveTeams error:', e.message));
            } else if (payload && payload.settings) {
                instances.set(context, payload.settings);
                lastRender.delete(context);
                refreshButton(context);
            }
            break;
    }
}

// ── League config ─────────────────────────────────────────────────────────────
// All three leagues come from the same ESPN site API, in the same shape — only
// the URL path differs. `web` is the matching www.espn.com section, used for
// the team-schedule fallback link.
const LEAGUES = {
    nba:     { label: 'NBA',      api: 'nba',             web: 'nba'          },
    wnba:    { label: 'WNBA',     api: 'wnba',            web: 'wnba'         },
    gleague: { label: 'G League', api: 'nba-development', web: 'nba-g-league' },
};
const leagueConf = league => LEAGUES[league] || LEAGUES.nba;
const ESPN_BASE  = 'https://site.api.espn.com/apis/site/v2/sports/basketball/';

// ── Adaptive refresh cadence ───────────────────────────────────────────────────
// Every 30 seconds normally, dropping to every 15 seconds in "clutch time" —
// the last 2:00 of the 4th quarter or of any overtime — when a single missed
// window can skip right past a lead change. Same idea as the NFL/CFB plugins'
// two-minute-warning cadence. Self-rescheduling (setTimeout that re-arms
// after each refresh) since the right delay depends on the refresh result.
function nextRefreshDelay(context) {
    return isClutchTime(currentGame.get(context)) ? 15_000 : 30_000;
}

function isClutchTime(game) {
    if (!game || game.state !== 'live' || game.period < 4) return false;
    if (game.statusName === 'STATUS_END_PERIOD' || game.statusName === 'STATUS_HALFTIME') return false;
    const secondsLeft = parseClockSeconds(game.clock);
    return secondsLeft !== null && secondsLeft <= 120;
}

function scheduleNextRefresh(context) {
    const delay = nextRefreshDelay(context);
    const timer = setTimeout(async () => {
        await refreshButton(context);
        // Only re-arm if this key is still on screen and this timer is still
        // the one it owns — a willDisappear or fresh willAppear can land while
        // the fetch above is in flight.
        if (!instances.has(context) || refreshTimers.get(context) !== timer) return;
        scheduleNextRefresh(context);
    }, delay);
    refreshTimers.set(context, timer);
}

// ── Key-press link ────────────────────────────────────────────────────────────
// Defaults to (and always falls back to) ESPN Gamecast. A Custom Link only
// takes over once the game has actually started, and hands back to Gamecast
// 30 minutes after the final — same grace window as the other five plugins.
// With no game at all (true offseason), opens the team's ESPN schedule.
const CUSTOM_LINK_FINAL_GRACE_MS = 30 * 60 * 1000;

// Tidies a user-typed Custom Link: trims whitespace and adds https:// when no
// scheme was typed, since Stream Deck won't open a bare domain as a web page.
// Returns '' for anything that can't be a web link (blank, or a non-http
// scheme like file:), so callers fall back to the default link.
function normalizeCustomUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(javascript|data|file|vbscript|mailto):/i.test(s)) return '';
    return 'https://' + s.replace(/^\/+/, '');
}

function scheduleFallbackUrl(league, teamId) {
    const web = leagueConf(league).web;
    return teamId ? `https://www.espn.com/${web}/team/schedule/_/id/${teamId}`
                  : `https://www.espn.com/${web}/schedule`;
}

function resolveLink(cfg, game, context) {
    const customUrl = normalizeCustomUrl(cfg.customLink);
    if (cfg.linkType === 'custom' && customUrl && game) {
        let useCustom = game.state === 'live' || game.state === 'final' || game.state === 'delay';
        if (useCustom && game.state === 'final') {
            const finalAt = gameFinalAt.get(context);
            if (!finalAt || Date.now() - finalAt > CUSTOM_LINK_FINAL_GRACE_MS) useCustom = false;
        }
        if (useCustom) return customUrl;
    }
    if (game && game.link) return game.link;
    return scheduleFallbackUrl(cfg.league || 'nba', cfg.teamId);
}

// ── Refresh one button ────────────────────────────────────────────────────────
async function refreshButton(context) {
    if (refreshing.has(context)) { log('Refresh already in progress, skipping'); return; }
    if (flashing.has(context))   { log('Flash in progress, skipping refresh'); return; }

    const cfg = instances.get(context);
    if (!cfg || !cfg.teamId) {
        setButton(context, ['Select A', 'Team In', 'Settings']);
        return;
    }

    const league = LEAGUES[cfg.league] ? cfg.league : 'nba';

    refreshing.add(context);
    log('Refreshing', league, cfg.teamAbbr || cfg.teamId);
    try {
        const game = await fetchTeamGame(league, cfg.teamId);
        currentGame.set(context, game || null);

        // Detect live → final transition and play fireworks
        const prevGameState = prevState.get(context);
        prevState.set(context, game ? game.state : null);
        if (!game || game.state !== 'final') gameFinalAt.delete(context);
        if (prevGameState === 'live' && game && game.state === 'final') {
            gameFinalAt.set(context, Date.now()); // starts the Custom Link post-final grace window
            const winnerId = game.homeScore >= game.awayScore ? game.homeId : game.awayId;
            log('Game over — fireworks for', teamName(league, winnerId));
            refreshing.delete(context);
            playFireworks(context, teamName(league, winnerId), flashColor(league, winnerId)).catch(e => log('fireworks error:', e.message));
            return;
        }

        const lines   = buildLines(game, cfg);
        const spacing = lines.some(l => typeof l === 'object') ? 1.2 : 1.4;
        log('→', JSON.stringify(lines));

        // Lead-change flash. In basketball the score changes nearly every poll,
        // so flashing on every basket (as the NFL/NHL plugins do per score)
        // would mean a key that never stops flashing. Instead: flash in the new
        // leader's color only when the lead actually flips from one team to the
        // other. A tie doesn't count as a change and doesn't reset who last
        // led, so "BOS leads → tie → NY leads" flashes once (for NY), and the
        // first lead of the game (from 0-0) doesn't flash at all.
        if (game && game.state === 'live') {
            const leaderId = game.awayScore > game.homeScore ? game.awayId
                           : game.homeScore > game.awayScore ? game.homeId
                           : null;
            const prev = prevLeader.get(context);
            const samePrevGame = prev && prev.eventId === game.eventId;
            if (leaderId) prevLeader.set(context, { eventId: game.eventId, leaderId });
            else if (!samePrevGame) prevLeader.set(context, { eventId: game.eventId, leaderId: null });

            if (leaderId && samePrevGame && prev.leaderId && prev.leaderId !== leaderId) {
                const color = flashColor(league, leaderId);
                log('Lead change — flashing', color);
                refreshing.delete(context);
                flashButton(context, color, lines, spacing, resolveBgColor(cfg)).catch(e => log('flashButton error:', e.message));
                return;
            }
        } else {
            prevLeader.delete(context);
        }

        setButton(context, lines, spacing, resolveBgColor(cfg));
    } catch (err) {
        log('Fetch error:', err.message);
        setButton(context, [cfg.teamAbbr || leagueConf(league).label, 'Err'], undefined, resolveBgColor(cfg));
    } finally {
        refreshing.delete(context);
    }
}

// ── Text sizing ───────────────────────────────────────────────────────────────
// Real Helvetica-Bold glyph widths (per 1000 em units, standard AFM metrics),
// so wide abbreviations ("WSH", "MEM") get sized as precisely as narrow ones
// ("NY", "SA"). Basketball scores run three digits, so unlike the NHL plugin a
// fixed font size can't cover every "ABBR 123" line — fitFs() shrinks each
// game's score lines just enough to fit the key, and both lines share the
// smaller size so they stay visually matched.
const GLYPH_WIDTH_1000 = {
    A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
    J: 556, K: 722, L: 611, M: 889, N: 722, O: 778, P: 667, Q: 778, R: 722,
    S: 667, T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
    0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
    ' ': 278,
};
function textWidthPx(str, fs) {
    let units = 0;
    for (const ch of str) units += GLYPH_WIDTH_1000[ch] !== undefined ? GLYPH_WIDTH_1000[ch] : 600;
    return units * fs / 1000;
}
function fitFs(text, maxFs) {
    let fs = maxFs;
    while (fs > 9 && textWidthPx(text, fs) > 64) fs--;
    return fs;
}

// ── Period / clock labels ─────────────────────────────────────────────────────
function periodLabel(period) {
    if (period >= 1 && period <= 4) return 'Q' + period;
    const ot = period - 4;
    return ot <= 1 ? 'OT' : ot + 'OT';
}

// Parses ESPN's display clock into seconds. ESPN uses "M:SS" above a minute
// and "SS.s" (tenths) inside the final minute; returns null for anything else.
function parseClockSeconds(clockStr) {
    if (!clockStr) return null;
    const s = String(clockStr).trim();
    let m = /^(\d+):(\d{2})(?:\.\d+)?$/.exec(s);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    m = /^(\d+(?:\.\d+)?)$/.exec(s);
    if (m) return parseFloat(m[1]);
    return null;
}

// ── Build button display lines ────────────────────────────────────────────────
const CLOCK_GOLD   = '#FFD700';
const CLUTCH_RED   = '#FF3B30';

function buildLines(game, cfg) {
    const abbr = cfg.teamAbbr || leagueConf(cfg.league).label;
    if (!game) return [abbr, 'No Game'];

    if (game.state === 'nextgame') return [
        { text: 'Next Game', fs: 12, color: '#AAAAAA' },
        game.matchup,
        game.dateLabel + ' ' + game.time,
    ];
    if (game.state === 'preview') return [game.matchup, game.time];
    if (game.state === 'ppd')     return [game.matchup, { text: 'PPD',   fs: 16, color: '#E74C3C' }];
    if (game.state === 'delay')   return [game.matchup, { text: 'DELAY', fs: 14, color: '#3498DB' }];

    if (game.state === 'live' || game.state === 'final') {
        const awayText = game.awayAbbr + ' ' + game.awayScore;
        const homeText = game.homeAbbr + ' ' + game.homeScore;
        const fs       = Math.min(fitFs(awayText, 18), fitFs(homeText, 18));

        let statusText, statusColor = CLOCK_GOLD, statusFs = 11;
        if (game.state === 'final') {
            const ot = game.period > 4 ? game.period - 4 : 0;
            statusText = ot === 0 ? 'Final' : (ot === 1 ? 'Final/OT' : 'Final/' + ot + 'OT');
            statusFs   = 12;
        } else if (game.statusName === 'STATUS_HALFTIME') {
            statusText = 'Halftime';
        } else if (game.statusName === 'STATUS_END_PERIOD') {
            statusText = 'End ' + periodLabel(game.period);
        } else {
            statusText = ((game.clock || '') + ' ' + periodLabel(game.period)).trim();
            if (isClutchTime(game)) statusColor = CLUTCH_RED;
        }

        return [
            { text: awayText,   fs },
            { text: homeText,   fs },
            { text: statusText, fs: statusFs, color: statusColor },
        ];
    }

    return [abbr, '---'];
}

// ── Team data ─────────────────────────────────────────────────────────────────
// Keyed by league, then ESPN team id. Colors are ESPN's own primary/alternate
// team colors. `abbr` is what the key shows — ESPN's abbreviation except where
// it's too wide for a three-digit score line (Utah's "UTAH" → UTA, and two
// G League teams whose ESPN codes are full words). The property inspector
// pulls the live team list from ESPN, so a new or relocated team still works
// without a plugin update; this table just supplies display abbreviations and
// flash colors, falling back to ESPN's abbreviation and white.
const TEAMS = {
    nba: {
        '2':      { abbr: 'BOS',  short: "Celtics",          color: '#008348', alt: '#FFFFFF' }, // Boston Celtics
        '17':     { abbr: 'BKN',  short: "Nets",             color: '#000000', alt: '#FFFFFF' }, // Brooklyn Nets
        '18':     { abbr: 'NY',   short: "Knicks",           color: '#1D428A', alt: '#F58426' }, // New York Knicks
        '20':     { abbr: 'PHI',  short: "76ers",            color: '#1D428A', alt: '#E01234' }, // Philadelphia 76ers
        '28':     { abbr: 'TOR',  short: "Raptors",          color: '#D91244', alt: '#000000' }, // Toronto Raptors
        '4':      { abbr: 'CHI',  short: "Bulls",            color: '#CE1141', alt: '#000000' }, // Chicago Bulls
        '5':      { abbr: 'CLE',  short: "Cavaliers",        color: '#860038', alt: '#BC945C' }, // Cleveland Cavaliers
        '8':      { abbr: 'DET',  short: "Pistons",          color: '#1D428A', alt: '#C8102E' }, // Detroit Pistons
        '11':     { abbr: 'IND',  short: "Pacers",           color: '#0C2340', alt: '#FFD520' }, // Indiana Pacers
        '15':     { abbr: 'MIL',  short: "Bucks",            color: '#00471B', alt: '#EEE1C6' }, // Milwaukee Bucks
        '7':      { abbr: 'DEN',  short: "Nuggets",          color: '#0E2240', alt: '#FEC524' }, // Denver Nuggets
        '16':     { abbr: 'MIN',  short: "Timberwolves",     color: '#266092', alt: '#79BC43' }, // Minnesota Timberwolves
        '25':     { abbr: 'OKC',  short: "Thunder",          color: '#007AC1', alt: '#EF3B24' }, // Oklahoma City Thunder
        '22':     { abbr: 'POR',  short: "Trail Blazers",    color: '#E03A3E', alt: '#000000' }, // Portland Trail Blazers
        '26':     { abbr: 'UTA',  short: "Jazz",             color: '#4E008E', alt: '#79A3DC' }, // Utah Jazz
        '9':      { abbr: 'GS',   short: "Warriors",         color: '#FDB927', alt: '#1D428A' }, // Golden State Warriors
        '12':     { abbr: 'LAC',  short: "Clippers",         color: '#12173F', alt: '#C8102E' }, // LA Clippers
        '13':     { abbr: 'LAL',  short: "Lakers",           color: '#552583', alt: '#FDB927' }, // Los Angeles Lakers
        '21':     { abbr: 'PHX',  short: "Suns",             color: '#29127A', alt: '#E56020' }, // Phoenix Suns
        '23':     { abbr: 'SAC',  short: "Kings",            color: '#5A2D81', alt: '#6A7A82' }, // Sacramento Kings
        '1':      { abbr: 'ATL',  short: "Hawks",            color: '#C8102E', alt: '#FDB927' }, // Atlanta Hawks
        '30':     { abbr: 'CHA',  short: "Hornets",          color: '#008CA8', alt: '#1D1060' }, // Charlotte Hornets
        '14':     { abbr: 'MIA',  short: "Heat",             color: '#98002E', alt: '#000000' }, // Miami Heat
        '19':     { abbr: 'ORL',  short: "Magic",            color: '#0150B5', alt: '#9CA0A3' }, // Orlando Magic
        '27':     { abbr: 'WSH',  short: "Wizards",          color: '#E31837', alt: '#002B5C' }, // Washington Wizards
        '6':      { abbr: 'DAL',  short: "Mavericks",        color: '#0064B1', alt: '#BBC4CA' }, // Dallas Mavericks
        '10':     { abbr: 'HOU',  short: "Rockets",          color: '#CE0E2D', alt: '#000000' }, // Houston Rockets
        '29':     { abbr: 'MEM',  short: "Grizzlies",        color: '#5D76A9', alt: '#12173F' }, // Memphis Grizzlies
        '3':      { abbr: 'NO',   short: "Pelicans",         color: '#0A2240', alt: '#B4975A' }, // New Orleans Pelicans
        '24':     { abbr: 'SA',   short: "Spurs",            color: '#000000', alt: '#C4CED4' }, // San Antonio Spurs
    },
    wnba: {
        '20':     { abbr: 'ATL',  short: "Dream",            color: '#E31837', alt: '#5091CC' }, // Atlanta Dream
        '19':     { abbr: 'CHI',  short: "Sky",              color: '#5091CD', alt: '#FFD520' }, // Chicago Sky
        '18':     { abbr: 'CON',  short: "Sun",              color: '#F05023', alt: '#0A2240' }, // Connecticut Sun
        '5':      { abbr: 'IND',  short: "Fever",            color: '#002D62', alt: '#E03A3E' }, // Indiana Fever
        '9':      { abbr: 'NY',   short: "Liberty",          color: '#86CEBC', alt: '#000000' }, // New York Liberty
        '131935': { abbr: 'TOR',  short: "Tempo",            color: '#33476D', alt: '#7B1B38' }, // Toronto Tempo
        '16':     { abbr: 'WSH',  short: "Mystics",          color: '#E03A3E', alt: '#002B5C' }, // Washington Mystics
        '3':      { abbr: 'DAL',  short: "Wings",            color: '#002B5C', alt: '#C4D600' }, // Dallas Wings
        '129689': { abbr: 'GS',   short: "Valkyries",        color: '#B38FCF', alt: '#000000' }, // Golden State Valkyries
        '17':     { abbr: 'LV',   short: "Aces",             color: '#A7A8AA', alt: '#000000' }, // Las Vegas Aces
        '6':      { abbr: 'LA',   short: "Sparks",           color: '#552583', alt: '#FDB927' }, // Los Angeles Sparks
        '8':      { abbr: 'MIN',  short: "Lynx",             color: '#266092', alt: '#79BC43' }, // Minnesota Lynx
        '11':     { abbr: 'PHX',  short: "Mercury",          color: '#3C286E', alt: '#FA4B0A' }, // Phoenix Mercury
        '132052': { abbr: 'POR',  short: "Fire",             color: '#CEE5EB', alt: '#000000' }, // Portland Fire
        '14':     { abbr: 'SEA',  short: "Storm",            color: '#2C5235', alt: '#FEE11A' }, // Seattle Storm
    },
    gleague: {
        '4':      { abbr: 'CAP',  short: "Go-Go",            color: '#002B5C', alt: '#E31837' }, // Capital City Go-Go
        '3':      { abbr: 'CLC',  short: "Charge",           color: '#061642', alt: '#FDBB30' }, // Cleveland Charge
        '28':     { abbr: 'CPS',  short: "Skyhawks",         color: '#000000', alt: '#B3042A' }, // College Park Skyhawks
        '5':      { abbr: 'DEL',  short: "Blue Coats",       color: '#003DA6', alt: '#DD0031' }, // Delaware Blue Coats
        '8':      { abbr: 'GRD',  short: "Gold",             color: '#C8102E', alt: '#1D428A' }, // Grand Rapids Gold
        '9':      { abbr: 'GBO',  short: "Swarm",            color: '#007BBC', alt: '#1D1160' }, // Greensboro Swarm
        '6':      { abbr: 'LAK',  short: "Squadron",         color: '#002A5C', alt: '#B4975A' }, // Laketown Squadron
        '12':     { abbr: 'LIN',  short: "Nets",             color: '#006BB6', alt: '#ED174C' }, // Long Island Nets
        '13':     { abbr: 'MNE',  short: "Celtics",          color: '#006532', alt: '#F1F2F3' }, // Maine Celtics
        '15':     { abbr: 'MCC',  short: "Cruise",           color: '#FA002C', alt: '#006BB6' }, // Motor City Cruise
        '7':      { abbr: 'NOB',  short: "Boom",             color: '#002D62', alt: '#FDBB30' }, // Noblesville Boom
        '11':     { abbr: 'OSC',  short: "Magic",            color: '#000000', alt: '#0077C0' }, // Osceola Magic
        '17':     { abbr: 'RAP',  short: "905",              color: '#CE1141', alt: '#000000' }, // Raptors 905
        '25':     { abbr: 'WES',  short: "Knicks",           color: '#006BB6', alt: '#F58426' }, // Westchester Knicks
        '26':     { abbr: 'WCB',  short: "Bulls",            color: '#CE1141', alt: '#000000' }, // Windy City Bulls
        '27':     { abbr: 'WIS',  short: "Herd",             color: '#00471B', alt: '#EEE1C6' }, // Wisconsin Herd
        '2':      { abbr: 'AUS',  short: "Spurs",            color: '#000000', alt: '#C4CED4' }, // Austin Spurs
        '22':     { abbr: 'CVL',  short: "Lakers",           color: '#552583', alt: '#FDB927' }, // Coachella Valley Lakers
        '10':     { abbr: 'IWA',  short: "Wolves",           color: '#0C2340', alt: '#236192' }, // Iowa Wolves
        '14':     { abbr: 'MHU',  short: "Hustle",           color: '#E2231A', alt: '#717271' }, // Memphis Hustle
        '124612': { abbr: 'MXC',  short: "Capitanes",        color: '#3A4C98', alt: '#FFFFFF' }, // Mexico City Capitanes
        '16':     { abbr: 'OKL',  short: "Blue",             color: '#007AC1', alt: '#EF3B24' }, // Oklahoma City Blue
        '18':     { abbr: 'RGV',  short: "Vipers",           color: '#CE1141', alt: '#BEC0C2' }, // Rio Grande Valley Vipers
        '128019': { abbr: 'RCR',  short: "Remix",            color: '#E03A3E', alt: '#000000' }, // Rip City Remix
        '19':     { abbr: 'SLC',  short: "Stars",            color: '#002B5C', alt: '#F9A01B' }, // Salt Lake City Stars
        '1':      { abbr: 'SAN',  short: "Clippers",         color: '#C8102E', alt: '#1D428A' }, // San Diego Clippers
        '20':     { abbr: 'SCW',  short: "Warriors",         color: '#006BB6', alt: '#FDB927' }, // Santa Cruz Warriors
        '21':     { abbr: 'SXF',  short: "Skyforce",         color: '#000000', alt: '#98002E' }, // Sioux Falls Skyforce
        '23':     { abbr: 'STO',  short: "Kings",            color: '#5A2D81', alt: '#000000' }, // Stockton Kings
        '24':     { abbr: 'TEX',  short: "Legends",          color: '#0053BC', alt: '#00285E' }, // Texas Legends
        '129713': { abbr: 'VAL',  short: "Suns",             color: '#E56020', alt: '#1D1160' }, // Valley Suns
    },
};

const teamAbbr = (league, id, fallback) => TEAMS[league]?.[id]?.abbr  || fallback || '???';
const teamName = (league, id)           => TEAMS[league]?.[id]?.short || teamAbbr(league, id);

// Relative luminance (0 = black, 1 = white) of a #RRGGBB color.
function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 1;
    const n = parseInt(m[1], 16);
    const ch = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
}

// The flash and fireworks both sit on a black key, so a near-black primary
// (Nets, Spurs, several G League clubs) would flash invisibly — use the
// team's alternate color instead, and white if that's dark too.
function flashColor(league, id) {
    const t = TEAMS[league]?.[id];
    if (!t) return '#FFFFFF';
    if (luminance(t.color) >= 0.04) return t.color;
    if (t.alt && luminance(t.alt) >= 0.04) return t.alt;
    return '#FFFFFF';
}

// ── ESPN API ──────────────────────────────────────────────────────────────────
// ESPN's edge rejects requests that don't look like a real browser (a 403
// "Access Denied" HTML page), so send a realistic header set — same as the
// NFL/CFB plugins.
const ESPN_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br',
};

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: ESPN_HEADERS }, res => {
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    let buf = Buffer.concat(chunks);
                    const enc = res.headers['content-encoding'];
                    if (enc === 'gzip')         buf = zlib.gunzipSync(buf);
                    else if (enc === 'br')      buf = zlib.brotliDecompressSync(buf);
                    else if (enc === 'deflate') buf = zlib.inflateSync(buf);
                    resolve(JSON.parse(buf.toString('utf8')));
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timed out')); });
    });
}

// "Today" as ESPN's YYYYMMDD, with a 2am local rollover so a late West Coast
// game (or a final) stays on the key past midnight. Uses local system time,
// same assumption as the other plugins.
function nowDate() {
    return DEBUG_ANCHOR_DATE ? new Date(DEBUG_ANCHOR_DATE + 'T12:00:00') : new Date();
}
function scoreboardDateStr() {
    const d = nowDate();
    if (!DEBUG_ANCHOR_DATE && d.getHours() < 2) d.setDate(d.getDate() - 1);
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

// One scoreboard request per league per ~20s, shared by every key — ten
// keys on NBA teams cost the same one request as a single key.
const SCOREBOARD_TTL_MS = 20_000;
const scoreboardCache   = {}; // league -> { date, fetchedAt, promise }

function fetchScoreboard(league) {
    const date   = scoreboardDateStr();
    const cached = scoreboardCache[league];
    if (cached && cached.date === date && Date.now() - cached.fetchedAt < SCOREBOARD_TTL_MS) return cached.promise;

    const url     = ESPN_BASE + leagueConf(league).api + '/scoreboard?dates=' + date + '&limit=100';
    const promise = fetchJson(url);
    scoreboardCache[league] = { date, fetchedAt: Date.now(), promise };
    promise.catch(() => { if (scoreboardCache[league]?.promise === promise) delete scoreboardCache[league]; });
    return promise;
}

async function fetchTeamGame(league, teamId) {
    const debugKey = league + ':' + teamId;
    if (Object.prototype.hasOwnProperty.call(DEBUG_FAKE_GAMES, debugKey)) return DEBUG_FAKE_GAMES[debugKey];

    const data  = await fetchScoreboard(league);
    const event = (data?.events || []).find(e =>
        e.competitions?.[0]?.competitors?.some(c => String(c.team?.id) === String(teamId)));

    if (event) return parseEvent(event, league);

    // Off day — show the next scheduled game instead of a dead-end "No Game".
    log(league.toUpperCase(), 'no game today for', teamId, '— looking up next game');
    try { return await fetchNextGame(league, teamId); }
    catch (e) { log('Next-game lookup failed:', e.message); return null; }
}

function parseEvent(e, league) {
    const comp   = e.competitions[0];
    const status = comp.status || e.status || {};
    const type   = status.type || {};
    const state  = type.state;        // 'pre' | 'in' | 'post'
    const name   = type.name || '';   // STATUS_SCHEDULED, STATUS_IN_PROGRESS, STATUS_HALFTIME, STATUS_END_PERIOD, STATUS_FINAL...

    const away     = comp.competitors.find(c => c.homeAway === 'away');
    const home     = comp.competitors.find(c => c.homeAway === 'home');
    const awayId   = String(away?.team?.id || ''), homeId = String(home?.team?.id || '');
    const awayAbbr = teamAbbr(league, awayId, away?.team?.abbreviation);
    const homeAbbr = teamAbbr(league, homeId, home?.team?.abbreviation);
    const matchup  = awayAbbr + ' @ ' + homeAbbr;

    const gcLink = (e.links || []).find(l => (l.text || '').toLowerCase() === 'gamecast') || (e.links || [])[0];
    const link   = gcLink?.href || `https://www.espn.com/${leagueConf(league).web}/game/_/gameId/${e.id}`;

    const base = { matchup, awayId, homeId, awayAbbr, homeAbbr, eventId: e.id, link };

    if (name.includes('POSTPONED') || name.includes('CANCEL') || name.includes('SUSPENDED')) return { ...base, state: 'ppd' };
    if (/DELAY/.test(name)) return { ...base, state: 'delay' };

    if (state === 'pre') {
        const timeValid = comp.timeValid !== false && e.timeValid !== false;
        return { ...base, state: 'preview', time: timeValid ? fmtTime(e.date) : 'TBD' };
    }

    const awayScore = parseInt(away?.score, 10) || 0;
    const homeScore = parseInt(home?.score, 10) || 0;
    const period    = status.period || 1;

    if (state === 'post') return { ...base, state: 'final', awayScore, homeScore, period };

    return {
        ...base,
        state: 'live',
        awayScore, homeScore, period,
        clock:      status.displayClock || '',
        statusName: name,
    };
}

// ── Next scheduled game ───────────────────────────────────────────────────────
// ESPN's team-schedule endpoint only returns one season type at a time
// (preseason, regular season, postseason...), defaulting to whichever is
// current. So: check the default first, then the regular season and the
// postseason, and take the earliest game that hasn't started yet. Cached per
// team for an hour — schedules rarely change, and this only runs on off days.
const NEXT_GAME_TTL_MS = 60 * 60 * 1000;
const nextGameCache    = {}; // '<league>:<teamId>' -> { fetchedAt, promise }

// A cached result whose game has already tipped off is stale (e.g. last
// night's game, cached before it started) — drop it and look again.
async function fetchNextGame(league, teamId) {
    const key    = league + ':' + teamId;
    const cached = nextGameCache[key];
    if (cached && Date.now() - cached.fetchedAt < NEXT_GAME_TTL_MS) {
        const g = await cached.promise;
        if (!g || g.startMs > Date.now()) return g;
        delete nextGameCache[key];
    }

    const promise = findNextGame(league, teamId);
    nextGameCache[key] = { fetchedAt: Date.now(), promise };
    promise.catch(() => { if (nextGameCache[key]?.promise === promise) delete nextGameCache[key]; });
    return promise;
}

async function findNextGame(league, teamId) {
    const base = ESPN_BASE + leagueConf(league).api + '/teams/' + teamId + '/schedule';
    const now  = Date.now();

    const pickUpcoming = data => (data?.events || [])
        .filter(e => {
            const st = (e.competitions?.[0]?.status || e.status)?.type?.state;
            return st === 'pre' && new Date(e.date).getTime() > now;
        })
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0] || null;

    let next = null;
    for (const suffix of ['', '?seasontype=2', '?seasontype=3']) {
        try {
            const candidate = pickUpcoming(await fetchJson(base + suffix));
            if (candidate && (!next || new Date(candidate.date) < new Date(next.date))) next = candidate;
        } catch (e) { log('Schedule fetch failed (' + (suffix || 'default') + '):', e.message); }
        if (next) break; // the default (current season type) is always the soonest when it has one
    }
    if (!next) { log(league.toUpperCase(), 'no upcoming games for', teamId); return null; }

    const game = parseEvent(next, league);
    const d    = new Date(next.date);
    return {
        ...game,
        state:     'nextgame',
        startMs:   d.getTime(),
        dateLabel: d.toLocaleDateString([], { month: 'numeric', day: 'numeric' }),
        time:      game.time === 'TBD' ? 'TBD' : fmtTime(next.date),
    };
}

// ── Live team lists (for the property inspector's search/browse UI) ───────────
// The property inspector ships a static team list for instant first paint;
// this refreshes it from ESPN (team list + conference/division) so expansion
// teams, relocations, and G League changes show up without a plugin update.
const TEAM_LIST_CACHE = {}; // league -> { fetchedAt, teams: [{ value, abbr, name, division }] }
const TEAM_LIST_TTL   = 24 * 60 * 60 * 1000;

async function getLiveTeamList(league) {
    const cached = TEAM_LIST_CACHE[league];
    if (cached && Date.now() - cached.fetchedAt < TEAM_LIST_TTL) return cached.teams;
    try {
        const teams = await fetchTeamList(league);
        if (teams && teams.length) {
            TEAM_LIST_CACHE[league] = { fetchedAt: Date.now(), teams };
            return teams;
        }
        throw new Error('empty team list');
    } catch (e) {
        log('getLiveTeamList(' + league + ') failed, ' + (cached ? 'serving stale cache' : 'no cache available') + ':', e.message);
        return cached ? cached.teams : null;
    }
}

async function fetchTeamList(league) {
    const api    = leagueConf(league).api;
    const groups = {}; // teamId -> division/conference name

    if (league === 'nba') {
        // NBA browses by division, which ESPN's /groups endpoint has.
        const data = await fetchJson(ESPN_BASE + 'nba/groups');
        for (const conf of data?.groups || [])
            for (const div of conf.children || [])
                for (const t of div.teams || []) groups[String(t.id)] = div.name;
    } else {
        // WNBA and G League have no divisions (and /groups comes back empty for
        // them) — browse by conference, taken from the standings. Standings also
        // list only active clubs, which filters out ESPN's defunct G League
        // entries (Ignite, etc.) that the /teams endpoint still returns.
        const data = await fetchJson('https://site.api.espn.com/apis/v2/sports/basketball/' + api + '/standings');
        for (const conf of data?.children || [])
            for (const entry of conf.standings?.entries || [])
                groups[String(entry.team.id)] = conf.name.replace(/ Conference$/, '');
    }

    const data  = await fetchJson(ESPN_BASE + api + '/teams?limit=100');
    const teams = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map(x => x.team);
    return teams
        .filter(t => groups[String(t.id)])
        .map(t => ({
            value:    String(t.id),
            abbr:     teamAbbr(league, String(t.id), t.abbreviation),
            name:     t.displayName,
            division: groups[String(t.id)],
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

async function sendLiveTeams(context) {
    const leagues = Object.keys(LEAGUES);
    const lists   = await Promise.all(leagues.map(l =>
        getLiveTeamList(l).catch(e => { log(l + ' team list error:', e.message); return null; })));

    const teams = {};
    leagues.forEach((l, i) => { if (lists[i]) teams[l] = lists[i]; });
    if (!Object.keys(teams).length) { log('sendLiveTeams: all leagues failed, PI keeps its static fallback'); return; }

    log('Sending live team data to PI:', Object.keys(teams).map(l => l + '=' + teams[l].length).join(', '));
    ws.send(JSON.stringify({ event: 'sendToPropertyInspector', context, payload: { event: 'teamsData', teams } }));
}

function fmtTime(iso) {
    try { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return '?:??'; }
}

// ── SVG button renderer ───────────────────────────────────────────────────────
function escXml(s) {
    return String(s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

// Turns a user-chosen hex color + opacity (0-100) into a fill/opacity pair for
// the SVG <rect>. Plain black if no custom background is set. Only applied to
// the steady-state key — the lead-change flash and fireworks use their own
// colors on top of it.
function resolveBgColor(cfg) {
    if (!cfg || !cfg.bgColor) return { fill: 'black', opacity: 1 };
    const hex = String(cfg.bgColor).replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) return { fill: 'black', opacity: 1 };
    const opacityPct = cfg.bgOpacity != null ? Number(cfg.bgOpacity) : 100;
    const opacity    = Math.max(0, Math.min(100, isNaN(opacityPct) ? 100 : opacityPct)) / 100;
    return { fill: '#' + hex, opacity };
}

// Accepts an array of strings (auto-sized) or { text, fs, color } objects (explicit size).
function makeImage(lines, lineSpacing = 1.4, bgColor = 'black', bgOpacity = 1) {
    const W = 72, H = 72, PAD = 4, MAX_W = W - PAD * 2;

    const items = lines.map(l => {
        if (typeof l === 'string') {
            let fs = 16;
            while (fs > 8 && l.length * fs * 0.60 > MAX_W) fs--;
            return { text: l, fs };
        }
        return l;
    });

    const lineHeights = items.map(({ fs }) => fs * lineSpacing);
    const totalH      = lineHeights.reduce((a, b) => a + b, 0);
    let   y           = (H - totalH) / 2 + items[0].fs * 0.80;

    const rows = items.map(({ text, fs, color }, i) => {
        if (i > 0) y += lineHeights[i - 1] - items[i - 1].fs * 0.80 + fs * 0.80;
        return `<text x="36" y="${y.toFixed(1)}" text-anchor="middle" fill="${color || 'white'}" ` +
               `font-family="Helvetica Neue,Arial,sans-serif" font-size="${fs}" font-weight="600">${escXml(text)}</text>`;
    }).join('');

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="144" height="144" overflow="hidden">` +
        `<rect width="${W}" height="${H}" fill="${bgColor}" fill-opacity="${bgOpacity}"/>` +
        rows + `</svg>`;

    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function makeFireworks(frame, winnerColor, winnerName) {
    const W = 72, H = 72;
    const cx = 36, cy = 36;
    const COLORS = [winnerColor, '#FFD700', '#FFFFFF'];

    let circles = '';
    [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].forEach((startFrame, burstIdx) => {
        const f = frame - startFrame;
        if (f < 0 || f >= 6) return;
        const progress = f / 5;
        const r        = 5 + progress * 28;
        const pSize    = Math.max(0.5, 3.5 - progress * 2.5);
        const opacity  = (1 - progress * 0.65).toFixed(2);
        for (let i = 0; i < 8; i++) {
            const angle = (i * 45 + burstIdx * 22.5) * Math.PI / 180;
            const px    = (cx + r * Math.cos(angle)).toFixed(1);
            const py    = (cy + r * Math.sin(angle)).toFixed(1);
            const color = COLORS[(i + burstIdx) % COLORS.length];
            circles += `<circle cx="${px}" cy="${py}" r="${pSize.toFixed(1)}" fill="${color}" opacity="${opacity}"/>`;
        }
    });

    const throb   = Math.floor(frame / 2) % 2 === 0;
    const winSize = throb ? 20 : 16;
    let nameSize  = 13;
    while (nameSize > 7 && winnerName.length * nameSize * 0.62 > 62) nameSize--;
    const nameY = throb ? 25 : 27;

    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="144" height="144" overflow="hidden">` +
        `<rect width="${W}" height="${H}" fill="black"/>` +
        circles +
        `<text x="36" y="${nameY}" text-anchor="middle" fill="white" ` +
        `font-family="Helvetica Neue,Arial,sans-serif" font-size="${nameSize}" font-weight="700">${escXml(winnerName)}</text>` +
        `<text x="36" y="50" text-anchor="middle" fill="#FFD700" ` +
        `font-family="Helvetica Neue,Arial,sans-serif" font-size="${winSize}" font-weight="800">WIN!</text>` +
        `</svg>`;

    return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

async function playFireworks(context, winnerName, winnerColor) {
    if (flashing.has(context)) return;
    flashing.add(context);
    log('→ fireworks for', winnerName, winnerColor);
    try {
        for (let i = 0; i < 42; i++) {
            const img = makeFireworks(i, winnerColor, winnerName);
            ws.send(JSON.stringify({ event: 'setImage', context, payload: { image: img, target: 0 } }));
            await sleep(120);
        }
    } finally {
        flashing.delete(context);
        lastRender.delete(context);
        refreshButton(context);
    }
}

// bgColor may be a plain CSS color string (flash colors, 'black') or a
// { fill, opacity } object (resolveBgColor's output).
function setButton(context, lines, lineSpacing, bgColor, force) {
    const bg  = (bgColor && typeof bgColor === 'object') ? bgColor : { fill: bgColor || 'black', opacity: 1 };
    const key = JSON.stringify({ lines, bg });
    if (!force) {
        if (lastRender.get(context) === key) return; // skip if unchanged
        lastRender.set(context, key);
    }
    ws.send(JSON.stringify({ event: 'setImage', context, payload: { image: makeImage(lines, lineSpacing, bg.fill, bg.opacity), target: 0 } }));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function flashButton(context, color, lines, spacing, restColor = 'black') {
    if (flashing.has(context)) return;
    flashing.add(context);
    log('→ flash', color);
    try {
        for (let i = 0; i < 4; i++) {
            setButton(context, lines, spacing, color, true);
            await sleep(200);
            setButton(context, lines, spacing, restColor, true);
            await sleep(200);
        }
    } finally {
        flashing.delete(context);
        lastRender.delete(context);
        setButton(context, lines, spacing, restColor);
    }
}
