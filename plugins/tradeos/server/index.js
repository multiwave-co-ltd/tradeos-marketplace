// TradeOS MCP Proxy — Claude Code plugin edition.
// stdio <-> Streamable HTTP proxy to the TradeOS (iTRADE backtest) MCP server.
// Node.js built-ins ONLY. No npm dependencies. Cross-platform: macOS / Linux / Windows.
//
// ── Modes ────────────────────────────────────────────────────────────────
//   node index.js --setup
//       Interactive one-time setup. Prompts for iTRADE username + password
//       (password masked), exchanges them for a scoped API key, caches ONLY the
//       key locally, and DISCARDS the password. Run this once (or again if the
//       key is ever revoked).
//
//   node index.js [username] [password]
//       Proxy mode (how Claude Code launches it). Credentials are OPTIONAL:
//         * if a cached API key exists  -> it is used (no credentials needed)
//         * else username/password (argv or env) are exchanged for a key
//       Credentials may also arrive via environment variables:
//         CLAUDE_PLUGIN_OPTION_TRADEOS_USERNAME / _PASSWORD  (plugin userConfig)
//         TRADEOS_USERNAME / TRADEOS_PASSWORD                (plain env)
//
// ── Cross-platform credential security ───────────────────────────────────
// The master password is NEVER written to disk by this proxy. Only the scoped
// API key is cached (mode 0600 on Unix; best-effort on Windows). On Windows /
// Linux, Claude Code's plugin userConfig stores secrets in a PLAINTEXT file
// (~/.claude/.credentials.json), so prefer `--setup` there: the password is
// entered transiently and only the revocable, scoped key is persisted.

import { createInterface } from 'node:readline';
import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, chmodSync } from 'node:fs';

// Upstream endpoints (compile-time constants; server-side relocation does not
// require a client re-release).
const BD_MCP_URL = 'https://bd01.atrasweb.com/atras.product.atrasbtmcp/mcp';
const KEY_ISSUE_URL = 'https://bd01.atrasweb.com/atras.product.atrasbtweb/Services/GenerateProductApiKey';

// ── Credential resolution: argv > plugin-option env > plain env ───────────
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

// TLS: verify certificates by default (the bootstrap request carries the
// password). Opt out only against a trusted dev server.
const ALLOW_SELF_SIGNED = process.env.TRADEOS_ALLOW_SELF_SIGNED === 'true';
const REJECT_UNAUTHORIZED = !ALLOW_SELF_SIGNED;

// ── Local API key cache (shared with the Claude Desktop .mcpb so both use the
// same per-device key and don't rotate each other out) ───────────────────
const CACHE_DIR = join(homedir(), '.tradeos');
const CACHE_FILE = join(CACHE_DIR, 'apikey');

function readCachedKey() {
  try {
    const key = readFileSync(CACHE_FILE, 'utf8').trim();
    return key || null;
  } catch {
    return null;
  }
}

function writeCachedKey(key) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(CACHE_FILE, key, { mode: 0o600 });
    // On Windows these chmod calls are no-ops; wrap so they never throw.
    try { chmodSync(CACHE_FILE, 0o600); chmodSync(CACHE_DIR, 0o700); } catch { /* Windows: NTFS ACLs govern access */ }
  } catch (err) {
    process.stderr.write(`[tradeos] Warning: failed to cache API key locally: ${err.message}\n`);
  }
}

function clearCachedKey() {
  try { unlinkSync(CACHE_FILE); } catch { /* nothing to clear */ }
}

