---
name: tradeos-help
description: Use when the user asks about TradeOS, iTRADE backtesting, creating a trading strategy from natural language (AI-Strategist), running a portfolio backtest, editing baskets, the strategy library, improving a strategy without overfitting, or checking live real-trade status (open positions, orders, cash, performance). Explains what TradeOS does and how to drive its MCP tools.
---

# TradeOS の使い方ガイド

TradeOS は iTRADE の**戦略アシスタント兼バックテストエンジン**を Claude Code から使うコネクターです。真骨頂は次の一気通貫の流れ:

**① AI-Strategist（戦略作成・起点）→ ② バックテスト（検証）→ ③ 本番稼働（リアルトレード・参照のみ）**

`mcp__tradeos__*` ツールが利用できます。ユーザーの意図に応じて次のように案内・実行してください。

## ① AI-Strategist — 新規戦略の作成（まずここから）
「こんな戦略が欲しい」という自然言語から、ファクター・条件・注文ルールを組み立てて戦略ファイル（.stg）を作ります。
- 段階ロード系ツール（session 初期化 / strategy spec / design doc / basket & money spec / factor category / sample strategy）を使って仕様を参照しながら組み立てる
- 例: 「25日移動平均を上抜けたら買う戦略を作って」「RSI が 30 以下で買い、70 以上で売る戦略を作りたい」

## ② バックテスト — 作った戦略を検証
戦略を渡すと自動でバスケットを作り、過去データで検証します。
- 実行: `run_portfolio_backtest` / `quick_backtest`（アップロード即バックテスト）
- 状況・結果: 進捗確認、サマリー/日次/月次/年次/個別トレード/複合レポート、複数バスケットの比較
- 例: 「この戦略を 2020〜2024 で検証して」「結果の損益や勝率は？」「2つのバスケットを比較して」

## ③ 本番稼働（リアルトレード・参照のみ）
検証・改良で納得のいく戦略は iTRADE 上で実運用されます。ここでチャットから確認できるのは**稼働状況の参照だけ**です。**発注・資金移動・戦略の有効/無効切替はできません**（それらは iTRADE の画面で行います）。「取引を実行できます」「本番稼働を操作できます」のように誇張して案内しないでください。
- 建玉・未約定注文: `rt_get_open_positions` / `rt_get_open_orders`
- 資金・パフォーマンス: `rt_get_money` / `rt_get_performance`
- 稼働状況: `rt_get_strategy_trading_status` / `rt_get_trade_readiness` / `rt_get_account_type` / `rt_get_oauth_token_status` / `rt_healthcheck`
- 例: 「今の建玉と未約定の注文を見せて」「リアルトレードの資金残高と今月のパフォーマンスは？」
- 接続情報の追加入力は不要です（初回利用時に自動で認証します）

## ④ ポートフォリオ（バスケット）編集
複数戦略の組合せ、戦略の追加/削除、資金配分・優先順位・バスケット設定の変更、戦略の一括 ON/OFF。

## ⑤ 戦略ライブラリ
バスケットに入れる前のテンプレート置き場。登録・閲覧・どのバスケットで使われているかの確認。ライブラリ版とバスケット内コピーは独立しているので、**どちらを編集しているかを常に明示**してください。

## ⑥ 既存戦略の改良（過学習に注意）
既存戦略を読み込んで一緒に改善します。**改良時は過学習（オーバーフィッティング）を必ず警戒**:
- 1回に1変更ずつ検証する
- アウトオブサンプル（期間を 8:2 に分割）で未知データを確認する
- 過学習のサイン（取引回数の急減・パラメータ増加・特定銘柄/期間への集中・全指標が完璧すぎる・Profit Factor と Sterling Ratio の乖離）をチェックする
- 改善が頭打ち／取引回数が統計的に少なすぎ／複雑になりすぎたら止める
- サーバー側の改良回数上限（15回/日で警告・30回/日で停止）を尊重する
- `atras_improvement_loop` プロンプトを添付すると、上記ガードレールが会話に読み込まれます

## 運用上の注意
- サーバー側の tradeos_help ツールがある場合はそれを最優先で参照（最新の機能一覧が返る）。「TradeOS ヘルプ」「改良のヘルプ」等でカテゴリ別案内が得られる
- 接続できない・タイムアウトする場合は `/tradeos-setup` で認証（API キー）を再設定するよう案内する
