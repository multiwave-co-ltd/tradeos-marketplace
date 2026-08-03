// TradeOS MCP Proxy — stdio ↔ Streamable HTTP (no OAuth)
// Node.js built-ins only. No npm dependencies required.
// Usage: node index.js [<USERNAME> <PASSWORD>] | --setup
//
// 🔴 This file is DERIVED from mcpb/tradeos-mcp-client/server/index.js in the
// atras-j-jdk21 repo. The multiplexer logic must stay byte-identical between the
// two; only the credential resolution and the --setup flow below differ. There is
// no sync script, so re-derive rather than hand-editing when the .mcpb changes.
//
// Phase C (multiplexer): fronts TWO upstreams behind a single stdio server —
// BD (backtest, bd01) and RT (realtrade read-only, rt01). A .mcpb package is
// one process with one `server.command`, so "register two servers" is not
// expressible; multiplexing has to live here. See design spec §5.2 and
// docs/proposals/tradeos-mcpb-rt-multiplexer-spec.md.
//
// Routing (spec §4.3):
//   initialize / notifications/initialized  -> BD only (BD is primary; the
//                                              handshake is cached and replayed
//                                              to RT on first RT use)
//   tools/list                              -> fan out to BD + RT, merge
//   tools/call with a name starting "rt_"   -> RT
//   everything else                         -> BD (fail-safe default)
//
// Upstream URLs are compile-time constants (D3) so end users manage exactly one
// credential set. The password is used ONLY to mint scoped API keys over HTTPS;
// it is never written to disk, never logged, and never attached to an MCP
// request.
//
// 🔴 The key minted for RT carries scope='rt', which under the single-scope ADR
// is the ONE RT scope covering read + all mutation. Today it is read-only purely
// because the deployed WAR exposes only read tools. See spec §1.1 / §7.2 for the
// release procedure that must accompany the mutation WAR.

import { createInterface } from 'node:readline';
import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  chmodSync,
} from 'node:fs';

import { RT_TOOLS_FALLBACK, RT_TOOL_PREFIX } from './rt-tools.js';

// ── Credential resolution: argv > plugin-option env > plain env ───────────
// (Claude Code plugin variant. The .mcpb variant takes argv only.)
const rawArgs = process.argv.slice(2);
const SETUP_MODE = rawArgs.includes('--setup');
const positional = rawArgs.filter((a) => !a.startsWith('-'));
const USERNAME = positional[0]
  || process.env.CLAUDE_PLUGIN_OPTION_TRADEOS_USERNAME
  || process.env.TRADEOS_USERNAME
  || '';
const PASSWORD = positional[1]
  || process.env.CLAUDE_PLUGIN_OPTION_TRADEOS_PASSWORD
  || process.env.TRADEOS_PASSWORD
  || '';

// --- F7: TLS certificate verification -------------------------------------
// The bootstrap requests carry the PASSWORD, so an unverified TLS connection
// would let a network MITM present a rogue certificate and steal the
// credentials. Verify server certificates by DEFAULT.
const ALLOW_SELF_SIGNED = process.env.TRADEOS_ALLOW_SELF_SIGNED === 'true';
const REJECT_UNAUTHORIZED = !ALLOW_SELF_SIGNED;
if (ALLOW_SELF_SIGNED) {
  process.stderr.write('[tradeos-mcp-proxy] WARNING: TLS certificate verification is DISABLED '
    + '(TRADEOS_ALLOW_SELF_SIGNED=true). Your password could be intercepted on an untrusted '
    + 'network. Use only against a trusted dev server.\n');
}

const CACHE_DIR = join(homedir(), '.tradeos');

// --- Upstreams -------------------------------------------------------------
// Everything that used to be a module-scope singleton (url / apiKey / sessionId
// / in-flight promises) now lives per upstream. Getting this wrong is not a
// cosmetic bug: if the cache helpers kept closing over one shared CACHE_FILE, a
// 401 from RT would delete the *BD* key and take backtesting down with it.

