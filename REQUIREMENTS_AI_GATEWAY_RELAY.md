# 汎用 AI Gateway リレー（Universal AI Gateway Relay）要件定義書

## 1. 背景と課題

### 1.1 背景
現在、OpenCode などのコーディングエージェント環境では、Cloudflare AI Gateway を可観測性・ログ収集・認証集約のハブとして利用し、各 LLM プロバイダへリクエストをルーティングしている。

### 1.2 発生している課題
1. **プロバイダ固有の JSON Schema 厳格性によるエラー**
   - Moonshot AI（Kimi K2.7 Code 等）公式 API では、ツール定義（`tools[].function.parameters`）の検証が極めて厳格であり、MCP サーバー（Greptile 等）が標準仕様として出力するルートレベルの `anyOf` や空の `properties: {}` を不正な形式（`Invalid request: tools.function.parameters.type is required and must be "object"`）として HTTP 400 で拒絶する。
2. **Cloudflare AI Gateway 単体でのスキーマ変換機能の欠如**
   - AI Gateway はリバースプロキシとしてログやキャッシュを提供するが、リクエストボディ（JSON Payload）の内部スキーマを動的に書き換える（Transformation）機能を持たない。
3. **Cloudflare Workers Free プランの CPU 時間制限（10ms）のリスク**
   - 会話履歴（`messages`）が長大化（700KB 〜 数MB）した場合、Cloudflare Workers の無料枠（CPU 10ms 制限）では JSON のパース・シリアライズだけで制限時間を超過し、タスク終盤でワーカーがクラッシュ（Error 1102）する致命的リスクがある。
4. **個別リレー乱立の防止**
   - 既存の `yohi/opencode-cloudflare-ai-gateway-chatgpt`（Deno Deploy 上の ChatGPT Codex 用リレー）が存在するが、ChatGPT 特化となっている。これを汎用化することで、CPU 制限のない Deno Deploy 基盤を活用し、複数プロバイダの非互換性を一元的に吸収するリレー基盤が必要とされている。

---

## 2. システムアーキテクチャ

### 2.1 全体トポロジー
```text
┌─────────────────────────────────────────────────────────────┐
│ クライアント層 (OpenCode / 各種 AI Agent)                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare AI Gateway (可観測性・統一ログ・キャッシュ)           │
│ - custom-command-code (base_url: https://<relay>/upstream/command-code)
│ - chatgpt-codex-deno  (base_url: https://<relay>/v1/responses) │
│ - custom-xxx          (base_url: https://<relay>/upstream/xxx) │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Deno Universal Relay (Deno Deploy)                          │
│                                                             │
│  [1. 認証・ヘッダーサニタイズ]                                │
│        │                                                    │
│  [2. ルーティング解決 (Path-based / Target-based)]           │
│        │                                                    │
│  [3. リクエストサニタイズ・パイプライン]                       │
│        ├─ Tool Schema Normalization (anyOf → properties)    │
│        ├─ Type: "object" 保証 / 空パラメータ補正            │
│        └─ プロバイダ別特殊パラメータ変換                     │
│        │                                                    │
│  [4. SSE ストリーミング転送 & アイドルタイムアウト制御]        │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ CommandCode (api.commandcode)│ │ ChatGPT Codex (chatgpt.com) │
│  ⇒ Moonshot 公式 API         │ │                             │
└─────────────────────────────┘ └─────────────────────────────┘
```

---

## 3. 機能要件

### 3.1 ルーティング機能
- **パスベースのマルチアップストリーム転送**:
  - `/upstream/<provider-slug>/*` のパス構造を解釈し、対応する上流エンドポイントへリバースプロキシする。
  - **プリセットプロバイダ定義**:
    - `command-code`: `https://api.commandcode.ai/provider/v1/`
    - 今後追加される任意の OpenAI 互換プロバイダ
- **後方互換性の維持**:
  - 既存の ChatGPT Codex 経路（`/v1/responses`）はそのまま維持し、`https://chatgpt.com/backend-api/codex/responses` へ転送する。
- **未知のプロバイダへの対応**:
  - 設定されていない `provider-slug` へのリクエストは `404 Not Found` を返す。

### 3.2 リクエストサニタイズ機能（スキーマ正規化パイプライン）
- **Tool Schema Normalization（ツール定義の正規化）**:
  - 対象: `application/json` かつ `body.tools` が配列の場合。
  - **`anyOf` の条件付き解消**:
    - `parameters.anyOf` が存在する場合、以下の条件をすべて満たすときのみ、各 branch の `properties` をルート直下にマージし、`anyOf` キーを削除する。
      1. すべての branch が `type: "object"` を持つこと。
      2. 各 branch が `properties` 以外の制約（`required`、`additionalProperties`、`enum`、`const`、条件付き制約等）を持たないこと。
      3. 異なる branch 間で同名の property key が存在しないこと。
      4. 各 branch の property の型・制約が互換であること。
    - 上記条件を満たさない `anyOf` は、そのまま残すか、非対応として変換前のリクエストを拒否する。後勝ちマージによる silent semantic corruption は許容しない。
  - **`type: "object"` の強制保証**:
    - `parameters.type` が未定義、あるいは空オブジェクト `{}` の場合、必ず `"type": "object"` を付与する。
  - **空 properties の健全化**:
    - 引数のないツールのパラメータ定義であっても、`"properties": {}` を保持させて厳格バリデータを通過させる。
