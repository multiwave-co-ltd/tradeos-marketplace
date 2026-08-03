// TradeOS MCP client — RT (RealTrade) tool definitions.
//
// 🔴 THIS IS THE SINGLE SOURCE OF TRUTH for the RT tool list.
//
// Why a static bundle exists at all: when the RT upstream rejects us with 403
// (paywall / entitlement / stale client), we must still surface the RT tools in
// tools/list. If we dropped them, the client would never issue a tools/call and
// the user would never see *why* RT is unavailable — the feature would just
// silently vanish. Returning this bundle keeps the call path alive so the
// handler can answer with an actionable message.
//
// 🔴 Every entry MUST be a complete MCP Tool object (name + description +
// inputSchema). Do NOT copy the shape used by manifest.json (which carries only
// name + description): the client SDK validates the whole tools/list response
// against ListToolsResultSchema, so a single schema-invalid entry makes the
// merged response get rejected — taking the 39 BD tools down with it, in exactly
// the situation this fallback exists to handle.
//
// The manifest.json tools[] entries for RT are a one-way reduction of this file
// (name + description only). Never edit them independently.
//
// Captured from the live RT server on 2026-07-29:
//   https://rt01.atrasweb.com/atras.product.atrasrtmcp/mcp  (atrasrt-mcp 1.0.0)
// When the server adds/removes/changes an RT tool, re-capture and update here.

export const RT_TOOL_PREFIX = 'rt_';

export const RT_TOOLS_FALLBACK = [
  {
    "name": "rt_get_open_orders",
    "description": "Get the authenticated account's currently working (open) real-trade orders (orders with remaining quantity). Only working orders are shown — this is not a full order-history query. Values reflect the RT MySQL mirror (asOf shown).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sbid": {
          "type": "string",
          "description": "Optional: filter by strategy basket ID"
        },
        "sid": {
          "type": "string",
          "description": "Optional: filter by strategy ID"
        }
      },
      "required": []
    }
  },
  {
    "name": "rt_get_open_positions",
    "description": "Get the authenticated account's open real-trade positions with a live-quote overlay (last price, unrealized P&L, net P&L%). Rows come from the RT MySQL mirror; the last price is a read-only engine quote (broker API is NOT contacted). Symbols with no available quote show UNKNOWN P&L.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sbid": {
          "type": "string",
          "description": "Optional: filter by strategy basket ID"
        },
        "sid": {
          "type": "string",
          "description": "Optional: filter by strategy ID"
        }
      },
      "required": []
    }
  },
  {
    "name": "rt_get_strategy_trading_status",
    "description": "Get the live auto-trading status of each strategy for the authenticated account: trading_settings.enabled + trading mode (REAL/SIMULATION/FORWARDTEST) alongside the strategy's own enabled flag. Only REAL + enabled places live orders. Stored setting values (not the engine's mid-day runtime state).",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "rt_get_money",
    "description": "Get the allocated capital for the authenticated account's baskets and strategies, plus an approximate actualCash from the latest daily track. actualCash is an approximation, not the broker-side buying power.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sbid": {
          "type": "string",
          "description": "Optional: filter by strategy basket ID"
        },
        "sid": {
          "type": "string",
          "description": "Optional: filter strategy-level money by strategy ID"
        }
      },
      "required": []
    }
  },
  {
    "name": "rt_get_performance",
    "description": "Get the authenticated account's live-trade performance summary: accumulated net P&L and %, win rate, profit factor, payoff ratio, trade counts, max drawdown, and sterling ratio. Stored aggregate statistics per basket/strategy.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "sbid": {
          "type": "string",
          "description": "Optional: filter by strategy basket ID"
        },
        "sid": {
          "type": "string",
          "description": "Optional: filter by strategy ID (default: all summaries for the account)"
        }
      },
      "required": []
    }
  },
  {
    "name": "rt_get_account_type",
    "description": "Get the authenticated account's trading account (tax) classification code. Own account only. Returns the stored tradingaccounttype code.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "rt_get_oauth_token_status",
    "description": "Get the broker OAuth token status for the authenticated account: validity, issued-at, and expiry only. Token values are never returned (masked at the SQL level).",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "rt_get_trade_readiness",
    "description": "Show the DB-observable live-trade readiness gates for the account: trading_settings.enabled × trading mode (REAL) × OAuth token validity. execMode / live login / buying power are engine heap-only and are reported as UNKNOWN (not observable from the MCP process). Not a single 'ready' verdict.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  },
  {
    "name": "rt_healthcheck",
    "description": "Report RT engine health via a route-D quote availability metric (so silent P&L overlay degradation is detectable). Read-only; does not place orders.",
    "inputSchema": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
];