const UPSTREAMS = {
  bd: {
    id: 'bd',
    label: 'BD',
    mcpUrl: 'https://bd01.atrasweb.com/atras.product.atrasbtmcp/mcp',
    keyUrl: 'https://bd01.atrasweb.com/atras.product.atrasbtweb/Services/GenerateProductApiKey',
    keyBody: () => ({ username: USERNAME, password: PASSWORD }),
    cacheFile: join(CACHE_DIR, 'apikey'),
    connectMs: 10_000,
    totalMs: 120_000,   // BD tools can legitimately take minutes-ish; see spec §4.4
  },
  rt: {
    id: 'rt',
    label: 'RT',
    mcpUrl: 'https://rt01.atrasweb.com/atras.product.atrasrtmcp/mcp',
    keyUrl: 'https://rt01.atrasweb.com/atras.product.atrasweb/Services/GenerateRtApiKey',
    // 🔴 label is version-independent on purpose: the release-time allowlist in
    // spec §7.2 stays a single constant instead of forking per client version.
    // Generation gating is done by rotating the `tier` value, not the label.
    keyBody: () => ({ username: USERNAME, password: PASSWORD, tier: 'rt-full', label: 'TradeOS client' }),
    cacheFile: join(CACHE_DIR, 'rt-apikey'),
    connectMs: 10_000,
    totalMs: 30_000,
  },
};

for (const up of Object.values(UPSTREAMS)) {
  const u = new URL(up.mcpUrl);
  up.url = u;
  up.isHttps = u.protocol === 'https:';
  up.doRequest = up.isHttps ? httpsReq : httpReq;
  up.apiKey = null;
  up.sessionId = null;
  up.issuingPromise = null;
  up.reinitPromise = null;
  up.initPromise = null;
  up.initialized = false;
  up.keyIssue = { failed: false, kind: null };
}

// The client's own handshake. NOT per-upstream: `initialize` is routed to BD
// only, and this cached copy is what gets replayed to RT. Storing it per
// upstream would leave rt.lastInitialize permanently null and make RT init
// impossible.
const SHARED = { lastInitialize: null, lastInitialized: null };

const FAN_OUT_DEADLINE_MS = 8_000;   // tools/list RT leg (warm path; see ensureRtInit eager start)

// --- Local API key cache ---------------------------------------------------

function readCachedKey(up) {
  try {
    const key = readFileSync(up.cacheFile, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

function writeCachedKey(up, key) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(up.cacheFile, key, { mode: 0o600 });
    // writeFileSync's mode can be widened by umask on some platforms —
    // enforce the restrictive permissions explicitly.
    chmodSync(up.cacheFile, 0o600);
    chmodSync(CACHE_DIR, 0o700);
  } catch (err) {
    process.stderr.write(`[tradeos-mcp-proxy] Warning: failed to cache ${up.label} API key locally: ${err.message}\n`);
  }
}

function clearCachedKey(up) {
  try {
    unlinkSync(up.cacheFile);
  } catch {
    // Nothing to clear — ignore.
  }
}

// --- rtGate: is it OK to (re)mint an RT key, and how do we explain failures --
//
// The server-side issuance endpoint locks a username out after 5 failed
// attempts in 15 minutes. A BT-only user (no RT01 account, or a different RT01
// password) fails EVERY time, so without a cross-process memory we would burn
// one attempt per Claude Desktop start and lock them out during a single
// troubleshooting session. An in-process flag is not enough for that — hence
// the file.

const BACKOFF_FILE = join(CACHE_DIR, 'rt-keyissue-backoff');
const BACKOFF_MS = 16 * 60 * 1000;   // > the server's 15-minute lockout window

function readBackoffUntil() {
  try {
    const at = Number(readFileSync(BACKOFF_FILE, 'utf8').trim());
    return Number.isFinite(at) ? at : 0;
  } catch {
    return 0;   // unreadable/missing => no backoff. Never block on bookkeeping.
  }
}

function writeBackoff() {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(BACKOFF_FILE, String(Date.now()), { mode: 0o600 });
    chmodSync(BACKOFF_FILE, 0o600);
  } catch {
    // Best-effort only.
  }
}

function clearBackoff() {
  try {
    unlinkSync(BACKOFF_FILE);
  } catch {
    // Nothing to clear.
  }
}

