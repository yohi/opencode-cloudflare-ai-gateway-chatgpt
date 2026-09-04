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
   - 会話履歴（`messages`）が長大化（700 KiB 〜 4 MiB）した場合、Cloudflare Workers の無料枠（CPU 10ms 制限）では JSON のパース・シリアライズだけで制限時間を超過し、タスク終盤でワーカーがクラッシュ（Error 1102）する致命的リスクがある。
4. **個別リレー乱立の防止**
   - 既存の `yohi/opencode-cloudflare-ai-gateway-chatgpt`（Deno Deploy 上の ChatGPT Codex 用リレー）が存在するが、ChatGPT 特化となっている。これを汎用化することで、大容量変換を Deno Deploy 側へ分離し、複数プロバイダの非互換性を一元的に吸収するリレー基盤が必要とされている。

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
│        ├─ Tool Schema Normalization (anyOf → properties 互換変換) │
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
    - `command-code`: `https://api.commandcode.ai/provider/`
    - 今後追加される任意の OpenAI 互換プロバイダ
- **upstream URL の containment**:
  - プリセットの base URL は固定された絶対 URL として解釈する。クライアント由来の path suffix は URL reference として解決せず、プリセットの pathname に付加する path data として扱う。`new URL(suffix, base)` の relative/root/authority reference semantics に依存してはならない。
  - 最終 upstream URL の `origin` はプリセット base URL の `origin` と完全一致し、`pathname` はプリセット base URL の固定 pathname prefix 配下でなければならない。prefix の末尾 `/` は path segment boundary として扱い、`command-code` では `/provider/` 配下だけを許可する。
  - URL の構築・解析・正規化後に containment を証明できない suffix、`//` または `///` で始まる authority-like suffix、dot segment、percent-encoded dot segment、または path segmentation を変え得る encoded separator は、上流 fetch 前に `404 Not Found` とする。
  - query string は incoming URL の `search` として pathname から分離して保持し、path の URL 解決には使用しない。正常な query string は upstream へ透過する。
  - **クライアント path の正準化**: `/upstream/command-code/` 以降には upstream API の完全な path を渡し、`/v1/chat/completions`、`/v1/messages`、`/v1/models` のように `/v1` を含める。OpenAI SDK は base URL の `/v1` を前提に endpoint suffix を付加し、Anthropic SDK は `/v1` なしの base URL に対して自身で `/v1` を付加するため、relay は `/v1` を暗黙に削除・追加してはならない。
- **後方互換性の維持**:
  - 既存の ChatGPT Codex 経路（`/v1/responses`）はそのまま維持し、`https://chatgpt.com/backend-api/codex/responses` へ転送する。
- **未知のプロバイダへの対応**:
  - 設定されていない `provider-slug` へのリクエストは `404 Not Found` を返す。

### 3.2 リクエストサニタイズ機能（スキーマ正規化パイプライン）
- **Tool Schema Normalization（ツール定義の正規化）**:
  - 対象: `Content-Type` を HTTP media type として解釈した type/subtype が `application/json`（パラメータ付き表記および type/subtype の大文字小文字違いを含む）かつ `body.tools` が配列の場合。
  - **JSON body parse failure**:
    - `/upstream/*` の POST かつ media type が `application/json` の場合、body の JSON パースに失敗したら、upstream fetch の前に status `400`、body `{"error":"invalid_json_body"}` を返す。
    - 空の body（body なしを含む）も JSON パース失敗として同じ扱いとする。
    - 既存の `/v1/responses` 経路では body をパースせず、従来のストリーミング転送を維持する。
  - **JSON 数値の無損失保持**:
    - 汎用経路は、リクエスト全体を ECMAScript の `JSON.parse` → `JSON.stringify` で再構築してはならない。これにより、正規化対象外のフィールドや数値リテラルが暗黙に変更されることを防ぐ。
    - 正規化は各 JSON token の元の body byte span を保持する raw/token-preserving 表現を使い、対象となる `tools[].function.parameters` の変更対象 span だけを置換する。それ以外の body bytes と JSON token（number を含む）は保持する。
    - scanner は JSON の文字列状態、escape（escaped quote、backslash、`\u0000` 形式を含む）、および nesting を追跡し、文字列中の `{`、`}`、`[`、`]`、`,`、`:`、`"tools"` を JSON 構文や member path として誤認してはならない。`tools`、`function`、`parameters` の member path は JSON string escape を解釈して判定するが、元の key token bytes は変更しない。
    - body の位置情報は元の UTF-8 body bytes に対する byte offset とし、JavaScript の UTF-16 code-unit index と混同してはならない。複数の置換 span は元の body に対する位置で計算し、右から左へ適用するか、先行置換による長さ変化を後続位置へ正しく反映する。
    - `Number.MIN_SAFE_INTEGER` から `Number.MAX_SAFE_INTEGER` の範囲外にある整数リテラルは ECMAScript `number` に変換せず、不透明な文字列表現として扱う。少なくとも `9007199254740993` と `9223372036854775807` は入力と同じ値・表記で転送する。
    - 無損失な変換結果を保証できない場合は、正規化済み部分と元の部分を混在させた body を生成せず、元の body bytes をそのまま upstream へ転送して正規化をスキップする。丸め・切り捨て・指数表記の変更などの silent data corruption は許容しない。
  - **`anyOf` の互換性変換（意図的な意味の狭め込み）**:
    - `parameters.anyOf` が存在する場合、以下の条件をすべて満たすときのみ、各 branch の `properties` をルート直下にマージし、`anyOf` キーを削除する。
      1. すべての branch が `type: "object"` を持つこと。
      2. 各 branch が `properties` 以外の制約（`required`、`additionalProperties`、`enum`、`const`、条件付き制約等）を持たないこと。
      3. 異なる branch 間で同名の property key が存在しないこと。
      4. 各 branch の property の型・制約が互換であること。
      5. `parameters` ルートに、branch の評価と相互作用する object 制約（`properties`、`required`、`additionalProperties`、`patternProperties`、`unevaluatedProperties` 等）が存在しないこと。
    - **重要**: JSON Schema の `anyOf` は OR であるため、 flatten により property 間の AND 的制約に置き換わり、元 schema では valid な一部のインスタンスが invalid となる。本変換は JSON Schema 上の strict な意味保存ではなく、MCP サーバー（Greptile 等）が実際に生成する特定の anyOf パターンを対象プロバイダの strict バリデータに通すための互換策である。
    - 上記条件を満たさない `anyOf` は、そのまま残すか、非対応として変換前のリクエストを拒否する。後勝ちマージによる silent semantic corruption は許容しない。特に root と branch の object 制約を含むスキーマは、変換前後で評価範囲が変わり得るため flatten しない。
  - **`type: "object"` の強制保証**:
    - `parameters.type` が未定義、あるいは空オブジェクト `{}` の場合、必ず `"type": "object"` を付与する。
  - **空 properties の健全化**:
    - 引数のないツールのパラメータ定義であっても、`"properties": {}` を保持させて厳格バリデータを通過させる。
