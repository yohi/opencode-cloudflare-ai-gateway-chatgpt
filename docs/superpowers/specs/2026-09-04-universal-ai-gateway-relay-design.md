# 汎用 AI Gateway リレー設計書

## 1. 背景と目的

現在の `apps/deno-relay` は ChatGPT Codex 専用の egress リレーであり、固定 upstream である `https://chatgpt.com/backend-api/codex/responses` へ転送するのみである。

Cloudflare AI Gateway は可観測性・ログ収集・認証集約のハブとして有用だが、リクエストボディの JSON スキーマを動的に書き換える機能を持たない。そのため、Moonshot AI 等のプロバイダに対して MCP サーバーが出力するルートレベルの `anyOf` や空の `properties: {}` が HTTP 400 で拒絶される課題がある。

さらに、Cloudflare Workers Free プランの 10ms CPU 制限は、会話履歴が大容量化した際に JSON パース・シリアライズだけで超過するリスクがある。本設計では、この変換処理を Cloudflare Workers の実行範囲から Deno Deploy relay 側へ分離する。

本設計は、既存の Deno Deploy リレーを **汎用 AI Gateway リレー** に拡張し、次の目的を達成することを目指す。

1. 複数プロバイダ API（OpenAI 互換および Anthropic Messages 形状）へのマルチアップストリーム転送
2. OpenAI の `tools[].function.parameters` と Anthropic Messages の `tools[].input_schema` のスキーマ正規化
3. Cloudflare Workers Free の CPU 制限の影響を受ける処理を Deno Deploy relay へ分離
4. 既存 ChatGPT Codex 経路の後方互換維持

## 2. 設計原則