const rtGate = {
  // Only authoritative server rejections (401/429/...) are remembered.
  // Transport hiccups must NOT put RT to sleep for 16 minutes.
  shouldAttemptIssue(up) {
    if (up.id !== 'rt') return true;
    // KEY_AUTH  : wrong/absent RT credentials — the server will keep saying no,
    //             and five of those inside 15 minutes locks the account out.
    //             Remembered across processes (see BACKOFF_FILE).
    // KEY_BAD_TIER: this client build is older than the server contract. Also
    //             deterministic, but harmless to the account (the tier check
    //             runs before authentication, so it costs no lockout budget) —
    //             so it is only remembered for this process, and the tools stay
    //             advertised via the static bundle either way.
    if (up.keyIssue.failed) return false;
    return Date.now() - readBackoffUntil() >= BACKOFF_MS;
  },
  noteFailure(up, kind) {
    if (up.id !== 'rt') return;
    // A transport blip must not put RT to sleep — only authoritative refusals
    // are worth remembering.
    if (kind !== 'KEY_AUTH' && kind !== 'KEY_BAD_TIER') return;
    up.keyIssue = { failed: true, kind };
    if (kind === 'KEY_AUTH') writeBackoff();
  },
  noteSuccess(up) {
    if (up.id !== 'rt') return;
    up.keyIssue = { failed: false, kind: null };
    clearBackoff();
  },
  // What the user sees when an RT tool cannot run. The cause matters: telling
  // someone to buy a plan when the real problem is a stale client (or vice
  // versa) sends them down the wrong path.
  userMessage(kind) {
    switch (kind) {
      case 'KEY_BAD_TIER':
        return 'TradeOS クライアントの更新が必要です。最新版をインストールしてください。';
      case 'MCP_DENIED':
        return 'リアルトレード機能のご利用には対応プランのご契約が必要です。';
      default:
        return 'リアルトレード情報の取得に失敗しました。しばらくしてから再度お試しください。';
    }
  },
};

class UpstreamError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// --- Key issuance ----------------------------------------------------------