// POST {username,password} -> {resultcode, api_key, key_id}. Never logs secrets.
function issueApiKey(username, password) {
  const u = new URL(KEY_ISSUE_URL);
  const isHttps = u.protocol === 'https:';
  const doReq = isHttps ? httpsReq : httpReq;
  const body = JSON.stringify({ username, password });
  return new Promise((resolve, reject) => {
    const req = doReq(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname,
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
            reject(new Error(`Key issuance failed (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.api_key) { reject(new Error('Key issuance response missing api_key')); return; }
            resolve(parsed.api_key);
          } catch (err) {
            reject(new Error(`Key issuance response was not valid JSON: ${err.message}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', (err) => reject(new Error(`Key issuance HTTP error: ${err.message}`)));
    req.write(body);
    req.end();
  });
}

let apiKey = readCachedKey();
let issuingPromise = null;

async function ensureApiKey() {
  if (apiKey) return apiKey;
  if (!USERNAME || !PASSWORD) {
    throw new Error(
      'No cached API key and no credentials available. Run one-time setup:\n'
      + '  node "<this file>" --setup\n'
      + 'or set TradeOS username/password in the plugin config.',
    );
  }
  if (!issuingPromise) {
    issuingPromise = (async () => {
      process.stderr.write('[tradeos] No cached API key — requesting one from server...\n');
      const key = await issueApiKey(USERNAME, PASSWORD);
      writeCachedKey(key);
      apiKey = key;
      process.stderr.write('[tradeos] API key issued and cached locally (~/.tradeos/apikey).\n');
      return key;
    })().finally(() => { issuingPromise = null; });
  }
  return issuingPromise;
}

// ── Transport: stdio <-> Streamable HTTP proxy ───────────────────────────
const url = new URL(BD_MCP_URL);
const isHttps = url.protocol === 'https:';
const doRequest = isHttps ? httpsReq : httpReq;
let sessionId = null;

async function postMessage(msg, isRetry = false) {
  const key = await ensureApiKey();
  const body = JSON.stringify(msg);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${key}`,
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  return new Promise((resolve, reject) => {
    const req = doRequest(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers,
        rejectUnauthorized: REJECT_UNAUTHORIZED,
      },
      (res) => {
        if (res.headers['mcp-session-id']) sessionId = res.headers['mcp-session-id'];

        // 401 -> cached key stale; discard and retry once with a fresh key.
        if (res.statusCode === 401 && !isRetry) {
          res.resume();
          process.stderr.write('[tradeos] Got 401 from upstream — cached key stale, re-issuing...\n');
          clearCachedKey();
          apiKey = null;
          postMessage(msg, true).then(resolve, reject);
          return;
        }

        const ct = res.headers['content-type'] || '';
        if (res.statusCode === 202 || res.statusCode === 204) { res.resume(); resolve(); return; }

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
                  try { process.stdout.write(JSON.stringify(JSON.parse(d)) + '\n'); } catch { /* ignore malformed */ }
                }
              }
            }
          });
          res.on('end', resolve);
          res.on('error', reject);
        } else {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            if (raw.trim()) {
              try { process.stdout.write(JSON.stringify(JSON.parse(raw)) + '\n'); }
              catch { process.stderr.write(`Non-JSON response (${res.statusCode}): ${raw.slice(0, 200)}\n`); }
            }
            resolve();
          });
          res.on('error', reject);
        }
      },
    );
    req.on('error', (err) => { process.stderr.write(`HTTP error: ${err.message}\n`); reject(err); });
    req.write(body);
    req.end();
  });
}

// ── Interactive setup: prompt (password masked), issue, cache, discard ────
function ask(question, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (mask) {
      // Mask typed characters: only echo the prompt itself and newlines.
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
  try {
    const key = await issueApiKey(username, password);
    writeCachedKey(key);
    process.stdout.write(`✓ セットアップ完了。API キーを保存しました（${CACHE_FILE}）。パスワードは破棄しました。\n`);
    process.exit(0);
  } catch (err) {
    process.stderr.write(`✗ セットアップ失敗: ${err.message}\n`);
    process.exit(1);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────
if (SETUP_MODE) {
  runSetup();
} else {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const t = line.trim();
    if (!t) return;
    try { await postMessage(JSON.parse(t)); }
    catch (err) { process.stderr.write(`Proxy error: ${err.message}\n`); }
  });
  rl.on('close', () => process.exit(0));

  // Eagerly surface bootstrap problems in the log (non-fatal).
  (async () => {
    try { await ensureApiKey(); }
    catch (err) {
      process.stderr.write(`[tradeos] ${err.message}\n`);
    }
    process.stderr.write(`[tradeos] Proxying to ${BD_MCP_URL}\n`);
  })();
}