- **メッセージ / 引数の破損防止**:
  - `tools` 以外の巨大なフィールド（`messages` 等）は一切改変せず、raw/token-preserving な body のまま転送する。
  - `tools[].function.parameters` でも正規化対象外のフィールドと JSON 数値 token は一切改変しない。

### 3.3 認証・セキュリティ機能
- **リレー共通認証トークン**:
  - Gateway から送信される Bearer トークンは `X-Relay-Authorization: Bearer <RELAY_SECRET>` の形式で検証する。`/upstream/*` では標準 `Authorization` ヘッダーはリレー認証には使用しない。
  - ChatGPT 経路の後方互換ヘッダー（`X-ChatGPT-Relay-Authorization`）も同時にサポートする。
- **ヘッダーサニタイズ**:
  - Hop-by-hop ヘッダー（`connection`, `transfer-encoding` 等）を除去。
  - Cloudflare 内部ヘッダー（`cf-*`, `cf-aig-*`, `x-forwarded-*`）を上流へ流さないよう除去。
  - リレー認証ヘッダー（`X-Relay-Authorization`、`X-ChatGPT-Relay-Authorization`）を上流へ漏洩させない。
  - 標準 `Authorization` ヘッダーは上流プロバイダーの認証情報として保持・転送する。
- **リダイレクト制御**:
  - `/v1/responses` と `/upstream/*` の共通 upstream fetch は `RequestInit.redirect: "manual"` を指定し、upstream の 3xx を `Location` に従って自動取得しない。3xx の status、サニタイズ後の response headers（`Location` を含む）、body は relay response として透過する。

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
  - **処理場所と CPU リスクの分離**: 大容量リクエストの JSON scan/transform は Deno Deploy relay で実行し、Cloudflare Workers Free の 10ms CPU 制限を relay の処理に持ち込まないこと。Deno Deploy の CPU 無制限を前提にせず、対象 plan/runtime の計測値と下記 SLO で受け入れ判定すること。
  - **メモリ予算**: 1 リクエストの process/heap high-water を、保守的なアプリケーション予算 512 MB 以内かつ対象 plan/runtime の上限に対する安全余裕を確保した状態で安定稼働させること。512 MB を Deno Deploy 共通の platform limit とは仮定しない。
- **ゼロ外部依存**:
  - Deno 標準 API（`Deno.serve`, `fetch`, `ReadableStream` 等）のみで実装し、メンテナンスコストを最小化する。

### 4.2 性能要件
- **レイテンシオーバーヘッド SLO（初期値）**:
  - 受信済み body bytes の scan/transform 開始から、upstream fetch を開始できる request body と header の準備完了までを計測区間とする。network 転送、upstream 待ち時間、cold start は含めない。
  - 対象 body size は 700 KiB、1 MiB、2 MiB、4 MiB とし、warm な Deno Deploy instance、単一同時実行で p95 を測定する。
  - JSON scan/transform と header 処理を合わせた p95 は各サイズで 10ms 未満を初期目標とする。これは Cloudflare または Deno Deploy の platform limit ではなく、測定可能な product SLO である。
  - benchmark は p50/p95/p99、body size、runtime/version、region、warm/cold 条件、concurrency、および process/heap high-water を記録する。SLO 判定は target Deno Deploy 環境で行い、ローカル実行結果だけで合否を決めない。

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
- **クライアント path**:
  - OpenAI SDK の base URL は `.../custom-command-code/v1` とし、SDK が付加する `/chat/completions` により Gateway から relay へ `/upstream/command-code/v1/chat/completions` を到達させる。
  - Anthropic SDK の base URL は `.../custom-command-code` とし、SDK が付加する `/v1/messages` により Gateway から relay へ `/upstream/command-code/v1/messages` を到達させる。
  - models list は両 SDK とも `/v1/models` を使用し、relay から upstream の `https://api.commandcode.ai/provider/v1/models` へ転送する。

---

## 6. 将来の拡張性（Roadmap）
1. **プロバイダ別パラメータ相互変換**:
   - OpenAI 互換 API 間の細かなパラメータ名差異（`max_tokens` ↔ `max_completion_tokens`、`thinking` パラメータ等）の透過的書き換え。
2. **モデル名エイリアシング**:
   - Gateway 上で指定されたモデル名を上流プロバイダの正確な識別子へマッピングする機能。