function issueApiKey(up) {
  const issueUrl = new URL(up.keyUrl);
  const issueIsHttps = issueUrl.protocol === 'https:';
  const issueDoRequest = issueIsHttps ? httpsReq : httpReq;
  const body = JSON.stringify(up.keyBody());

  return new Promise((resolve, reject) => {
    const req = issueDoRequest(
      {
        hostname: issueUrl.hostname,
        port: issueUrl.port || (issueIsHttps ? 443 : 80),
        path: issueUrl.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
        rejectUnauthorized: REJECT_UNAUTHORIZED,
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            // 403 from this endpoint means the server refused our `tier` value,
            // i.e. THIS CLIENT IS OUT OF DATE — a completely different problem
            // from bad credentials, and it must not be reported as one.
            const kind = res.statusCode === 403 ? 'KEY_BAD_TIER' : 'KEY_AUTH';
            reject(new UpstreamError(kind,
              `${up.label} key issuance failed (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.api_key) {
              reject(new UpstreamError('KEY_AUTH', `${up.label} key issuance response missing api_key`));
              return;
            }
            resolve(parsed.api_key);
          } catch (err) {
            reject(new UpstreamError('KEY_AUTH',
              `${up.label} key issuance response was not valid JSON: ${err.message}`));
          }
        });
        res.on('error', (e) => reject(new UpstreamError('TRANSPORT', e.message)));
      },
    );
    req.setTimeout(up.connectMs);
    req.on('timeout', () => req.destroy(new UpstreamError('TRANSPORT', `${up.label} key issuance timed out`)));
    req.on('error', (err) => reject(err instanceof UpstreamError
      ? err
      : new UpstreamError('TRANSPORT', `${up.label} key issuance HTTP error: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

async function ensureApiKey(up) {
  if (up.apiKey) return up.apiKey;
  if (!rtGate.shouldAttemptIssue(up)) {
    throw new UpstreamError(up.keyIssue.kind || 'KEY_AUTH',
      `${up.label} key issuance suppressed (recent authoritative failure)`);
  }
  if (!up.issuingPromise) {
    up.issuingPromise = (async () => {
      process.stderr.write(`[tradeos-mcp-proxy] No cached ${up.label} API key — requesting one from server...\n`);
      try {
        const key = await issueApiKey(up);
        writeCachedKey(up, key);
        up.apiKey = key;
        rtGate.noteSuccess(up);
        process.stderr.write(`[tradeos-mcp-proxy] ${up.label} API key issued and cached locally (${up.cacheFile}).\n`);
        return key;
      } catch (err) {
        const kind = err instanceof UpstreamError ? err.kind : 'TRANSPORT';
        rtGate.noteFailure(up, kind);
        process.stderr.write(`[tradeos-mcp-proxy] ${up.label} key issuance failed [${kind}]: ${err.message}\n`);
        throw err;
      }
    })().finally(() => {
      up.issuingPromise = null;
    });
  }
  return up.issuingPromise;
}

// --- Session recovery ------------------------------------------------------

function rememberHandshake(msg) {
  if (msg && msg.method === 'initialize') SHARED.lastInitialize = msg;
  else if (msg && msg.method === 'notifications/initialized') SHARED.lastInitialized = msg;
}

function reinitSession(up) {
  if (up.reinitPromise) return up.reinitPromise;
  up.reinitPromise = (async () => {
    up.sessionId = null;
    if (!SHARED.lastInitialize) throw new Error('cannot re-initialize: no cached initialize request');
    await sendTo(up, SHARED.lastInitialize, { sessionRetry: true, internal: true });
    if (SHARED.lastInitialized) await sendTo(up, SHARED.lastInitialized, { sessionRetry: true, internal: true });
  })().finally(() => { up.reinitPromise = null; });
  return up.reinitPromise;
}

// Bring a secondary upstream (RT) to a usable state: mint a key if needed, then
// replay the client's handshake so the server hands us a session. Single-flight
// because Claude routinely fires several rt_* calls in one turn, and two
// concurrent `initialize` calls would leave us holding a session that never got
// its `notifications/initialized`.
function ensureRtInit(up) {
  if (up.initialized) return Promise.resolve();
  if (up.initPromise) return up.initPromise;
  up.initPromise = (async () => {
    await ensureApiKey(up);
    if (!SHARED.lastInitialize) throw new UpstreamError('TRANSPORT', 'no cached initialize to replay');
    await sendTo(up, SHARED.lastInitialize, { sessionRetry: true, internal: true });
    if (SHARED.lastInitialized) await sendTo(up, SHARED.lastInitialized, { sessionRetry: true, internal: true });
    up.initialized = true;
  })().finally(() => { up.initPromise = null; });
  return up.initPromise;
}

// --- Transport -------------------------------------------------------------
//
// Returns what came back rather than writing to stdout, because tools/list has
// to merge two responses into one. `status` alone is not enough to explain a
// failure: a 403 from the MCP endpoint (entitlement) and a 403 from the key
// endpoint (stale client) need opposite advice, so the classification travels
// alongside as `failure.kind`.

function sendTo(up, msg, opts = {}) {
  const { isRetry = false, sessionRetry = false, internal = false } = opts;

  return (async () => {
    // Wait out an in-flight re-init so this request uses the fresh session id.
    // The re-init's own replays pass internal/sessionRetry and must not wait on
    // themselves — that would be a deadlock, not a delay.
    if (!internal && !sessionRetry) {
      if (up.reinitPromise) await up.reinitPromise.catch(() => {});
      if (up.initPromise) await up.initPromise.catch(() => {});
    }

    let key;
    try {
      key = await ensureApiKey(up);
    } catch (err) {
      const kind = err instanceof UpstreamError ? err.kind : 'TRANSPORT';
      return { status: 0, messages: [], failure: { kind, detail: err.message } };
    }

    const body = JSON.stringify(msg);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${key}`,
      Accept: 'application/json, text/event-stream',
    };
    if (up.sessionId) headers['Mcp-Session-Id'] = up.sessionId;

    let abortRequest = () => {};
    const attempt = new Promise((resolve) => {
      const opt = {
        hostname: up.url.hostname,
        port: up.url.port || (up.isHttps ? 443 : 80),
        path: up.url.pathname,
        method: 'POST',
        headers,
        rejectUnauthorized: REJECT_UNAUTHORIZED,
      };

      const req = up.doRequest(opt, (res) => {
        if (res.headers['mcp-session-id']) up.sessionId = res.headers['mcp-session-id'];

        // A 401 means the cached key was rotated or revoked. Re-mint once —
        // but only if rtGate still allows it, otherwise a user whose RT
        // credentials simply don't work would spend their whole lockout budget
        // retrying inside a single session.
        if (res.statusCode === 401 && !isRetry) {
          res.resume();
          process.stderr.write(`[tradeos-mcp-proxy] Got 401 from ${up.label} — cached key stale, re-issuing...\n`);
          clearCachedKey(up);
          up.apiKey = null;
          if (!rtGate.shouldAttemptIssue(up)) {
            resolve({ status: 401, messages: [], failure: { kind: up.keyIssue.kind || 'KEY_AUTH', detail: 'reissue suppressed' } });
            return;
          }
          sendTo(up, msg, { ...opts, isRetry: true }).then(resolve);
          return;
        }

        // A 404 on a request that carried a session id means the upstream
        // session expired. Re-initialize once and replay.
        if (res.statusCode === 404 && up.sessionId && !sessionRetry) {
          res.resume();
          process.stderr.write(`[tradeos-mcp-proxy] Got 404 from ${up.label} (session expired) — re-initializing...\n`);
          reinitSession(up)
            .then(() => sendTo(up, msg, { ...opts, sessionRetry: true }))
            .then(resolve)
            .catch((e) => resolve({ status: 404, messages: [], failure: { kind: 'TRANSPORT', detail: e.message } }));
          return;
        }

        const status = res.statusCode;
        const ct = res.headers['content-type'] || '';
        const messages = [];

        // Anything that is not a 2xx is a refusal, and its body is NOT
        // JSON-RPC — forwarding it verbatim would hand the client a message
        // with no `id`, leaving the original request waiting forever.
        if (status >= 400) {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            const kind = status === 403 ? 'MCP_DENIED' : 'TRANSPORT';
            resolve({ status, messages, failure: { kind, detail: raw.slice(0, 200) } });
          });
          res.on('error', () => resolve({ status, messages, failure: { kind: 'TRANSPORT', detail: 'response error' } }));
          return;
        }

        if (status === 202 || status === 204) {
          res.resume();
          resolve({ status, messages });
          return;
        }

        if (ct.includes('text/event-stream')) {
          let buf = '';
          res.on('data', (chunk) => {
            buf += chunk.toString();
            let nl;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl).replace(/\r$/, '');
              buf = buf.slice(nl + 1);
              if (line.startsWith('data: ')) {
                const d = line.slice(6).trim();
                if (d && d !== '[DONE]') {
                  try { messages.push(JSON.parse(d)); } catch { /* ignore malformed SSE data */ }
                }
              }
            }
          });
          // Hand back whatever arrived before the stream broke; discarding it
          // would strand the client on a request that had already been answered.
          res.on('end', () => resolve({ status, messages }));
          res.on('error', (e) => resolve({ status, messages, error: e.message }));
        } else {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            if (raw.trim()) {
              try {
                messages.push(JSON.parse(raw));
              } catch {
                process.stderr.write(`[tradeos-mcp-proxy] Non-JSON response from ${up.label} (${status}): ${raw.slice(0, 200)}\n`);
              }
            }
            resolve({ status, messages });
          });
          res.on('error', (e) => resolve({ status, messages, error: e.message }));
        }
      });

      abortRequest = () => req.destroy(new Error('deadline exceeded'));

      // `setTimeout` here is a socket IDLE timer, so it has to be cleared the
      // moment the connection is up. Leaving it armed would cut off a healthy
      // but slow response — and this server sends nothing at all until the tool
      // finishes, so "idle" and "still working" look identical on the wire.
      req.setTimeout(up.connectMs);
      req.on('timeout', () => req.destroy(new Error(`${up.label} connect timeout`)));
      req.on('socket', (sock) => {
        const clear = () => req.setTimeout(0);
        if (sock.connecting) sock.once(up.isHttps ? 'secureConnect' : 'connect', clear);
        else clear();
      });

      req.on('error', (err) => {
        resolve({ status: 0, messages: [], failure: { kind: 'TRANSPORT', detail: err.message } });
      });

      req.write(body);
      req.end();
    });

    // Promise.race does not cancel the loser, so the socket is torn down
    // explicitly — otherwise a stalled upstream would hold it until the OS
    // gives up.
    let timer;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        abortRequest();
        resolve({ status: 0, messages: [], failure: { kind: 'TRANSPORT', detail: `${up.label} deadline ${up.totalMs}ms exceeded` } });
      }, opts.deadlineMs || up.totalMs);
    });

    try {
      return await Promise.race([attempt, deadline]);
    } finally {
      clearTimeout(timer);
    }
  })();
}

// --- stdout ----------------------------------------------------------------

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function emitAll(messages) {
  for (const m of messages) emit(m);
}

// --- Handlers --------------------------------------------------------------

// tools/list has to look like ONE server to the client, so both legs are asked
// and their tool arrays concatenated.
//
// The asymmetry between the two legs is deliberate: BD is the primary product,
// so an RT problem must never cost the user their backtesting tools. But
// "drop RT on any failure" is too blunt — if RT refuses us with a 403 we still
// advertise the tools (from the static bundle) so that calling one produces an
// explanation instead of the feature silently not existing.
async function handleToolsList(msg) {
  const bdRes = await sendTo(UPSTREAMS.bd, msg);
  const bdReply = bdRes.messages.find((m) => m && m.id === msg.id && m.result);

  if (!bdReply) {
    // BD is primary: surface its failure rather than papering over it.
    if (bdRes.messages.length) { emitAll(bdRes.messages); return; }
    emit({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32603, message: `バックテストサーバーへの接続に失敗しました (${bdRes.failure?.detail || 'unknown'})` },
    });
    return;
  }

  const bdTools = bdReply.result.tools || [];
  let rtTools = [];

  try {
    const rt = UPSTREAMS.rt;
    await ensureRtInit(rt);
    const rtRes = await sendTo(rt, msg, { deadlineMs: FAN_OUT_DEADLINE_MS });
    const rtReply = rtRes.messages.find((m) => m && m.id === msg.id && m.result);
    if (rtReply) {
      rtTools = rtReply.result.tools || [];
    } else {
      rtTools = fallbackToolsFor(rtRes.failure?.kind, rtRes.failure?.detail);
    }
  } catch (err) {
    const kind = err instanceof UpstreamError ? err.kind : 'TRANSPORT';
    rtTools = fallbackToolsFor(kind, err.message);
  }

  const seen = new Set(bdTools.map((t) => t.name));
  const merged = bdTools.slice();
  for (const t of rtTools) {
    if (seen.has(t.name)) {
      process.stderr.write(`[tradeos-mcp-proxy] Duplicate tool name from RT, keeping BD's: ${t.name}\n`);
      continue;
    }
    merged.push(t);
  }

  emit({ jsonrpc: '2.0', id: msg.id, result: { ...bdReply.result, tools: merged } });
}

function fallbackToolsFor(kind, detail) {
  if (kind === 'MCP_DENIED' || kind === 'KEY_BAD_TIER') {
    // Keep the tools visible so the user can find out why they don't work.
    process.stderr.write(`[tradeos-mcp-proxy] RT refused us [${kind}]: ${detail || ''} — advertising RT tools from the static bundle\n`);
    return RT_TOOLS_FALLBACK;
  }
  process.stderr.write(`[tradeos-mcp-proxy] RT unavailable [${kind}]: ${detail || ''} — continuing with BD tools only\n`);
  return [];
}

// Every rt_* call must produce exactly one response. The client has no timeout
// of its own here; an unanswered id is a conversation that never resumes.
async function handleRtToolCall(msg) {
  const rt = UPSTREAMS.rt;
  try {
    await ensureRtInit(rt);
    const res = await sendTo(rt, msg);
    const reply = res.messages.find((m) => m && m.id === msg.id);
    if (reply) { emitAll(res.messages); return; }
    emitToolError(msg, res.failure?.kind, res.failure?.detail);
  } catch (err) {
    const kind = err instanceof UpstreamError ? err.kind : 'TRANSPORT';
    emitToolError(msg, kind, err.message);
  }
}

function emitToolError(msg, kind, detail) {
  process.stderr.write(`[tradeos-mcp-proxy] RT tool call failed [${kind || 'TRANSPORT'}]: ${detail || ''}\n`);
  emit({
    jsonrpc: '2.0',
    id: msg.id,
    result: {
      content: [{ type: 'text', text: rtGate.userMessage(kind) }],
      isError: true,
    },
  });
}

function isRtToolCall(msg) {
  return msg
    && msg.method === 'tools/call'
    && typeof msg.params?.name === 'string'
    && msg.params.name.startsWith(RT_TOOL_PREFIX);
}

// --- Main loop -------------------------------------------------------------

// ── Interactive setup (plugin-only) ──────────────────────────────────────

function ask(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      rl._writeToOutput = (str) => {
        if (str.includes(question) || str === '\n' || str === '\r\n') rl.output.write(str);
        else rl.output.write('*');
      };
    }
    rl.question(question, (ans) => { rl.close(); if (mask) process.stdout.write('\n'); resolve(ans.trim()); });
  });
}

async function runSetup() {
  process.stdout.write('TradeOS setup — iTRADE の認証情報を入力してください（パスワードは保存されず、スコープ付き API キーだけがローカルに保存されます）。\n');
  const username = USERNAME || await ask('iTRADE username: ');
  const password = PASSWORD || await ask('iTRADE password: ', { mask: true });
  if (!username || !password) { process.stderr.write('username/password が空です。中止します。\n'); process.exit(1); }

  // Both keys are minted here on purpose. Setup is the only moment we still hold
  // the password — it is discarded immediately afterwards — so a later attempt to
  // provision RT lazily would find nothing to authenticate with and RT would be
  // permanently unavailable for anyone who set up this way.
  const creds = { username, password };
  const mint = async (up) => {
    const key = await issueApiKey({ ...up, keyBody: () => ({ ...up.keyBody(), ...creds }) });
    writeCachedKey(up, key);
    return key;
  };

  try {
    await mint(UPSTREAMS.bd);
    process.stdout.write(`✓ バックテスト用 API キーを保存しました（${UPSTREAMS.bd.cacheFile}）。\n`);
  } catch (err) {
    process.stderr.write(`✗ セットアップ失敗: ${err.message}\n`);
    process.exit(1);
  }

  // RT is optional: a BT-only account has no RT01 user row, and that must not
  // fail the whole setup.
  try {
    await mint(UPSTREAMS.rt);
    process.stdout.write(`✓ リアルトレード用 API キーを保存しました（${UPSTREAMS.rt.cacheFile}）。\n`);
  } catch (err) {
    process.stdout.write(`- リアルトレードは今回スキップしました（${err.message}）。バックテストはそのままご利用いただけます。\n`);
  }

  process.stdout.write('✓ セットアップ完了。パスワードは破棄しました。\n');
  process.exit(0);
}

if (SETUP_MODE) {
  runSetup();
} else {

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch (err) {
    process.stderr.write(`Proxy error: bad JSON from client: ${err.message}\n`);
    return;
  }
  rememberHandshake(msg);

  try {
    if (msg.method === 'tools/list' && msg.id !== undefined) {
      await handleToolsList(msg);
      return;
    }
    if (isRtToolCall(msg)) {
      await handleRtToolCall(msg);
      return;
    }

    const res = await sendTo(UPSTREAMS.bd, msg);
    emitAll(res.messages);
    if (!res.messages.length && msg.id !== undefined && res.failure) {
      emit({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32603, message: `接続に問題が発生しました (${res.failure.detail || res.failure.kind})` },
      });
    }

    // Once the client finishes its handshake, start RT provisioning in the
    // background. Doing it lazily inside tools/list would put a key mint plus
    // three round-trips inside that leg's 8s budget, and a cold start would
    // routinely blow it — leaving the user with no RT tools for the whole
    // session.
    if (msg.method === 'notifications/initialized') {
      ensureRtInit(UPSTREAMS.rt).catch(() => { /* reported by ensureApiKey */ });
    }
  } catch (err) {
    process.stderr.write(`Proxy error: ${err.message}\n`);
  }
});

rl.on('close', () => process.exit(0));

// Warm the BD key at startup so bad credentials surface immediately rather than
// on the first tool call. Non-fatal: ensureApiKey retries on demand.
(async () => {
  UPSTREAMS.bd.apiKey = readCachedKey(UPSTREAMS.bd);
  UPSTREAMS.rt.apiKey = readCachedKey(UPSTREAMS.rt);
  try {
    await ensureApiKey(UPSTREAMS.bd);
  } catch (err) {
    process.stderr.write(`[tradeos-mcp-proxy] Failed to obtain BD API key: ${err.message}\n`);
    process.stderr.write('[tradeos-mcp-proxy] Check the TradeOS username/password in Claude Desktop settings.\n');
  }
  process.stderr.write(`[tradeos-mcp-proxy] BD ${UPSTREAMS.bd.mcpUrl}\n`);
  process.stderr.write(`[tradeos-mcp-proxy] RT ${UPSTREAMS.rt.mcpUrl}\n`);
})();

}
