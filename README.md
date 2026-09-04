# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

二者は実行時ライブラリを共有しません。結合は文書化された HTTP contract です。既存の ChatGPT Custom Provider は `X-ChatGPT-Relay-Authorization` ヘッダー付きで relay の `POST /v1/responses` に到達し、汎用 provider は `X-Relay-Authorization` ヘッダー付きで `/upstream/<provider-slug>/*` に到達します。実行時依存は、plugin 側が `semver` のみ、relay 側がゼロです。

Deno Deploy の application directory はリポジトリルートです。entrypoint はルート `deno.json` の `deploy.runtime.entrypoint` で `./apps/deno-relay/main.ts` に固定し、Deno Deploy dashboard の自動推測に依存しません。

## 経路

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

プラグインはルーティングと Gateway ヘッダー層です。Cloudflare AI Gateway が唯一の可観測性平面（observability plane）です。relay は極小の egress トランスポートです。Gateway または relay が失敗しても、どの経路も ChatGPT に直接 fallback しません。

ビルトインの OpenCode `cloudflare-ai-gateway` provider はこの経路の外です。そのネイティブな `openai/*` / `anthropic/*` passthrough は Cloudflare API token および Unified Billing / BYOK traffic 用であり、ChatGPT OAuth Codex transport は再利用しません。ChatGPT subscription traffic はビルトイン `openai` provider と本プラグインの最終リクエスト interposer によってのみルーティングされ、`cloudflare-ai-gateway` を選択したり、純粋な Codex model ID を `openai/*` / `anthropic/*` に書き換えたりしてはなりません。

## プラグイン設定

| 設定項目 | 解決順序 | 備考 |
| -------- | -------- | ---- |
| Account ID | `CLOUDFLARE_ACCOUNT_ID`（必須） | 環境変数のみ |
| Gateway ID | `CLOUDFLARE_GATEWAY_ID`（必須） | 環境変数のみ |
| Gateway token | `CLOUDFLARE_API_TOKEN` → `CF_AIG_TOKEN` → プラグイン `apiKey` | ChatGPT Custom Provider 経路では Gateway 内で停止。upstream には到達しません（この保証はビルトイン `cloudflare-ai-gateway` provider の Workers AI 経路には適用されません。同経路は設計上 Cloudflare token を upstream へ転送する場合があります） |
| Relay token | `CLOUDFLARE_CHATGPT_RELAY_TOKEN` → プラグイン `relayToken` | relay でのみ検証され、ChatGPT には到達しません |
| Provider slug | `CLOUDFLARE_CHATGPT_PROVIDER_SLUG` → プラグイン `providerSlug` → 既定 `chatgpt-codex-deno` | Gateway URL のみで使用 |
| Log payload 収集 | `CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD`（`true` / `false` のみ） → プラグイン `collectLogPayload`（boolean） → 既定 `true` | `false` はそのまま出力。不正値は一致リクエストの設定エラー |
| Gateway base URL | 本番 `https://gateway.ai.cloudflare.com`。`CLOUDFLARE_AIG_BASE_URL` は `CLOUDFLARE_AIG_TEST_MODE=true` かつ許可 origin `https://gateway.test.invalid` の場合のみ上書き可 | 上記条件を満たさない場合は一致リクエストの設定エラー |

プラグイン設定は `opencode.json` の `plugin` 配列でオブジェクト形式（`["パッケージ名", { オプション }]`）で渡します。

Log payload 収集の既定 `true` は payload 保持を有効化する、プライバシーに関わる明示的なデフォルトです。プラグイン設定 `collectLogPayload` は boolean 値であり、任意の文字列から強制変換してはなりません。不正値は credential や request payload を含まない形で報告されます。

## パスマッピング

Custom Provider の `base_url` には relay の origin のみを指定します（`/v1` を含めません）。Gateway URL は次の形式で、relay の `POST /v1/responses` に対応します。

```text
{base}/v1/{account}/{gateway}/custom-{slug}/v1/responses
```

汎用 provider の Custom Provider では、provider の base URL を relay の固定 route に
向けます。`command-code` の例では次の形式です。

