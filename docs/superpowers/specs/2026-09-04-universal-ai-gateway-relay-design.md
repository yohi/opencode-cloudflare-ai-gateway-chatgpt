# 汎用 AI Gateway リレー設計書

## 1. 背景と目的

現在の `apps/deno-relay` は ChatGPT Codex 専用の egress リレーであり、固定 upstream である `https://chatgpt.com/backend-api/codex/responses` へ転送するのみである。

Cloudflare AI Gateway は可観測性・ログ収集・認証集約のハブとして有用だが、リクエストボディの JSON スキーマを動的に書き換える機能を持たない。そのため、Moonshot AI 等のプロバイダに対して MCP サーバーが出力するルートレベルの `anyOf` や空の `properties: {}` が HTTP 400 で拒絶される課題がある。

さらに、Cloudflare Workers Free プランの 10ms CPU 制限は、会話履歴が大容量化した際に JSON パース・シリアライズだけで超過するリスクがある。

本設計は、既存の Deno Deploy リレーを **汎用 AI Gateway リレー** に拡張し、次の目的を達成することを目指す。

1. 複数プロバイダ（OpenAI 互換 API）へのマルチアップストリーム転送
2. `tools[].function.parameters` のスキーマ正規化
3. Cloudflare Workers Free の CPU 制限を回避する Deno Deploy 基盤の活用
4. 既存 ChatGPT Codex 経路の後方互換維持

## 2. 設計原則

- **ゼロ外部依存**: Deno 標準 API のみで実装する
- **ステートレス**: リレー自身は永続状態を持たない
- **最小限の介入**: `tools` 配列のみを正規化し、`messages` 等の大容量フィールドは一切改変しない
- **後方互換**: 既存 `POST /v1/responses` 経路を維持する
- **責務分離**: HTTP 転送、ルーティング、スキーマ変換、各経路ハンドラを分離する

## 3. システムアーキテクチャ

### 3.1 全体トポロジー

```text
┌─────────────────────────────────────────────────────────────┐
│ クライアント層 (OpenCode / 各種 AI Agent)                     │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare AI Gateway (可観測性・統一ログ・キャッシュ)           │
│ - custom-command-code (base_url: https://<relay>/upstream/command-code)
│ - chatgpt-codex-deno  (base_url: https://<relay>/v1/responses)
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Deno Universal Relay (Deno Deploy)                          │
│                                                             │
│  [1. ルーティング解決]                                        │
│        ├─ POST /v1/responses                                │
│        └─ /upstream/<provider-slug>/*                       │
│        │                                                    │
│  [2. 認証検証]                                               │
│        ├─ /v1/responses: X-ChatGPT-Relay-Authorization      │
│        └─ /upstream/*: Authorization / X-Relay-Authorization│
│        │                                                    │
│  [3. リクエストサニタイズ（汎用経路のみ）]                      │
│        └─ tools[].function.parameters の正規化              │
│        │                                                    │
│  [4. upstream 転送 & SSE アイドルタイムアウト制御]             │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ CommandCode (api.commandcode)│ │ ChatGPT Codex (chatgpt.com) │
│  ⇒ Moonshot 公式 API         │ │                             │
└─────────────────────────────┘ └─────────────────────────────┘
```

### 3.2 ファイル構成

```text
apps/deno-relay/
├── main.ts              # Deno.serve 起動、環境変数から依存注入
├── router.ts            # パス判定、ハンドラ振り分け
├── chatgpt.ts           # POST /v1/responses → chatgpt.com 固定転送
├── upstream.ts          # /upstream/<provider-slug>/* → 対応 upstream 転送
├── forward.ts           # 共通の upstream fetch + SSE 転送ロジック
├── schema.ts            # tools スキーマ正規化
├── types.ts             # 共有型
├── relay_test.ts        # 既存後方互換 + 統合テスト
├── schema_test.ts       # 正規化単体テスト
└── deno.json            # 変更なし
```

### 3.3 コンポーネント責務

| コンポーネント | 責務 |
|---|---|
| `main.ts` | `Deno.serve` 起動、`RELAY_SECRET` 等の環境変数を読み取って依存を構成 |
| `router.ts` | HTTP method/path で振り分け、認証前に `404` を返す |
| `chatgpt.ts` | 既存 `/v1/responses` 専用ハンドラ。固定 upstream `https://chatgpt.com/backend-api/codex/responses` へ転送 |
| `upstream.ts` | 汎用 `/upstream/<provider-slug>/*` ハンドラ。provider 解決、body パース、スキーマ正規化、upstream URL 構築 |
| `forward.ts` | 共通の upstream fetch、ヘッダー制御、SSE/非 SSE 応答転送、タイムアウト・キャンセル処理 |
| `schema.ts` | `tools[].function.parameters` の正規化実装 |
| `types.ts` | `RelayDependencies`、`RelayTimer`、`RelayFetcher` 等の共有型 |

