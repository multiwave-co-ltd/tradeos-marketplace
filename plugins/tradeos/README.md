# TradeOS plugin

iTRADE のバックテスト・戦略アシスタントを Claude Code から使うプラグイン。詳細な導入手順はリポジトリルートの [README](../../README.md) を参照してください。

## 構成
- `.claude-plugin/plugin.json` — プラグイン定義（`userConfig` で認証情報、`mcpServers` で MCP 宣言）
- `.mcp.json` — stdio MCP サーバー定義（`node ${CLAUDE_PLUGIN_ROOT}/server/index.js`）
- `server/index.js` — stdio↔HTTPS プロキシ（Node 標準ライブラリのみ・クロスプラットフォーム）
  - `--setup`: 認証情報からスコープ付き API キーを発行しキャッシュ（パスワードは非保存）
  - 通常起動: キャッシュキーで BD01 の MCP エンドポイントへプロキシ
- `skills/tradeos-help/` — TradeOS の使い方スキル
- `commands/tradeos-setup.md` — `/tradeos-setup` セットアップ支援コマンド

## 認証情報の受け渡し
プロキシは以下の優先順で認証情報を解決します:
1. コマンドライン引数 `[username] [password]`
2. 環境変数 `CLAUDE_PLUGIN_OPTION_TRADEOS_USERNAME` / `_PASSWORD`（プラグイン userConfig 由来）
3. 環境変数 `TRADEOS_USERNAME` / `TRADEOS_PASSWORD`

キャッシュ済み API キー（`~/.tradeos/apikey`）があれば認証情報なしで起動できます（Claude Desktop 版 `.mcpb` と共有）。