```text
https://<relay-domain>.deno.dev/upstream/command-code/
```

OpenAI SDK は `/v1/chat/completions`、Anthropic SDK は `/v1/messages` をこの route
suffix として送信します。relay は suffix を `command-code` の固定 upstream
`https://api.commandcode.ai/provider/` 配下へ path data として付加し、任意の origin
へ解決しません。

## プラグインのリクエスト処理

interposer は OpenCode バージョン判定に成功した後にプロセスごとに 1 回だけ導入され、導入時点で有効だった fetch 関数へ委譲します。次の正確なリクエストのみを intercept します。

```text
POST https://chatgpt.com/backend-api/codex/responses
```

`auth.openai.com`、`api.openai.com`、その他の `chatgpt.com` traffic、および ChatGPT OAuth login/refresh traffic は無変更で通過します。

一致したリクエストに対して、プラグインは以下を行います。

1. 必須の Gateway と relay 設定を検証
2. URL のみを次の Gateway URL に書き換え（7 つの制御ヘッダーを付与）
3. `Authorization`、`ChatGPT-Account-Id`、residency header、その他 Codex ヘッダーを維持
4. 制御ヘッダー追加:
   - `cf-aig-authorization: Bearer <Gateway token>`
   - `X-ChatGPT-Relay-Authorization: Bearer <relay token>`
   - `cf-aig-collect-log: true`
   - `cf-aig-collect-log-payload: <true|false>`
   - `cf-aig-metadata: {"source":"opencode","auth_type":"chatgpt_subscription","plugin":"cloudflare-ai-gateway-chatgpt"}`
   - `cf-aig-skip-cache: true`
   - `cf-aig-max-attempts: 1`
5. オリジナルの method、body stream、abort signal でオリジナルの fetch を呼び出し（body を読み取らず、シリアライズもしない）
6. 結果の `Response` を無変更で返却（SSE も解析・バッファリング・再構築しない）

body は純粋な model ID、`store`、`stream`、`input`、tool 定義、その他 OpenCode 生成コンテンツを変更なしに維持します。

metadata は固定の 3 項目のみを出力します。agent、session、account ID、OAuth credential、relay credential、prompt、response 内容は一切 metadata に追加されません。

## Relay のリクエスト処理

relay は次の二つの経路を受け付けます。その他の route は `404` を返します。

- 既存互換: `POST /v1/responses`。`X-ChatGPT-Relay-Authorization: Bearer <RELAY_SECRET>` を使用します。
- 汎用経路: `/upstream/<provider-slug>/*`。`X-Relay-Authorization: Bearer <RELAY_SECRET>` を使用します。標準 `Authorization` は provider credential として扱います。

relay は Deno Deploy secret から設定された正確な bearer 値を要求し、認証情報の欠落または不正があれば `401` を upstream fetch の前に返します。ただし、relay secret 自体が未設定の場合は `503` を返します。

認証後、既存互換経路は固定 upstream へリクエストを転送します。

```text
https://chatgpt.com/backend-api/codex/responses
```

リクエスト body stream は解析・バッファリングせずそのまま転送します。OAuth `Authorization`、`ChatGPT-Account-Id`、residency、その他 Codex protocol ヘッダーを保持します。転送前に次のヘッダーを除去します。

- `cf-aig-*`
- `cf-*`
- `x-forwarded-*`
- `forwarded`
- `x-real-ip`
- `X-ChatGPT-Relay-Authorization`
- `host`
- `content-length`
- `connection`
- `keep-alive`
- `proxy-authenticate`
- `proxy-authorization`
- `te`
- `trailer`
- `transfer-encoding`
- `upgrade`

さらに、リクエストの `Connection` ヘッダーを case-insensitive な comma-separated token list として解析し、そのリストに挙げられた各ヘッダーも除去します。応答ヘッダーについても同様に `Connection` とその token に挙げられた名前、および標準 hop-by-hop ヘッダーを除去します。残りの upstream 応答ヘッダー、status、body stream は保持されます。