## 4. リクエスト処理フロー

### 4.1 ルーティング

```text
[Client / Cloudflare AI Gateway]
        │
        ▼
[router.ts]
   ├─ POST /v1/responses ──▶ [chatgpt.ts]
   │                         └─ upstream: https://chatgpt.com/backend-api/codex/responses
   │
   └─ /upstream/<slug>/* ──▶ [upstream.ts]
                             ├─ slug 解決（command-code）
                             ├─ 未知 slug → 404
                             ├─ body JSON パース
                             ├─ schema.ts で tools 正規化
                             ├─ upstream URL = base + 残りパス・クエリ
                             └─ forward.ts で転送
```

### 4.2 認証

| 経路 | 許可される認証ヘッダー | 備考 |
|---|---|---|
| `/v1/responses` | `X-ChatGPT-Relay-Authorization: Bearer <RELAY_SECRET>` | 既存後方互換 |
| `/upstream/*` | `Authorization: Bearer <RELAY_SECRET>` または `X-Relay-Authorization: Bearer <RELAY_SECRET>` | 汎用 |

- `RELAY_SECRET` が未設定/空 → `503 Service unavailable`（テキストボディ `Service unavailable`）
- 認証ヘッダー欠落/不一致 → `401 { "error": "unauthorized" }`
- いずれも upstream fetch の前に返す

### 4.3 upstream 転送

`forward.ts` は既存 `relay.ts` の SSE 転送ロジックを流用し、次を実施する。

- リクエストヘッダーのサニタイズ
  - Hop-by-hop ヘッダー除去（`connection`, `transfer-encoding`, `content-length` 等）
  - Cloudflare 内部ヘッダー除去（`cf-*`, `cf-aig-*`, `x-forwarded-*`）
  - リレー認証ヘッダー除去
  - `Connection` ヘッダーに列挙されたヘッダー除去
- upstream 応答ヘッダーのサニタイズ
- SSE 応答の場合、120 秒のアイドルタイムアウトを適用
- クライアント切断時に upstream fetch および response body を abort

## 5. Tools スキーマ正規化

### 5.1 適用条件

- HTTP method が POST であること
- `Content-Type` が `application/json` であること
- ボディが JSON としてパース可能であること
- `body.tools` が配列であること

### 5.2 正規化ルール

各 `tools[].function.parameters` に対し、以下を適用する。

1. **`anyOf` の解消**
   - `parameters.anyOf` が存在し、要素がオブジェクトの場合：
     - 各要素の `properties` をルート直下の `properties` にマージする
     - 同名 key が衝突した場合、後勝ち（配列後方の要素が優先）
     - 処理後、`anyOf` キーを削除する
   - `anyOf` 要素がオブジェクトでない場合は無視する

2. **`type: "object"` の保証**
   - `parameters.type` が未定義、空文字、または空オブジェクト `{}` の場合：
     - `"type": "object"` を付与する
   - それ以外の既存 `type` は変更しない

3. **空 `properties` の保持**
   - `parameters.properties` が未定義の場合：
     - `"properties": {}` を追加する
   - 既存の `properties` は保持する

4. **その他フィールド**
   - `required`, `description`, `additionalProperties` 等はそのまま保持する
   - `messages` 等、`tools` 以外のフィールドには一切触れない

### 5.3 正規化例

入力：

```json
{
  "model": "command-code",
  "messages": [{"role": "user", "content": "hello"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "greptile_search",
      "parameters": {
        "anyOf": [
          { "properties": { "query": { "type": "string" } } },
          { "properties": { "limit": { "type": "integer" } } }
        ]
      }
    }
  }]
}
```

出力：

```json
{
  "model": "command-code",
  "messages": [{"role": "user", "content": "hello"}],
  "tools": [{
    "type": "function",
    "function": {
      "name": "greptile_search",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "integer" }
        }
      }
    }
  }]
}
```

## 6. エラーハンドリング

| 状況 | ステータス | ボディ | 備考 |
|---|---|---|---|
| `RELAY_SECRET` 未設定/空 | `503` | `Service unavailable` | upstream fetch 前 |
| 認証ヘッダー欠落/不一致 | `401` | `{"error":"unauthorized"}` | upstream fetch 前 |
| 未知の provider slug | `404` | `Not Found` | upstream fetch 前 |
| リクエストボディ JSON パース失敗 | `400` | `{"error":"invalid_json_body"}` | 汎用経路のみ |
| upstream 接続・ヘッダー応答タイムアウト | `504` | `{"error":"upstream_connect_or_header_timeout"}` | 既定 30 秒 |
| SSE アイドルタイムアウト | stream error | `upstream_sse_idle_timeout` | 既定 120 秒 |
| その他の upstream fetch エラー | 伝播または pass-through | - | - |

