<div align="center">

# ⚡ TradeOS

### iTRADE を Claude から。**作って、検証して、動かす。**

自然言語で戦略を **作り** → バックテストで **検証** → そのまま **本番稼働** へ。<br/>
その一気通貫を、Claude Code / Claude Desktop から。

<br/>

[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-6C5CE7?style=for-the-badge)](https://code.claude.com/docs/en/plugins)
[![Version](https://img.shields.io/badge/version-0.1.0-blue?style=for-the-badge)](https://github.com/multiwave-co-ltd/tradeos-marketplace)
[![Tools](https://img.shields.io/badge/MCP-39_tools_+_1_prompt-orange?style=for-the-badge)](https://github.com/multiwave-co-ltd/tradeos-marketplace/tree/main/plugins/tradeos)
[![Platform](https://img.shields.io/badge/platform-macOS_·_Linux_·_Windows-informational?style=for-the-badge)](https://github.com/multiwave-co-ltd/tradeos-marketplace)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](https://github.com/multiwave-co-ltd/tradeos-marketplace/blob/main/LICENSE)

</div>

---

## 🎯 TradeOS とは

**TradeOS** は、iTRADE の戦略アシスタント兼バックテストエンジンを、Claude から自然言語で使えるようにするコネクターです。「こんな戦略が欲しい」と話すだけで、AI-Strategist が戦略ファイルを組み立て、そのまま過去データで検証し、改良まで一気通貫でサポートします。

```mermaid
flowchart LR
    A["✨ AI-Strategist<br/>自然言語で戦略を作る"]:::create
    B["📊 バックテスト<br/>過去データで検証・改良"]:::test
    C["🚀 本番稼働<br/>リアルトレード（今後対応）"]:::live
    A --> B --> C
    classDef create fill:#6C5CE7,color:#fff,stroke:#5a4bd1,stroke-width:2px
    classDef test fill:#00b894,color:#fff,stroke:#00a381,stroke-width:2px
    classDef live fill:#fdcb6e,color:#2d3436,stroke:#e0b04f,stroke-width:2px
```

---

## 🚀 インストール（2 コマンド）

Claude Code のセッション内で:

```bash
/plugin marketplace add multiwave-co-ltd/tradeos-marketplace
/plugin install tradeos@tradeos
```

続けて認証をセットアップ（下記「🔐 認証」参照）→ 新しいセッションで **39 ツールが利用可能**に。

> 💡 まず試すなら「**TradeOS ヘルプ**」と話しかけてください。全体像と分野別の使い方がチャット内に表示されます。

---

## ✨ できること

| | 機能 | 例 |
|---|------|-----|
| ✨ | **AI-Strategist（新規戦略の作成）** | 「25日移動平均を上抜けたら買う戦略を作って」 |
| 📊 | **バックテスト** | 「この戦略を 2020〜2024 で検証して」「結果の勝率は？」 |
| 🧺 | **ポートフォリオ（バスケット）編集** | 「戦略 A と B を資金1000万で組んで」「配分を 6:4 に」 |
| 📚 | **戦略ライブラリ管理** | 「この戦略をライブラリに登録して」 |
| 🔧 | **既存戦略の改良（過学習防止）** | 「戦略〇〇を読み込んで勝率を上げる提案をして」 |
| 🚀 | **本番稼働（リアルトレード）** | *今後のアップデートで対応予定* |

過学習を避けたい改良セッションでは、`atras_improvement_loop` プロンプト（**過学習防止ガイド**）を「＋」から添付すると、1変更ずつ検証・OOS 検証・やめ時の判断などのガードレールが読み込まれます。

---

## 🔐 認証（クロスプラットフォーム）

TradeOS はパスワードを直接保存せず、**スコープ付き API キー**を発行して使います。

| 方法 | 対応 OS | 保存されるもの | 特徴 |
|------|--------|----------------|------|
| **`/tradeos-setup`** ✅推奨 | macOS · Linux · **Windows** | **API キーのみ**（パスワードは破棄） | 全 OS で安全 |
| `/plugin` の設定に入力 | macOS（Keychain） | ユーザー名/パスワード | 便利・自動再発行あり |

> ⚠️ Windows / Linux では `userConfig`（`/plugin` 設定）の秘密値が**平文ファイル**に保存されます。これらの OS では **`/tradeos-setup`（トークンのみ保存）を推奨**します。

<details>
<summary>手動セットアップ（ターミナル）</summary>

```bash
# パスワードはマスク入力され、保存されません。スコープ付き API キーだけがキャッシュされます。
node "$(find ~/.claude/plugins -path '*tradeos/server/index.js' | head -1)" --setup
```
</details>

---

## 📦 含まれるもの

- 🔌 **MCP サーバー `tradeos`** — 39 ツール + `atras_improvement_loop` プロンプト
- 🧠 **スキル `tradeos-help`** — Claude が TradeOS を正しく使うための知識
- ⚙️ **コマンド `/tradeos-setup`** — 認証セットアップ支援

MCP プロキシは **Node.js 標準ライブラリのみ**で書かれ、依存ゼロ・クロスプラットフォーム（shebang 非依存）です。

---

## 🛠 前提

- **Node.js 18+**（PATH に `node`）
- iTRADE のアカウント（ユーザー名・パスワード）

---

## 🔒 セキュリティ

- 通信は **HTTPS**（証明書検証はデフォルト ON）
- 保存されるのは **スコープ付き・失効可能な API キー**のみ（推奨フロー）
- 接続先は **バックテストサーバー**（実取引サーバーとは分離）

---

<details>
<summary>🔄 更新 / 🗑 アンインストール</summary>

```bash
# 更新（新バージョンが出たら）
/plugin marketplace update tradeos

# アンインストール
/plugin uninstall tradeos@tradeos
/plugin marketplace remove tradeos
```
</details>

---

<div align="center">

**TradeOS** — Powered by ATRAS · Built for Claude

<sub>© 2026 MultiWave Co., Ltd. · All rights reserved · Licensed under MIT</sub>

</div>