汎用経路では、provider preset が provider-compatible route として定義した route policy に
解決した `POST` かつ `Content-Type` の media type が `application/json` の場合に限り、body
の raw/token-preserving scan で route policy に対応する tool schema を正規化します。
normalizer は body member 名から provider policy を推測しません。OpenAI の
`/v1/chat/completions` では `tools[].function.parameters`、Anthropic の
`/v1/messages` では `tools[].input_schema` のみを対象とし、別の route/request shape
は変更しません。`messages` 等の対象外フィールドと JSON number token は保持します。

root `anyOf` の compatibility flatten は OpenAI の `/v1/chat/completions` にだけ適用します。
Anthropic の `/v1/messages` では `tools[].input_schema` の root `anyOf` とその branch を
変更しません。root `anyOf` が存在する対象 schema は、`type: "object"` や
`properties: {}` の補完を含む正規化全体をスキップして、対象 schema の request body byte
span を入力のまま保持します。OpenAI route で flatten できない `anyOf` も同じ扱いです。
同じ body 内にある別の安全な OpenAI 対象 schema の正規化は妨げません。root `anyOf` が
ない場合、または OpenAI route で安全な flatten に成功した場合だけ、欠落した `type` や
`properties` を補完します。

認識済み provider-compatible JSON route の正規化 body には、
`MAX_NORMALIZATION_BODY_BYTES = 4 * 1024 * 1024`（4 MiB）の固定上限があります。
正しい `Content-Length` が上限を超える場合は body を読み切らず、欠落・不正・複数値の
`Content-Length` では counted reader が上限超過を検出した時点で reader を cancel し、
route-specific な `413` JSON error を返します。部分 body を upstream へ送ることは
ありません。legacy `/v1/responses`、未知 route/method、normalization policy 未定義の
route はこの buffering 上限の対象外で、従来どおり raw streaming されます。

provider preset が malformed JSON の envelope を定義した既知 route では、`POST` かつ
`Content-Type` の media type が `application/json` の body を解析できない場合、route-specific
な provider-compatible `400` envelope を upstream fetch 前に返します。`/v1/chat/completions` は OpenAI shape
`{"error":{"message":"Invalid JSON request body","type":"invalid_request_error","param":null,"code":null}}`、
`/v1/messages` は Anthropic shape
`{"type":"error","error":{"type":"invalid_request_error","message":"Invalid JSON request body"}}`
です。空 body も同じ扱いとし、universal な `{"error":"invalid_json_body"}` は返しません。
未知の pathname、method、または malformed JSON envelope が未定義の route では、relay は
JSON parse を行わず body を raw forward します。その route を provider-compatible endpoint として
公開するには、provider preset に route と envelope を先に定義する必要があります。
既存の `/v1/responses` はこの解析を行いません。

汎用経路の upstream `401`、`403`、`429`、`5xx` および通常の response は pass-through
します。upstream の `304 Not Modified` も redirect ではないため、status、サニタイズ後の
headers、body を pass-through します。`If-None-Match` と `If-Modified-Since` は denylist
に含めず、upstream へ保持・転送します。`304` 以外の `3xx`（`300`、`301`、`302`、`303`、
`305`、`306`、`307`、`308`）は、absolute cross-origin、absolute same-provider、relative
な `Location` を問わず `502 {"error":"upstream_redirect_not_allowed"}` に変換し、
`Location`、upstream headers/body、追加 fetch を downstream へ返しません。既存
`/v1/responses` は後方互換のため、従来どおり 3xx の status、サニタイズ後の headers
（`Location` を含む）、body を pass-through します。relay には retry loop、cache、
payload persistence、または credential/payload のアプリケーションログはありません。

### タイムアウトとキャンセル