## 7. 設定

### 7.1 環境変数

| 変数名 | 必須 | 説明 | 既定値 |
|---|---|---|---|
| `RELAY_SECRET` | ◯ | Gateway とリレー間の共通シークレットトークン | - |
| `UPSTREAM_HEADER_TIMEOUT_MS` | - | 上流初期応答タイムアウト | 30000 |
| `SSE_IDLE_TIMEOUT_MS` | - | SSE アイドルタイムアウト | 120000 |

### 7.2 プリセットプロバイダ

| provider-slug | upstream base URL |
|---|---|
| `command-code` | `https://api.commandcode.ai/provider/v1/` |

未知の `provider-slug` へのリクエストは `404 Not Found` を返す。

## 8. 非機能要件

- **基盤プラットフォーム**: Deno Deploy
- **CPU 制限回避**: Cloudflare Workers Free（10ms）と異なり、大容量リクエストの JSON パース・変換時にも CPU 枯渇エラー（1102）を起こさないこと
- **メモリ使用量**: 512 MB 以内で安定稼働すること
- **ゼロ外部依存**: Deno 標準 API のみで実装する
- **レイテンシオーバーヘッド**: リレー層における純粋な処理遅延（JSON パース＋変換＋ヘッダー処理）は 10ms 未満であること
- **ステートレス設計**: DB や永続状態を持たない
- **ログ**: 可観測性は Cloudflare AI Gateway に一元委託し、リレー側では機密ペイロードのログ出力を最小限に抑える

## 9. テスト戦略

### 9.1 schema_test.ts（新規）

以下をカバーする単体テストを作成する。

- `anyOf` のマージ
- `type` の補完（未定義 / 空 / 空オブジェクト）
- 空 `properties` の補完
- 引数なしツールの正規化
- 既存の正しいスキーマは無改変
- `messages` や他フィールドが残ること
- `anyOf` 要素がオブジェクトでない場合の無視
- 空 `tools` 配列の場合の無改変

### 9.2 relay_test.ts（既存を拡張）

以下を追加する統合テストを作成する。

- `/upstream/command-code/v1/chat/completions` への転送と upstream URL 検証
- 未知 provider slug での `404`
- `Authorization` / `X-Relay-Authorization` 認証
- リクエストボディの tools 正規化が upstream で確認できること
- 既存 `/v1/responses` テストの維持
- `/v1/responses` が `X-ChatGPT-Relay-Authorization` のみを受け付けること
- `/v1/responses` が `Authorization` / `X-Relay-Authorization` を受け付けないこと（推奨、省略可）

## 10. Future 拡張（Roadmap）

本設計では意図的にスコープ外とし、後続の拡張として SPEC.md/README.md に残す項目。

1. **プロバイダ別パラメータ相互変換**
   - OpenAI 互換 API 間の細かなパラメータ名差異（`max_tokens` ↔ `max_completion_tokens`、`thinking` パラメータ等）の透過的書き換え。

2. **モデル名エイリアシング**
   - Gateway 上で指定されたモデル名を上流プロバイダの正確な識別子へマッピングする機能。

3. **環境変数ベースのプロバイダ追加**
   - 現状は `command-code` のみをコード内にハードコード。将来的には `UPSTREAM_<SLUG>_URL` 等で動的にプロバイダを追加・上書きできる仕組みを検討する。

4. **レスポンス側の正規化**
   - 上流プロバイダのレスポンス形式を OpenAI 互換に変換する必要が生じた場合に検討する。

5. **追加プリセットプロバイダ**
   - 新しい OpenAI 互換プロバイダが必要になった場合、`upstream.ts` のプリセットマッピングに追加する。

## 11. 影響範囲

- `apps/deno-relay/*`: 既存 `relay.ts` を複数ファイルに再編成し、新機能を追加
- `README.md`: 新しい経路と設定を追記
- `packages/opencode-plugin`: 本設計の範囲では変更なし。将来的に汎用経路向けの設定が必要になった場合に別途検討

## 12. 移行手順

1. `apps/deno-relay/relay.ts` を `forward.ts` / `router.ts` / `chatgpt.ts` / `upstream.ts` / `schema.ts` / `types.ts` に再編成
2. `main.ts` を新しい構成に対応させる
3. `schema_test.ts` を新規作成
4. `relay_test.ts` を拡張
5. 既存の `deno test apps/deno-relay` / `deno lint` / `deno fmt --check` がすべて通ることを確認
6. Deno Deploy 側で `RELAY_SECRET` を設定済みであることを確認
7. Cloudflare AI Gateway の `command-code` Custom Provider の `base_url` を `https://<relay-domain>.deno.dev/upstream/command-code/` に変更
8. 既存 `chatgpt-codex-deno` provider は `base_url` を変更せず継続利用