- **メッセージ / 引数の破損防止**:
  - `tools` 以外の巨大なフィールド（`messages` 等）は一切改変せず、参照を維持したまま転送する。

### 3.3 認証・セキュリティ機能
- **リレー共通認証トークン**:
  - Gateway から送信される Bearer トークンは `X-Relay-Authorization: Bearer <RELAY_SECRET>` の形式で検証する。`/upstream/*` では標準 `Authorization` ヘッダーはリレー認証には使用しない。
  - ChatGPT 経路の後方互換ヘッダー（`X-ChatGPT-Relay-Authorization`）も同時にサポートする。
- **ヘッダーサニタイズ**:
  - Hop-by-hop ヘッダー（`connection`, `transfer-encoding` 等）を除去。
  - Cloudflare 内部ヘッダー（`cf-*`, `cf-aig-*`, `x-forwarded-*`）を上流へ流さないよう除去。
  - リレー認証ヘッダー（`X-Relay-Authorization`、`X-ChatGPT-Relay-Authorization`）を上流へ漏洩させない。
  - 標準 `Authorization` ヘッダーは上流プロバイダーの認証情報として保持・転送する。

### 3.4 レスポンスストリーミング（SSE）中継
- **完全透過ストリーミング**:
  - `text/event-stream` をバッファリングせず、チャンク単位で即座にクライアントへフラッシュ転送。
- **ライフサイクル & タイムアウト管理**:
  - **上流接続タイムアウト**: 既定 30 秒（ヘッダー応答待ち）。
  - **SSE アイドルタイムアウト**: 既定 120 秒（ストリーム無通信検知で自動切断）。
  - **クライアント切断検知**: クライアントが通信を切断（Abort）した場合、上流の fetch リクエストも即座に abort し、無駄なトークン消費・リソース浪費を防ぐ。

---

## 4. 非機能要件

### 4.1 実行環境・リソース制約
- **基盤プラットフォーム**: Deno Deploy
  - **CPU 制限の回避**: Cloudflare Workers Free（10ms）と異なり、大容量リクエスト（数MB）の JSON パース・変換時にも CPU 枯渇エラー（1102）を起こさないこと。
  - **メモリ使用量**: 512 MB 以内で安定稼働すること。
- **ゼロ外部依存**:
  - Deno 標準 API（`Deno.serve`, `fetch`, `ReadableStream` 等）のみで実装し、メンテナンスコストを最小化する。

### 4.2 性能要件
- **レイテンシオーバーヘッド**:
  - リレー層における純粋な処理遅延（JSON パース＋変換＋ヘッダー処理）は 10ms 未満であること。

### 4.3 信頼性・観測性
- **ステートレス設計**:
  - リレー自身は DB や永続状態を持たず、完全にステートレスに動作すること。
- **ログ**:
  - ログ・履歴・トークン消費量の可観測性はすべて Cloudflare AI Gateway に一元委託し、リレー側では機密ペイロードのログ出力を最小限に抑える。

---

## 5. 設定および移行設計

### 5.1 環境変数（Deno Deploy 側）
| 変数名 | 必須 | 説明 |
| :--- | :---: | :--- |
| `RELAY_SECRET` | ◯ | Gateway とリレー間の共通シークレットトークン |
| `UPSTREAM_HEADER_TIMEOUT_MS` | - | 上流初期応答タイムアウト（既定: 30000） |
| `SSE_IDLE_TIMEOUT_MS` | - | SSE アイドルタイムアウト（既定: 120000） |

### 5.2 Cloudflare AI Gateway 側の Custom Provider 設定変更
- **プロバイダ名**: `command-code`
- **既存の Base URL**: `https://api.commandcode.ai/provider/v1/`
- **移行後の Base URL**: `https://<relay-domain>.deno.dev/upstream/command-code/`
- **設定ヘッダー**:
  - `X-Relay-Authorization: Bearer <RELAY_SECRET>`
  - 標準 `Authorization` ヘッダーは Command Code API key（`Authorization: Bearer <CMD_API_KEY>`）として Cloudflare から relay を経由して上流へ透過される。

---

## 6. 将来の拡張性（Roadmap）
1. **プロバイダ別パラメータ相互変換**:
   - OpenAI 互換 API 間の細かなパラメータ名差異（`max_tokens` ↔ `max_completion_tokens`、`thinking` パラメータ等）の透過的書き換え。
2. **モデル名エイリアシング**:
   - Gateway 上で指定されたモデル名を上流プロバイダの正確な識別子へマッピングする機能。