- **ゼロ外部依存**: Deno 標準 API のみで実装する
- **ステートレス**: リレー自身は永続状態を持たない
- **最小限の介入**: raw/token-preserving な body のうち、route に対応する
  `tools[].function.parameters` または `tools[].input_schema` の対象キーのみを正規化し、
  `messages` 等の大容量フィールドと正規化対象外の JSON token は一切改変しない
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
│        └─ /upstream/*: X-Relay-Authorization               │
│        │                                                    │
│  [3. リクエストサニタイズ（汎用経路のみ）]                      │
│        └─ OpenAI / Anthropic tools schema の正規化          │
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
├── schema.ts            # OpenAI / Anthropic tools スキーマ正規化
├── config.ts             # 環境変数の timeout parsing と設定値
├── types.ts             # 共有型
├── relay_test.ts        # 既存後方互換 + 統合テスト
├── schema_test.ts       # 正規化単体テスト
├── config_test.ts       # 環境変数設定単体テスト
└── deno.json            # 変更なし
```

### 3.3 コンポーネント責務

| コンポーネント | 責務 |
|---|---|
| `main.ts` | `Deno.serve` 起動、`RELAY_SECRET` 等の環境変数を読み取り、`config.ts` の検証済み timeout を依存注入 |
| `router.ts` | HTTP method/path で振り分け、認証前に `404` を返す |
| `chatgpt.ts` | 既存 `/v1/responses` 専用ハンドラ。固定 upstream `https://chatgpt.com/backend-api/codex/responses` へ転送 |
| `upstream.ts` | 汎用 `/upstream/<provider-slug>/*` ハンドラ。provider 解決、HTTP method のそのまま転送、provider-compatible route として定義された POST + `application/json` 時の lossless body scan/transform と route policy に基づく OpenAI / Anthropic schema 正規化、upstream URL 構築。既知 route の JSON パース失敗時は route-specific な provider-compatible error envelope を `400` で返し、`forward.ts` を呼び出さない。未知の route/method、または envelope 未定義 route は JSON parse せず body を raw forward する。既知の `command-code` route では OpenAI / Anthropic の error shape を使い、universal な relay error envelope は返さない。path suffix は URL reference ではなく preset pathname に付加する path data として扱い、最終 URL の origin と固定 pathname prefix を検証する。containment 違反または検証不能時は `404` とし、upstream fetch を呼び出さない（例: base=`https://api.commandcode.ai/provider/`、path=`/v1/chat/completions` → `https://api.commandcode.ai/provider/v1/chat/completions`）。generic upstream の `304` 以外の 3xx は `502 {"error":"upstream_redirect_not_allowed"}` に変換し、`Location` を透過しない |
| `forward.ts` | 共通の upstream fetch、ヘッダー制御、SSE/非 SSE 応答転送、タイムアウト・キャンセル処理。`/v1/responses` と `/upstream/*` の全経路で `RequestInit.redirect` を `"manual"` にする。generic route は `304` を pass-through し、それ以外の 3xx を拒否する。legacy route は既存の 3xx を互換 pass-through する |
| `schema.ts` | provider preset から明示的に渡された route policy に従い、OpenAI の `tools[].function.parameters` または Anthropic の `tools[].input_schema` を正規化する。provider policy を body member 名から推測しない |
| `config.ts` | `UPSTREAM_HEADER_TIMEOUT_MS` と `SSE_IDLE_TIMEOUT_MS` を既定値・範囲付き整数 milliseconds として parse し、不正値で fail-closed にする |
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
                             ├─ pathname suffix と query を分離
                             ├─ suffix を path data として preset pathname に付加
                             ├─ origin と pathname prefix の containment 検証
                             ├─ containment 違反/検証不能 → 404（fetch 0 回）
                             ├─ HTTP method をそのまま forward
                             ├─ 既知 provider route の POST + application/json のみ lossless token scan/transform
                             ├─ 既知 route の JSON parse 失敗 → route-specific provider-compatible 400（upstream fetch 前）
                             ├─ 未知 route/method または envelope 未定義 → JSON parse せず raw forward
                             ├─ 既知 route に対応する tools schema を schema.ts で正規化
                             ├─ containment 検証済みの upstream URL と query を forward
                             └─ forward.ts で `redirect: "manual"` を指定し、generic の 304 以外の 3xx を拒否
```

### 4.2 認証

| 経路 | 許可される認証ヘッダー | 備考 |
|---|---|---|
| `/v1/responses` | `X-ChatGPT-Relay-Authorization: Bearer <RELAY_SECRET>` | 既存後方互換 |
| `/upstream/*` | `X-Relay-Authorization: Bearer <RELAY_SECRET>` | 汎用。標準 `Authorization` は upstream provider credential として転送される |

- `RELAY_SECRET` が未設定/空 → `503 Service unavailable`（テキストボディ `Service unavailable`）
- 認証ヘッダー欠落/不一致 → `401 { "error": "unauthorized" }`
- いずれも upstream fetch の前に返す

### 4.3 upstream 転送

`forward.ts` は既存 `relay.ts` の SSE 転送ロジックを流用し、次を実施する。

- リクエストヘッダーのサニタイズ
  - Hop-by-hop ヘッダー除去（`connection`, `transfer-encoding`, `content-length` 等）
  - Cloudflare 内部ヘッダー除去（`cf-*`, `cf-aig-*`, `x-forwarded-*`）
  - リレー認証ヘッダー除去（`X-Relay-Authorization`、`X-ChatGPT-Relay-Authorization`）
  - `Connection` ヘッダーに列挙されたヘッダー除去
  - 標準 `Authorization` ヘッダーは upstream provider credential として保持・転送する
- upstream URL の containment 検証が完了するまで provider credential を転送しない
- upstream 応答ヘッダーのサニタイズ
- upstream fetch では必ず `redirect: "manual"` を指定する（`/v1/responses` と `/upstream/*` 共通）。
- `/upstream/*` では upstream の `304 Not Modified` を redirect とみなさず、
  サニタイズ後の response headers と status を pass-through し、downstream body は空にする。
  `If-None-Match` と `If-Modified-Since` は denylist に含めず、upstream へ保持・転送する。
- `/upstream/*` では `300`、`301`、`302`、`303`、`305`、`306`、`307`、`308` を含む
  `304` 以外のすべての 3xx を追加 fetch せず、`502` と
  `{"error":"upstream_redirect_not_allowed"}` に変換する。upstream の status、response
  headers（`Location` を含む）、body は downstream へ返さない。
- `/v1/responses` では既存互換のため、3xx の status、サニタイズ後の response headers
  （`Location` を含む）、body を pass-through する。relay 自身は追加 fetch を行わないが、
  この legacy exception を generic route に適用してはならない。
- generic route の `Location` が absolute cross-origin、absolute same-provider、relative
  のいずれであっても拒否する。`307` / `308` でも、元の POST body は最初の upstream
  request に 1 回だけ送られ、relay は redirect 先へ再送しない。
- router は runtime が提供する raw request-target を URL normalization 前に取得し、最初の `?`
  で path と query を分離してから path suffix の containment を検証する。raw request-target を
  取得できない、または normalization 前の値と一致することを証明できない場合は `404 Not Found`
  として upstream fetch を行わない。`/./`、`/../`、percent-encoded dot segment、encoded
  separator を含む suffix は URL constructor による解決結果ではなく raw path 上で拒否する。
- SSE 応答の場合、120 秒のアイドルタイムアウトを適用
- upstream fetch の header timeout は応答ヘッダー受信時に停止し、SSE idle timeout は
  その時点から開始して各 body chunk の受信ごとにリセットする。header timeout が
  進行中の SSE stream を終了させてはならず、client abort signal は両 timer から独立して
  upstream fetch と response body へ伝播する。
- クライアント切断時に upstream fetch および response body を abort

## 5. Tools スキーマ正規化

### 5.1 適用条件

- provider preset が provider-compatible route として定義したこと
- HTTP method が POST であること
- `Content-Type` を HTTP media type として解釈した type/subtype が `application/json` であること（パラメータ付き表記を許容し、type/subtype は大文字小文字非依存で比較する）
- ボディが JSON としてパース可能であること
- `body.tools` が配列であること
- 全体の `JSON.parse` → `JSON.stringify` ではなく、raw/token-preserving な変換を適用できること
- body byte size が `MAX_NORMALIZATION_BODY_BYTES = 4 * 1024 * 1024`（4 MiB）以下であること。これは
  platform limit ではなく、認識済み normalization route のアプリケーションメモリ予算であり、
  運用環境の環境変数で引き上げてはならない。単一の正しい decimal `Content-Length` が上限を
  超える場合だけ、body を読み切らず `413` を返す。その他の認識済み body は、
  `Content-Length` の有無・妥当性にかかわらず inbound `ReadableStream` を byte counter 付きで
  読み、実際の累計が上限を超える次の chunk を検出した時点で reader を cancel し、部分 body を
  upstream へ渡さない。上限ちょうどは許可し、`4 MiB + 1` byte は拒否する。実 body の byte
  counter の結果を常に正とし、`Content-Length` は超過の早期拒否にだけ使用する。
- 認識済み normalization route の body は、body buffering 前に有限の normalization slot を取得し、
  `request.signal` と固定の `NORMALIZATION_BODY_TIMEOUT_MS = 30_000`（30 秒）を reader の読み取りへ
  伝播する。client abort または body timeout では reader を cancel し、upstream fetch 前に slot を
  解放して終了する。既知の `Content-Length` による早期 `413` でも inbound reader を cancel する。
  parse failure、413、body timeout、client abort、upstream fetch error の全経路で slot を一度だけ解放する。
  正常系では counted reader と patch assembly が完了し、upstream request body が不要になった時点で
  解放する。upstream response の streaming concurrency を制限する場合は、normalization slot とは
  別の counter を使用する。

route pathname を API request shape の主な識別子とし、対象 schema member は次のように
固定する。

| route pathname | 認識する tool shape | 正規化対象 |
|---|---|---|
| `/upstream/<provider-slug>/v1/chat/completions` | OpenAI の `type: "function"`、`function` オブジェクト、`parameters` schema object | `tools[].function.parameters` |
| `/upstream/<provider-slug>/v1/messages` | Anthropic Messages の client tool shape（`name` と `input_schema` object） | `tools[].input_schema` |

provider preset は route を明示的な normalization policy に解決してから `schema.ts` に
渡す。normalizer は `anyOf`、`input_schema`、`function.parameters` 等の body member 名
だけから provider policy を推測してはならない。OpenAI policy では root `anyOf` の
safe flatten を許可するが、Anthropic policy では root `anyOf` を常に保持する。

OpenAI route で `input_schema` を、Anthropic route で `function.parameters` を検出した
だけでは変換しない。`input_schema` を持たない Anthropic server tool、上記以外の
route/method、および shape 不一致の `tools[]` 要素も変更しない。JSON body の parse
failure は provider-compatible envelope が定義された既知 route にだけ適用する。
未知 route/method または envelope 未定義 route は JSON parse せず、body を raw forward
する。

### 5.2 正規化ルール

各 route の対象 schema（`tools[].function.parameters` または
`tools[].input_schema`）に対し、以下を適用する。

- **JSON body の表現と数値保持**
  - リクエスト全体を ECMAScript の `JSON.parse` → `JSON.stringify` で再構築してはならない。各 JSON token の元の body byte span を保持する raw/token-preserving な表現で、対象となる schema の変更対象 span だけを置換する。
  - `tools` 以外のフィールド、正規化対象外のフィールド、およびそれらの JSON token（number を含む）は元の body bytes のまま保持する。
  - `Number.MIN_SAFE_INTEGER` から `Number.MAX_SAFE_INTEGER` の範囲外にある整数リテラルは ECMAScript `number` に変換せず、不透明な文字列表現としてコピーする。`9007199254740993` と `9223372036854775807` を丸めずに保持できることを必須とする。
  - 無損失な変換結果を保証できない場合は、部分的に再シリアライズした body を upstream に送らず、元の body bytes をそのまま転送して正規化をスキップする。
  - scanner は JSON の文字列状態、escape（escaped quote、backslash、`\u0000` 形式を含む）、および nesting を追跡し、文字列中の `{`、`}`、`[`、`]`、`,`、`:`、`"tools"` を JSON 構文や member path として誤認してはならない。`tools`、`function`、`parameters`、`input_schema` の member path は JSON string escape を解釈して判定するが、元の key token bytes は変更しない。
  - 認識済み route では、同一 object scope に `tools`、`tools[].function`、`tools[].function.parameters`、
    または `tools[].input_schema` の対象 member が重複している場合、effective member を推測せず
    route-specific な `400` JSON error（`duplicate_json_member`）を返し、normalization と upstream
    fetch を行わない。scanner の重複検出と normalizer の対象選択は同じ raw member spans を使用する。
  - body の位置情報は元の UTF-8 body bytes に対する byte offset とし、JavaScript の UTF-16 code-unit index と混同してはならない。複数の置換 span は元の body に対する位置で計算し、右から左へ適用するか、先行置換による長さ変化を後続位置へ正しく反映する。

1. **OpenAI route の `anyOf` 互換性変換（意図的な意味の狭め込み）**
   - `/v1/chat/completions` の `tools[].function.parameters` の root に `anyOf` が存在する場合、以下の条件をすべて満たすときのみ、各 branch の `properties` をルート直下にマージし、`anyOf` キーを削除する。
     1. すべての branch が `type: "object"` を持つこと。
     2. 各 branch が `properties` 以外の制約（`required`、`additionalProperties`、`enum`、`const`、条件付き制約等）を持たないこと。
     3. 異なる branch 間で同名の property key が存在しないこと。
     4. 各 branch の property の型・制約が互換であること。
     5. 対象 schema ルートの `type` が未定義または `"object"` であること。`"string"`、`"array"`、複合型の配列など、それ以外の値では flatten しないこと。
     6. 対象 schema ルートに、branch の評価と相互作用する object 制約（`properties`、`required`、`additionalProperties`、`patternProperties`、`unevaluatedProperties` 等）が存在しないこと。
   - **重要**: JSON Schema の `anyOf` は OR であるため、 flatten により property 間の AND 的制約に置き換わり、元 schema では valid な一部のインスタンス（例: 片方 branch の property 型が不正でも別 branch を満たすインスタンス）が invalid となる。本変換は JSON Schema 上の strict な意味保存ではなく、MCP サーバー（Greptile 等）が実際に生成する特定の anyOf パターンを対象プロバイダの strict バリデータに通すための互換策である。root と branch の object 制約が相互作用する場合を含め、条件を満たさない `anyOf` は flatten せず、そのまま残す。後勝ちマージによる silent semantic corruption は許容しない。
   - flatten を実施しないと決定した場合は、その対象 schema を **normalization skip** とし、後続の `type: "object"` / `properties: {}` 補完を含む対象 schema 全体の正規化を行わない。`anyOf`、その branch、schema 内の全 member、および対応する request body byte span は入力のまま保持する。flatten に成功した場合、または root `anyOf` が存在しない場合に限り、後続の `type` / `properties` 補完を適用できる。
   - 例えば、root `type` のない `{ "anyOf": [{ "type": "string" }, { "type": "object", "properties": { "query": { "type": "string" } } }] }` は flatten 不可である。ここに root `type: "object"` を追加すると元の string branch を無効化するため、`type` / `properties` を追加せず完全に無改変とする。

2. **Anthropic Messages route の `anyOf` 保持**
   - `/v1/messages` の `tools[].input_schema` に root `anyOf` が存在する場合、branch がすべて object であっても flatten しない。`anyOf`、その branch、schema 内の全 member、および対応する request body byte span を入力のまま保持する。
   - Anthropic route の root `anyOf` は、`type: "object"` / `properties: {}` の補完を含む対象 schema 全体の normalization skip とする。root `anyOf` がない schema では、既存の `type` / `properties` 補完を適用できる。

3. **`type: "object"` の保証**
   - root `anyOf` が存在しない、または安全な flatten に成功した対象 schema が空オブジェクト、もしくは `type` member が未定義/空文字列の場合：
      - `type` member が空文字列なら、その value span を `"object"` に置換する
      - `type` member が未定義なら `"type": "object"` を追加する
   - それ以外の既存 `type` は変更しない
   - flatten 不可として normalization skip になった対象 schema には、この補完を適用しない。

4. **空 `properties` の保持**
   - root `anyOf` が存在しない、または安全な flatten に成功した対象 schema の `properties` が未定義の場合：
      - `"properties": {}` を追加する
   - 既存の `properties` は保持する
   - flatten 不可として normalization skip になった対象 schema には、この補完を適用しない。

5. **その他フィールド**
   - `description` 等、`tools` 以外のフィールドには一切触れない。
   - `messages` 等、巨大なフィールドには一切触れない。
   - `required`、`additionalProperties`、`patternProperties`、`unevaluatedProperties` は、正規化前の値を保持する（anyOf flatten 適用外の場合）。

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
          { "type": "object", "properties": { "query": { "type": "string" } } },
          { "type": "object", "properties": { "limit": { "type": "integer" } } }
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

上記は 5.2 の条件を満たす「互換変換対象の `anyOf`」の例である。ただし、JSON Schema 上では `{"query": 123, "limit": 1}` のようなインスタンスが元 schema では valid だが、変換後の schema では invalid となるため、本変換は strict な意味保存ではなく、対象プロバイダの strict バリデータを通すための互換策である。

### 5.4 Anthropic Messages 形状の例

入力：

```json
{
  "model": "command-code",
  "max_tokens": 1024,
  "messages": [{"role": "user", "content": "hello"}],
  "tools": [{
    "name": "greptile_search",
    "input_schema": {
      "anyOf": [
        { "type": "object", "properties": { "query": { "type": "string" } } },
        { "type": "object", "properties": { "limit": { "type": "integer" } } }
      ]
    }
  }]
}
```

`POST /upstream/command-code/v1/messages` で上記を受けた場合は、Anthropic native
schema の意味を維持するため `tools[].input_schema` の root `anyOf` を flatten せず、
`anyOf`、branch、`name`、`messages`、その他の body bytes を変更しない。root `anyOf`
があるため `type` / `properties` 補完も行わない。`/v1/chat/completions` で同じ body を
受けた場合は Anthropic 形状として認識せず、`input_schema` を変更しない。

## 6. エラーハンドリング

| 状況 | ステータス | ボディ | 備考 |
|---|---|---|---|
| `RELAY_SECRET` 未設定/空 | `503` | `Service unavailable` | upstream fetch 前 |
| 認証ヘッダー欠落/不一致 | `401` | `{"error":"unauthorized"}` | upstream fetch 前 |
| 未知の provider slug | `404` | `Not Found` | upstream fetch 前 |
| upstream path の origin/pathname prefix containment 違反または検証不能 | `404` | `Not Found` | upstream fetch 前、fetch 0 回 |
| 既知 provider route のリクエストボディ JSON パース失敗（空 body / body なしを含む） | `400` | route-specific provider-compatible error envelope | `command-code` の `/v1/chat/completions` は OpenAI shape、`/v1/messages` は Anthropic shape。upstream fetch 前に返す |
| 既知 provider route の normalization body 上限超過 | `413` | route-specific provider-compatible error envelope | `MAX_NORMALIZATION_BODY_BYTES` を超えた時点で reader を cancel し、upstream fetch を実行しない |
| normalization slot 上限到達 | `503` | `{"error":"normalization_capacity_exhausted"}` | 最大 `16` slot を body buffering 前に非待機取得し、reader を消費せず upstream fetch 前に返す |
| normalization body timeout | `408` | `{"error":"request_body_timeout"}` | 固定 30 秒。reader を cancel し、upstream fetch 前に返す |
| 認識済み route の JSON member 重複 | `400` | route-specific provider-compatible error envelope | `duplicate_json_member` として normalization/upstream fetch 前に返す |
| envelope 未定義の route/method の malformed JSON | upstream へ raw forward | upstream の response | relay は JSON parse せず、universal な relay error envelope を生成しない |
| generic `/upstream/*` の upstream `304 Not Modified` | upstream の status | upstream の sanitized headers、空 body | `If-None-Match` / `If-Modified-Since` を保持し、追加 fetch なし |
| generic `/upstream/*` の upstream `304` 以外の 3xx（`300`、`301`、`302`、`303`、`305`、`306`、`307`、`308`） | `502` | `{"error":"upstream_redirect_not_allowed"}` | `Location`、upstream headers/body を返さず、追加 fetch なし |
| upstream 接続・ヘッダー応答タイムアウト | `504` | `{"error":"upstream_connect_or_header_timeout"}` | 既定 30 秒 |
| SSE アイドルタイムアウト | stream error | `upstream_sse_idle_timeout` | 既定 120 秒 |
| その他の upstream fetch エラー | 伝播または pass-through | - | - |

既知の `command-code` route で生成する JSON parse failure は、provider-compatible
error shape を使用する。`/v1/chat/completions` は OpenAI shape
`{"error":{"message":"Invalid JSON request body","type":"invalid_request_error","param":null,"code":null}}`、
`/v1/messages` は Anthropic shape
`{"type":"error","error":{"type":"invalid_request_error","message":"Invalid JSON request body"}}`
とする。どちらも secret、credential、request body の内容を含めず、upstream fetch
を実行しない。provider preset を追加する場合は、その provider の route-specific error
envelope を定義してから provider-compatible route として有効化する。envelope 未定義の
route/method は JSON parse せず body を raw forward し、universal な
`{"error":"invalid_json_body"}` は返さない。

既存 `/v1/responses` の upstream 3xx は後方互換のため、従来どおり status、サニタイズ
後の headers（`Location` を含む）、body を pass-through する。上記の `502` 契約は
新規 generic `/upstream/*` にだけ適用する。

## 7. 設定

### 7.1 環境変数

| 変数名 | 必須 | 説明 | 既定値 |
|---|---|---|---|
| `RELAY_SECRET` | ◯ | Gateway とリレー間の共通シークレットトークン | - |
| `UPSTREAM_HEADER_TIMEOUT_MS` | - | 上流初期応答タイムアウト（整数 milliseconds、`1` 以上 `3_600_000` 以下） | 30000 |
| `SSE_IDLE_TIMEOUT_MS` | - | SSE アイドルタイムアウト（整数 milliseconds、`1` 以上 `3_600_000` 以下） | 120000 |

`config.ts` の pure config loader は startup 時に両 timeout を parse する。環境変数が
`undefined` の場合だけ既定値を使用し、空文字列は未設定とはみなさない。前後の ASCII
whitespace を除去した値が `[1-9][0-9]*` に一致し、`1` 以上 `3_600_000` 以下の
finite integer milliseconds であることを要求する。`0`、負数、符号付き表記、小数、
`30s` 等の非数値、`NaN`、`Infinity`、上限超過値は設定エラーとする。

設定エラー時は default への silent fallback や `Number(raw) || default` を行わず、
`Deno.serve` を開始しない fail-closed 起動失敗とする。診断は変数名と理由だけを含め、
secret、credential、request body を含めない。`main.ts` は loader の結果を
`upstreamHeaderTimeoutMs` / `sseIdleTimeoutMs` として handler に明示的に dependency
injection し、handler は受け取った milliseconds を header timeout と SSE idle timeout
の実処理へ伝播させる。`RELAY_SECRET` 未設定時の既存 `503` 契約は変更しない。

`RELAY_SECRET` は既存互換契約を維持し、`undefined`、空文字列、または ASCII whitespace のみ
の場合は request-time に `503 Service unavailable` を返す。起動時に secret の値を診断へ出力したり、
空白を暗黙に除去した値へ変更したりしてはならない。timeout の設定エラーだけが `Deno.serve` を
開始しない fail-closed 起動失敗となる。

`MAX_NORMALIZATION_BODY_BYTES` は `4 * 1024 * 1024`（4 MiB）の固定実装値とする。上限超過時の
`/v1/chat/completions` response は
`{"error":{"message":"Request body exceeds maximum normalization size","type":"invalid_request_error","param":null,"code":"request_body_too_large"}}`、
`/v1/messages` response は
`{"type":"error","error":{"type":"invalid_request_error","message":"Request body exceeds maximum normalization size"}}`
とし、いずれも `Content-Type: application/json`、secret/credential/body 内容なし、upstream
fetch なしとする。未知 route/method または envelope 未定義 route はこの上限の対象外であり、
既存どおり raw forward する。

### 7.2 プリセットプロバイダ

| provider-slug | upstream base URL | クライアントからの path suffix 例 |
|---|---|---|
| `command-code` | `https://api.commandcode.ai/provider/` | `/v1/chat/completions`, `/v1/messages`, `/v1/models` |

upstream URL は、path suffix を URL reference として解決せず、preset base URL の pathname に path data として付加して構築する。`command-code` の base URL は `/provider/` で終わるため、relay route の `/upstream/command-code/` 以降には upstream API の完全な path を含め、例えば `/v1/chat/completions` を付加して `https://api.commandcode.ai/provider/v1/chat/completions` とする。

構築後の upstream URL は、preset base URL と同じ `origin` であり、preset の固定 pathname prefix（`command-code` では `/provider/`）配下であることを検証する。prefix の末尾 `/` は path segment boundary として扱う。`//` または `///` で始まる authority-like suffix、dot segment、percent-encoded dot segment、path segmentation を変え得る encoded separator、その他 containment を証明できない suffix は `404 Not Found` とし、provider の `Authorization` を付けた upstream fetch を実行しない。query string は incoming URL の `search` として分離して保持し、正常な値は変更せず upstream へ透過する。

標準 SDK と Gateway path の対応は次のとおりとする。Cloudflare Custom Provider の `base_url` は relay の固定 route prefix `https://<relay>/upstream/command-code/` とし、`custom-{slug}/` 以降の完全な provider path を relay へ渡す。

| クライアント | Gateway SDK base URL の終端 | SDK が付加する path | relay が受ける path |
|---|---|---|---|
| OpenAI SDK | `.../custom-command-code/v1` | `/chat/completions`、`/models` | `/upstream/command-code/v1/chat/completions`、`/upstream/command-code/v1/models` |
| Anthropic SDK | `.../custom-command-code` | `/v1/messages`、`/v1/models` | `/upstream/command-code/v1/messages`、`/upstream/command-code/v1/models` |
| raw HTTP client | `.../custom-command-code` | `/v1/...` | `/upstream/command-code/v1/...` |

未知の `provider-slug` へのリクエストは `404 Not Found` を返す。

## 8. 非機能要件

- **基盤プラットフォーム**: Deno Deploy
- **処理場所と CPU リスクの分離**: 大容量リクエストの JSON scan/transform は Deno Deploy relay で実行し、Cloudflare Workers Free の 10ms CPU 制限を relay の処理に持ち込まないこと。Deno Deploy の CPU 無制限を前提にせず、対象 plan/runtime の計測値と SLO で受け入れ判定する
- **メモリ予算**: 1 リクエストの process/heap high-water を、保守的なアプリケーション予算 512 MB 以内かつ対象 plan/runtime の上限に対する安全余裕を確保した状態で安定稼働させること。512 MB を Deno Deploy 共通の platform limit とは仮定しない
- **正規化の同時実行制御**: 正規化対象 body の最大 in-flight 数を `16` に固定し、body buffering 前に
  slot を非待機で取得すること。slot がない場合は reader を消費せず、`503
  {"error":"normalization_capacity_exhausted"}` を返す。body buffering、scan state、patch
  assembly を含む aggregate process/heap high-water が target runtime の予算内に収まることを
  benchmark で確認し、parse failure、413、body timeout、client abort、upstream error、response
  completion の全経路で slot を一度だけ解放すること。最大値は環境変数で上書きしない。
- **正規化 body のアプリケーション上限**: 認識済み provider-compatible JSON route の
  `MAX_NORMALIZATION_BODY_BYTES` を 4 MiB に固定する。4 MiB 以下での buffering、scan、patch
  assembly の process/heap high-water を target runtime で計測し、512 MB の保守的予算に対する
  安全余裕を確認する。4 MiB は platform limit ではない。
- **ゼロ外部依存**: Deno 標準 API のみで実装する
- **レイテンシオーバーヘッド SLO（初期値）**: 受信済み body bytes の scan/transform 開始から、upstream fetch を開始できる request body と header の準備完了までを計測区間とする。network 転送、upstream 待ち時間、cold start は含めない
- **SLO の測定条件**: body size 700 KiB、1 MiB、2 MiB、4 MiB、warm な Deno Deploy instance、単一同時実行で p95 を測定する。JSON scan/transform と header 処理を合わせた p95 は各サイズで 10ms 未満を初期目標とする。これは Cloudflare または Deno Deploy の platform limit ではなく、測定可能な product SLO である
- **同時実行 benchmark**: 4 MiB body で、少なくとも最大同時実行数まで並列に body、scan state、patch assembly を保持する条件を測定し、concurrency、aggregate process/heap high-water、admission control による拒否数を記録する。1 リクエストの 512 MB 予算だけで同時実行時の安全性を判定してはならない
- **benchmark の記録**: p50/p95/p99、body size、runtime/version、region、warm/cold 条件、concurrency、および process/heap high-water を記録する。SLO 判定は target Deno Deploy 環境で行い、ローカル実行結果だけで合否を決めない
- **ステートレス設計**: DB や永続状態を持たない
- **ログ**: 可観測性は Cloudflare AI Gateway に一元委託し、リレー側では機密ペイロードのログ出力を最小限に抑える

## 9. テスト戦略

### 9.1 schema_test.ts（新規）

以下をカバーする単体テストを作成する。OpenAI と Anthropic の schema member は、
route/request shape を混同しない別ケースとして扱う。

- `/v1/chat/completions` の `tools[].function.parameters` について、互換変換対象の `anyOf` のみ flatten（`properties` のみ、同名 key なし、branch-level 制約なし、root-level の相互作用する object 制約なし、すべての branch が `type: "object"`）
- `/v1/messages` の `tools[].input_schema.anyOf` は flatten せず、root `anyOf` がある場合は `type` / `properties` 欠落の補完も含めて byte-for-byte 無改変とする。root `anyOf` がない場合の補完と、既に有効な `input_schema` の無改変
- OpenAI route で `input_schema` を、Anthropic route で `function.parameters` を含む body を受けた場合に、誤って正規化しないこと
- 条件を満たさない root `anyOf` は、`type` / `properties` 補完を含む対象 schema の normalization 全体を skip し、対象 schema の UTF-8 byte span が完全一致することを検証する。対象 schema だけを含む fixture では request body bytes 全体も完全一致させ、複数 tool の fixture では安全な別 schema の独立した正規化を妨げないことも確認する。mixed `string | object`、branch-level `required` / `additionalProperties` 等、root-level の object 制約、および explicit な root `type` があるケースを含める
- `anyOf` 内の branch ごとに `required` が異なる場合は変換しない
- 同名 property が異なる type を持つ場合は変換しない
- `additionalProperties: false` を含む場合は変換しない
- root の `properties`、`required`、`additionalProperties`、`patternProperties`、`unevaluatedProperties` 等が `anyOf` と同じ schema object にある場合は変換しない
- `enum` / `const` 等の制約を含む場合は変換しない
- 条件を満たさない root `anyOf` を持つ対象 schema が、`type` / `properties` 補完を含む normalization 全体を skip し、対象 schema の byte span を変更せず silent semantic corruption なく通過すること
- **変換前後の validation 結果比較**: 5.3 の例に対し、変換前は valid だが変換後は invalid となるインスタンス（例: `{"query": 123, "limit": 1}`）を含め、flatten が OR を AND 的制約に置き換えることを検証する
- 5.3 に掲載された anyOf 例そのものをテストケース化し、入力・出力ともに期待通りであること
- `type` の補完（root `anyOf` なし、未定義 / 空文字列 / 空 schema object）を OpenAI / Anthropic の双方で検証し、空文字列では既存の `type` member が 1 つだけ残って `"object"` になることを確認
- root `type` が `"string"`、`"array"`、または複合型の配列の場合、anyOf の flatten と補完を行わず byte-for-byte 保持することを検証
- 空 `properties` の補完（root `anyOf` なし）を OpenAI / Anthropic の双方で検証
- 引数なしツールの正規化
- 既存の正しい schema は OpenAI / Anthropic の双方で無改変
- `messages`、別フィールド、`messages` 内の無関係な `input_schema` が残ること
- string 値内の `{`、`}`、`[`、`]`、`,`、`:` が構造 delimiter として誤認されないこと
- escaped quote、backslash、`\u0000` 形式の escape を含む string が正しく scan されること
- `messages` 内の文字列としての `"tools"` や JSON source が member path として誤認されないこと
- `\uXXXX` escape を含む JSON string と key を正しく処理し、semantic member path と raw key bytes の契約を満たすこと
- 日本語・emoji が対象 span より前にある body で、UTF-8 byte offset と UTF-16 code-unit index を混同しないこと
- 同一 body に複数の tools があり、1つ目の patch で body 長が増えても後続 patch が正しい span に適用されること
- minified JSON と whitespace-heavy JSON の両方で、変更対象外の raw bytes が完全一致すること
- top-level/provider field と `messages` 内の `9007199254740993`、および tool schema 内の `9223372036854775807` が丸められず、入力と同じ JSON number token で保持されること
- `-0`、指数表記、末尾ゼロを含む正規化対象外の number token が変換前後で変更されないこと
- scanner が valid JSON の token boundary を安全に確定できないと判定したケースでは、部分再シリアライズを行わず、元の body bytes がそのまま upstream に渡されて正規化がスキップされること。判定条件またはテスト用の failure injection を固定し、400 の JSON parse failure と混同しないこと
- `anyOf` 要素がオブジェクトでない場合は、`type` / `properties` 補完を含め無改変
- 空 `tools` 配列の場合の無改変
- 正規化対象 body の `MAX_NORMALIZATION_BODY_BYTES` が `4 * 1024 * 1024` bytes で固定され、
  body が上限ちょうどなら許可され、`4 MiB + 1` byte は `Content-Length` の事前判定で
  `413` となること。上限超過時の upstream fetch call count は `0` であること
- 単一の正しい `Content-Length` が上限以下でも、実 body は counted reader で検査し、実際の
  byte counter が上限を超える次の chunk で reader を cancel すること。欠落、不正、複数値の
  `Content-Length` も同じ counted reader を使うこと。部分 bodyを upstream へ送らず、secret、
  credential、body 内容を error response に含めないこと
- root `type` が `"string"`、`"array"`、または複合型の配列である anyOf は flatten と補完を
  行わず、対象 schema を byte-for-byte 保持すること
- `tools`、`tools[].function`、`tools[].function.parameters`、`tools[].input_schema` の
  重複 JSON member を route ごとに検出し、`duplicate_json_member` の `400`、normalization
  skip、upstream fetch call count `0` となること
- body buffering 前の normalization slot 上限 `16` を超えた場合、reader を消費せず
  `503 {"error":"normalization_capacity_exhausted"}` を返すこと。parse failure、413、body
  timeout、client abort、upstream error、body assembly 完了の各経路で slot が一度だけ解放され、
  後続 request が再利用できること
- `Content-Length` が上限以下でも実 body が超過する場合、超過 chunk で reader を cancel し、
  upstream fetch call count が `0` となること。固定 30 秒の slow body timeout と
  `request.signal` の abort が upstream fetch 前に reader を cancel すること

### 9.2 relay_test.ts（既存を拡張）

以下を追加する統合テストを作成する。

- `/upstream/command-code/v1/chat/completions` への転送と upstream URL 検証（`https://api.commandcode.ai/provider/v1/chat/completions` 完全一致）
- `/upstream/command-code/v1/messages` への転送と upstream URL 検証（`https://api.commandcode.ai/provider/v1/messages` 完全一致）
- `/upstream/command-code//attacker.example/collect` と `/upstream/command-code///attacker.example/collect` が `404` となり、attacker への fetch が発生しないこと
- `/upstream/command-code/../other`、`/upstream/command-code/./other`、および到達可能な percent-encoded dot segment/encoded separator が containment 違反として扱われ、異常ケースごとに upstream fetch call count が `0` であること
- raw request-target が取得不能、または normalization 前の値と一致しない場合に `404` となり、
  `/./`、`/../`、percent-encoded dot segment、encoded separator の各ケースで upstream fetch
  call count が `0` であること
- containment 検証に失敗する異常ケースで、`Authorization: Bearer <CMD_API_KEY>` が preset 外の target へ送られないこと
- 既存 `/v1/responses` の upstream mock に渡される `RequestInit.redirect === "manual"` の検証
- `/upstream/command-code/*` の upstream mock に渡される `RequestInit.redirect === "manual"` の検証
- generic `/upstream/*` の upstream mock が `300`、`301`、`302`、`303`、`305`、`306`、`307`、`308`（`Location` と body 付き）を返した場合に、`502` / `{"error":"upstream_redirect_not_allowed"}` へ変換し、`Location`、upstream headers、body を返さず、追加 fetch を行わないこと（各 status の upstream fetch call count は 1）
- generic `GET /upstream/command-code/v1/models` が `If-None-Match` または `If-Modified-Since` を upstream へ転送し、upstream mock の `304 Not Modified` の status、サニタイズ後の headers、空 body を downstream へ pass-through すること（upstream fetch call count は 1）
- generic `/upstream/*` で absolute cross-origin、absolute same-provider、relative の各 `Location` を拒否し、クライアントが Gateway 外へ follow できる `Location` を downstream に返さないこと
- generic `/upstream/*` の 307 POST で、元の body が最初の upstream request に一度だけ届き、redirect 先への二度目の request や認証 header の別 origin 送信がないこと
- legacy `/v1/responses` の upstream mock が 302 / 307 を返した場合に、既存互換どおり status・サニタイズ後の `Location` を含む headers・body を pass-through すること
- **GET `/upstream/command-code/v1/models` の転送**: upstream mock で以下を assert する
  - `method === "GET"`
  - body なし（または `null` / `undefined`）
  - URL === `https://api.commandcode.ai/provider/v1/models`
  - `Authorization: Bearer <CMD_API_KEY>` がそのまま届く
  - `X-Relay-Authorization` は upstream に届かない
- POST `/upstream/command-code/v1/chat/completions` において、`Content-Type` の media type が `application/json`（パラメータ付き・type/subtype の大文字小文字違いを含む）なら lossless body scan/transform で `tools[].function.parameters` の正規化が行われること
- POST `/upstream/command-code/v1/messages` において、Anthropic tool の `tools[].input_schema` の root `anyOf` が flatten されず、root `anyOf` がある場合は補完を含む対象 schema 全体が byte-for-byte 保持されること
- POST `/upstream/command-code/v1/chat/completions` に正しい `X-Relay-Authorization`、`Content-Type: application/json`、malformed JSON body を渡した場合、status `400`、OpenAI-compatible error envelope `{"error":{"message":"Invalid JSON request body","type":"invalid_request_error","param":null,"code":null}}`、upstream fetch call count `0` となること
- POST `/upstream/command-code/v1/messages` に正しい `X-Relay-Authorization`、`Content-Type: application/json`、malformed JSON body を渡した場合、status `400`、Anthropic-compatible error envelope `{"type":"error","error":{"type":"invalid_request_error","message":"Invalid JSON request body"}}`、upstream fetch call count `0` となること
- `Content-Type: application/json; charset=utf-8` および type/subtype の大文字小文字違いでも、malformed JSON body は route に対応する同じ provider-compatible envelope となり、upstream fetch call count が `0` であること
- POST + `application/json` の空 body（body なしを含む）は、route に対応する provider-compatible `400` envelope とし、upstream fetch call count が `0` であること
- provider-compatible envelope が未定義の `/upstream/command-code/v1/unknown` では malformed JSON を relay が parse せず、body を raw forward すること
- `text/plain` または不正な `Content-Type` では tools 正規化のための JSON パースを行わないこと
- GET `/upstream/command-code/v1/models` では body を JSON パースせず、そのまま転送されること
- HTTP method のそのまま転送（例: GET, POST）
- query string の保持
- `/provider/v1/v1/...` が生成されない回帰テスト
- 未知 provider slug での `404`
- `X-Relay-Authorization` 認証成功
- `Authorization: Bearer <RELAY_SECRET>` のみでは `/upstream/*` の relay auth に成功しないこと
- `Authorization: Bearer <CMD_API_KEY>` と `X-Relay-Authorization: Bearer <RELAY_SECRET>` が同時に存在すると認証成功
- upstream mock には `Authorization` の `<CMD_API_KEY>` がそのまま届く
- `X-Relay-Authorization` は upstream に届かない
- relay secret 不正/欠落時は upstream fetch 前に `401`
- `RELAY_SECRET` が `Authorization` として upstream へ漏れない
- リクエストボディの tools 正規化が upstream で確認できること
- string 内 delimiter/escape、`messages` 内の `"tools"`、`\u0000` escape、日本語・emoji、および minified/whitespace-heavy 表現を含む body で scanner が正しい member path と byte span を認識すること
- 複数 tools の body で、先行 patch による body 長の増加後も後続 patch が正しい tool schema に適用されること
- body を UTF-8 bytes として比較し、正規化対象 span 以外の bytes が入力と完全一致すること（JS object の deep equality だけで判定しない）
- unsafe integer を含む JSON body で tools の正規化を行っても、upstream で unsafe integer の number token が入力どおり保持されること
- 認識済み route の body が `4 MiB + 1` byte の場合、`Content-Length` の有無にかかわらず
  `413` とし、上流へ部分 body を送らず、reader の cancel が完了すること
- valid JSON でも scanner が token span を安全に確定できないと判定した body は、`400` にせず、部分的な再シリアライズなしに元の body bytes のまま upstream へ転送されること
- 既存 `/v1/responses` テスト（SSE、header timeout、SSE idle timeout、client abort、header sanitization を含む）の維持
- `/v1/responses` が `X-ChatGPT-Relay-Authorization` のみを受け付けること
- `/v1/responses` が `Authorization` / `X-Relay-Authorization` を受け付けないこと（推奨、省略可）

### 9.3 config_test.ts（新規）

`config.ts` の pure loader と production wiring を、次のケースで検証する。

- `UPSTREAM_HEADER_TIMEOUT_MS` / `SSE_IDLE_TIMEOUT_MS` が env 未設定の場合、それぞれ `30000` / `120000` になること
- 正の整数 override がその値の milliseconds として返ること
- `"0"`、負数、`"30s"` 等の非数値、小数、空文字列、`NaN`、`Infinity`、`3_600_000` 超過値が設定エラーになること
- `1` と `3_600_000` は有効であること
- invalid env で default に戻らず、startup が fail-closed になること
- valid override が `main.ts` の production dependency wiring を通じて handler の header timeout と SSE idle timeout の実 timer delay に伝播すること
- timeout の単位が milliseconds であり、値の丸め・暗黙の `0` 化・silent coercion がないこと

### 9.4 performance_test.ts（新規）

以下を target Deno Deploy 環境とローカルの比較用 benchmark で測定する。

- 700 KiB、1 MiB、2 MiB、4 MiB の body fixture を用意し、巨大な `messages` と変換対象の `tools` を同一 body に含めること
- body bytes が受信済みの状態から scan/transform、patch assembly、request header の準備完了までを計測し、network 転送、upstream fetch、cold start を計測区間から除外すること
- warmup 後の単一同時実行を基本条件とし、p50/p95/p99 と process/heap high-water をサイズごとに記録すること
- 各サイズの p95 が 10ms 未満という初期 SLO と、1 リクエストの memory high-water が 512 MB のアプリケーション予算以内であることを target 環境の acceptance で判定すること
- ローカル benchmark は実装比較と回帰検知に使い、Deno Deploy の plan/runtime/resource limit の代替証拠にはしないこと
- 大容量 fixture の raw bytes、unsafe integer、UTF-8 byte offset、複数 patch の無損失性は `schema_test.ts` と `relay_test.ts` の機能テストでも引き続き検証すること

### 9.5 protected acceptance（release gate）

- 既存 `acceptance_test.ts` の legacy `/v1/responses` 検証と、汎用 `command-code`
  acceptance は別のテスト群として実装する。後者は実 Cloudflare AI Gateway Custom
  Provider、実 Deno Deploy relay、実 Command Code Provider API を通る手動 workflow
  でのみ実行し、mock の統合テストを代替証拠としない。
- OpenAI の具体的な property-only root `anyOf` fixture
  `{"anyOf":[{"type":"object","properties":{"query":{"type":"string"}}},{"type":"object","properties":{"limit":{"type":"integer"}}}]}`
  を `tools[].function.parameters` に設定した request を Gateway へ送り、Command Code
  の実 provider validator を通過して成功することを確認する。Anthropic では同じ fixture
  を `tools[].input_schema` に設定し、`/v1/messages` が provider に受け入れられることを
  確認する。実際に relay が転送した body の root `anyOf` が保持されたことの証拠には、
  downstream payload capture または relay の統合テストを用い、2xx response だけで保持を
  推論してはならない。mock のみで provider acceptance 判定を代替してはならない。
- 汎用 acceptance は、OpenAI の
  `.../custom-command-code/v1/chat/completions`、Anthropic の
  `.../custom-command-code/v1/messages`、両 SDK の `/v1/models` に対応する request
  を送り、成功 response、provider-compatible malformed/empty JSON error envelope、
  path mapping、および upstream での credential 分離を確認する。
- `X-Relay-Authorization` は Custom Provider 設定の `headers` から注入され、標準
  `Authorization` は Command Code credential として upstream に届くことを確認する。
  Cloudflare API reference は `headers` を optional string として定義しているが、
  その serialization と secret forwarding を説明していないため、設定が実際に
  機能することを acceptance の必須条件とする。
- Gateway base URL、Gateway token、Command Code API key は protected Environment の
  variables/secrets から注入し、workflow のログへ出力しない。`RELAY_SECRET` は Cloudflare
  Custom Provider の protected header 設定に保存し、legacy direct acceptance 用にだけ
  `RELAY_ACCEPTANCE_RELAY_SECRET` として protected secret から認証ヘッダーへ注入する。
  generic acceptance が relay 経由で成功することも `RELAY_SECRET` の存在確認とし、relay が
  `401` を返す場合は release gate を fail させる。必須値が欠落した場合は skip しない。
- test runner の必須値は `RELAY_ACCEPTANCE_ORIGIN`、`RELAY_ACCEPTANCE_RELAY_SECRET`、
  `RELAY_ACCEPTANCE_GATEWAY_BASE_URL`、`RELAY_ACCEPTANCE_MODEL`、
  `RELAY_ACCEPTANCE_GATEWAY_TOKEN`、`RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY` とする。
  `RELAY_ACCEPTANCE_ORIGIN` は legacy relay の直接検証、Gateway base URL は
  `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}` 形式の実 Custom Provider
  経路に使用する。`RELAY_ACCEPTANCE_RELAY_SECRET` は legacy direct acceptance の
  認証ヘッダーにだけ使用し、test runner のログや request body に出力しない。

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

1. `apps/deno-relay/relay.ts` を `forward.ts` / `router.ts` / `chatgpt.ts` / `upstream.ts` / `schema.ts` / `config.ts` / `types.ts` に再編成
2. `main.ts` を新しい構成に対応させ、`config.ts` の検証済み timeout を dependency injection する
3. `schema_test.ts` と `config_test.ts` を新規作成
4. `relay_test.ts` を拡張し、generic の `304` pass-through、`304` 以外の 3xx 拒否、および legacy redirect 互換を分けて検証
5. 既存の `deno test apps/deno-relay` / `deno lint` / `deno fmt --check` がすべて通ることを確認
6. Deno Deploy 側で `RELAY_SECRET` を設定済みであることを確認し、timeout env は定義する場合に仕様の範囲内で設定する
7. Cloudflare AI Gateway の `command-code` Custom Provider の `base_url` を `https://<relay-domain>.deno.dev/upstream/command-code/` に変更
8. Cloudflare API reference の Custom Provider `headers` field の現行仕様に従って、`command-code` provider にリレー認証用ヘッダー `X-Relay-Authorization: Bearer <RELAY_SECRET>` を設定する。標準 `Authorization` ヘッダーは Command Code API key（`Authorization: Bearer <CMD_API_KEY>`）として Cloudflare から relay を経由して上流へ透過される。serialization と secret forwarding が実環境で確認できない場合は provider を有効化しない。
9. `protected-acceptance` workflow で実 Cloudflare AI Gateway → Deno Deploy → Command Code の OpenAI/Anthropic/models path、provider-compatible error envelope、header injection、Gateway log 作成を確認する。必須 Environment variables/secrets が未設定の場合は skip せず fail させる。
10. 既存 `chatgpt-codex-deno` provider は `base_url` を変更せず継続利用