- **30 秒の connect-and-response-header タイムアウト**: upstream `fetch` の直前に開始し、DNS、TCP/TLS connection、および完全な upstream 応答ヘッダーの受信をカバーします。期限切れの場合、upstream request を abort し、正確な JSON body `{"error":"upstream_connect_or_header_timeout"}` で `504` を返します。
- **120 秒の SSE idle タイマー**: upstream ヘッダー受信後に開始し、upstream body chunk を受信するたびにリセットします。総時間ではありません。期限切れの場合、upstream request を abort し、`upstream_sse_idle_timeout` stream error で downstream stream を終了します。応答ヘッダーは既に送信済みのため、2 番目の HTTP status や body に置き換えることはありません。非 SSE 応答には relay による総時間制限はありません。
- **inbound abort signal**: inbound request の abort signal を upstream fetch signal に連結します。OpenCode client が upstream ヘッダー到達前に切断/キャンセルした場合、upstream fetch を abort し応答を送信しません。ストリーム開始後に切断した場合、upstream response body をキャンセルし downstream stream を閉じます。これらのキャンセル経路は fallback や retry を一切引き起こしません。
- **timeout env validation**: `UPSTREAM_HEADER_TIMEOUT_MS` と `SSE_IDLE_TIMEOUT_MS` は起動時に検証します。未設定時はそれぞれ `30000` / `120000`、空文字列や `0`、負数、非数値、小数、上限超過値は設定エラーです。有効値は前後の ASCII whitespace を除去した 1 以上 `3_600_000` 以下の整数 milliseconds とし、不正値では default に戻らず `Deno.serve` を開始しない fail-closed 起動失敗とします。

### Protected acceptance

`.github/workflows/acceptance.yml` の `protected-acceptance` environment から、実 Cloudflare
AI Gateway Custom Provider、実 Deno Deploy relay、実 Command Code Provider API を通る
acceptance を手動実行します。必須値は次のとおりです。

- `RELAY_ACCEPTANCE_ORIGIN`: legacy relay の直接検証先
- `RELAY_ACCEPTANCE_GATEWAY_BASE_URL`: `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}`
  形式の Gateway base URL
- `RELAY_ACCEPTANCE_MODEL`: Command Code の検証用 model ID
- `RELAY_ACCEPTANCE_GATEWAY_TOKEN`: Gateway token secret
- `RELAY_ACCEPTANCE_COMMAND_CODE_API_KEY`: Command Code API key secret

acceptance は `tools[].function.parameters` に次の safe root `anyOf` を含む OpenAI
`/v1/chat/completions` request と、同じ schema を `tools[].input_schema` に含む Anthropic
`/v1/messages` request を実providerへ送信します。OpenAI route は validator を通過し、
Anthropic route は root `anyOf` を保持したまま成功することを確認します。両 route の
malformed/empty JSON envelope、`/v1/models`、path mapping、credential separation も
確認します。必要な変数またはsecretが未設定の場合、workflowはskipせず失敗します。

## サポート対象バージョンとフェイルクローズ

- サポート範囲は `packages/opencode-plugin/package.json` の `peerDependencies.opencode`（現行 `>=1.19.0 <2`）を正とします。公開リリースのドキュメントも同じ範囲を明記します。
- OpenCode がホストバージョン能力を公開していない場合、プラグインは activate を拒否し、interposer を導入しません。該当 Codex リクエストはフェイルクローズし、直接 ChatGPT へ迂回することはありません。
- activate の拒否は設定エラーであり、ChatGPT へ直接送信する許可ではありません。拒否だけでは interposer 未導入時の一致 Codex リクエストを防げないため、この保証には activate 拒否時に一致する Codex traffic をホスト側が block する能力が必要です。
- 必須設定がない場合も、対象 endpoint のリクエストだけがエラーになり、直接 ChatGPT へ迂回することはありません。
- npm 公開は、activate 拒否時に一致する Codex traffic をホスト側が block する能力（およびホストバージョン能力）が OpenCode 側で提供されるまで blocked です。

## セキュリティと失敗セマンティクス

- Refresh token は OpenCode から一切離れません。本リポジトリのどちらの deliverable も OAuth credential を実装・保存しません。
- Access token は Gateway と relay を通過して upstream 認証としてのみ使用されますが、ログ、保存、metadata、エラーメッセージには含まれません。設定エラーを含む診断メッセージに、credential や request payload は一切含まれません。
- Gateway token と relay token は異なる credential です。プラグインの ChatGPT Custom Provider 経路では、Gateway token は Cloudflare で停止し、relay token は relay で停止します。relay は転送前に `cf-aig-*` と `cf-*` ヘッダーを除去します。
- Gateway 失敗、relay 失敗、DNS/connection 失敗、タイムアウト、およびすべての ChatGPT upstream エラーは OpenCode に返却されます。direct fallback は試みられません。

