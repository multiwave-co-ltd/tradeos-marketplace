# TradeOS — Claude Code Marketplace

**TradeOS** は iTRADE の戦略アシスタント兼バックテストエンジンを **Claude Code (CLI)** から使うためのプラグインです。

> **① AI-Strategist（戦略作成・起点）→ ② バックテスト（検証）→ ③ 本番稼働（リアルトレード・今後対応予定）**

Claude Desktop 版（`.mcpb`）と同じサーバーに接続し、同じ 39 ツール + 過学習防止プロンプトが使えます。

## インストール

```
# 1) マーケットプレイスを追加（初回のみ）
/plugin marketplace add multiwave-co-ltd/tradeos-marketplace

# 2) プラグインをインストール + 有効化
/plugin install tradeos@tradeos

# 3) 認証セットアップ（下記のいずれか）
```

### 認証（クロスプラットフォーム）

TradeOS はパスワードを直接保存せず、**スコープ付き API キー**を発行して使います。

| 方法 | 対応 OS | 保存されるもの |
|------|--------|----------------|
| **`/tradeos-setup`（推奨）** | macOS / Linux / **Windows** | API キーのみ（`~/.tradeos/apikey`）。パスワードは破棄 |
| `/plugin` の設定に入力 | macOS（Keychain 安全） | ユーザー名/パスワード。※Win/Linux は平文保存のため非推奨 |

- **推奨（全 OS で安全）**: `/tradeos-setup` を実行し、案内に従って自分のターミナルで
  `node "<plugin>/server/index.js" --setup` を実行（パスワードはマスク入力・保存されません）。
- **macOS のみ**: `/plugin` の設定画面で iTRADE ユーザー名/パスワードを入力（Keychain 保存・キー自動再発行あり）。

### 確認

```
/mcp                 # tradeos が ✔ Connected か
「TradeOS ヘルプ」    # 使い方を表示
```

## 前提
- **Node.js 18+** がインストールされ、PATH に `node` があること（全 OS 共通）
- iTRADE のアカウント（ユーザー名・パスワード）

## 含まれるもの（リッチ版）
- MCP サーバー（`tradeos`）— 39 ツール + `atras_improvement_loop` プロンプト
- スキル `tradeos-help` — Claude が TradeOS を正しく使うための知識
- スラッシュコマンド `/tradeos-setup` — 認証セットアップ支援

## セキュリティ
- 通信は HTTPS（証明書検証は既定で ON）
- 保存されるのはスコープ付き・失効可能な API キーのみ（推奨フロー）
- 接続先はバックテストサーバー（実取引サーバーとは分離）

## アンインストール
```
/plugin uninstall tradeos@tradeos
/plugin marketplace remove tradeos
```

---
© MultiWave Co., Ltd. All rights reserved. Licensed under MIT.