## 開発

```bash
deno test apps/deno-relay               # relay のテスト
deno lint                                # lint
deno fmt --check                         # フォーマット検査
cd packages/opencode-plugin
npm ci --legacy-peer-deps                 # plugin 依存
npm run typecheck && npm test && npm run build # plugin 型検査・テスト・ビルド
```

## 自動リリース

`master` への push で release workflow が起動します。release-please は、
`packages/opencode-plugin` に影響する releasable な Conventional Commit
（`feat`、`fix`、`deps`、破壊的変更など）がある場合にのみ、plugin の
release PR を作成または更新します。`apps/deno-relay` のみの変更や、既定で
リリース対象外のコミット（`chore`、`build` など）では plugin release PR は
作成されません。release PR のマージ後に GitHub Release 作成と GitHub
Packages への公開を行い、公開には workflow 権限の `GITHUB_TOKEN` を使用します。

plugin の初回 `0.1.0` 公開は、下記チェックリストの手順に従います。GitHub
Packages の npm registry を利用する場合は、次の手順で利用者用の GitHub
PAT (classic) を準備してください。

1. GitHub の **Settings > Developer settings > Personal access tokens >
   Tokens (classic)** から PAT (classic) を作成し、パッケージのインストールには
   `read:packages` 権限を付与します。
2. 実トークンをリポジトリへ保存せず、環境変数
   `GITHUB_PACKAGES_TOKEN` に設定します。
3. 利用者の `~/.npmrc` またはローカルの `.npmrc` に、トークン値を
   含めない次の設定を追加します。

   ```ini
   @yohi:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
   ```

この手順は利用者向けの認証設定です。`.npmrc` やその他のファイルに PAT の実値を
保存したり、リポジトリへコミットしたりしないでください。

## リリースチェックリスト（GitHub Packages）

1. [ ] OpenCode が `PluginInput` でホストバージョン能力を公開したリリースが出ていること。さらに activate 拒否時にホスト側が一致する Codex リクエストを block できること（拒否だけでは direct request を防げない）。
2. [ ] `SUPPORTED_OPENCODE_RANGE` と `peerDependencies.opencode` を実際の能力提供バージョンに更新し、`test/package-consistency.test.ts` を通すこと。
3. [ ] 保護付き acceptance suite（実 Cloudflare / Deno Deploy / ChatGPT OAuth / Command Code 認証情報）を `protected-acceptance` 環境で実行し、legacy の 200 SSE、tool call、reasoning、token refresh、代表エラー、両ログペイロードモードに加え、固定の safe root `anyOf` fixture を使った generic `command-code` の OpenAI/Anthropic/models path、provider-compatible error envelope、header injection、Gateway log 作成、パスマッピングを確認すること。`MAX_NORMALIZATION_BODY_BYTES` の上限超過契約も実装テストで確認し、必須値が未設定の場合は skip せず fail させること。
4. [ ] README のサポート範囲表記を更新すること。
5. [ ] 初回の手動公開前に、`write:packages` 権限を持つ GitHub PAT
   (classic) で GitHub Packages registry に認証すること。その後、
   `packages/opencode-plugin` で `npm publish --ignore-scripts` を実行すること。

## スコープ外

- OAuth、token refresh、account extraction、model catalog、model rewriting、retry、cache、quota parsing、SSE reconstruction
- ChatGPT への direct fallback や、プリセット外の provider へ任意の URL を転送する generic proxy 動作
- `octg` 統合や変更
- Custom Provider または Deno Deploy provisioning の自動化
- ChatGPT OAuth traffic に対する OpenCode ビルトイン Cloudflare AI Gateway ネイティブ passthrough の使用
- ネイティブ custom Codex endpoint 統合（OpenCode が正式に対応する場合に fetch interposer を置き換える可能性がある）
