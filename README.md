# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

二者は実行時ライブラリを共有しません。唯一の結合は文書化された HTTP contract（Gateway Custom Provider リクエストが `X-ChatGPT-Relay-Authorization` ヘッダー付きで relay の `POST /v1/responses` に到達すること）です。実行時依存は、plugin 側が `semver` のみ、relay 側がゼロです。

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

relay は `POST /v1/responses` のみを受け付けます。その他の route または method は `404` を返します。relay は Deno Deploy secret から設定された正確な bearer 値を要求し、認証情報の欠落または不正があれば `401` を upstream fetch の前に返します。ただし、relay secret 自体が未設定の場合は `503` を返します。

認証後、relay は固定 upstream へリクエストを転送します。

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

upstream の `401`、`403`、`429`、`5xx` 結果はそのまま pass-through です。SSE ストリーミング応答も pass-through です。relay には generic forwarding route、retry loop、cache、payload persistence、または credential/payload のアプリケーションログはありません。

### タイムアウトとキャンセル

- **30 秒の connect-and-response-header タイムアウト**: upstream `fetch` の直前に開始し、DNS、TCP/TLS connection、および完全な upstream 応答ヘッダーの受信をカバーします。期限切れの場合、upstream request を abort し、正確な JSON body `{"error":"upstream_connect_or_header_timeout"}` で `504` を返します。
- **120 秒の SSE idle タイマー**: upstream ヘッダー受信後に開始し、upstream body chunk を受信するたびにリセットします。総時間ではありません。期限切れの場合、upstream request を abort し、`upstream_sse_idle_timeout` stream error で downstream stream を終了します。応答ヘッダーは既に送信済みのため、2 番目の HTTP status や body に置き換えることはありません。非 SSE 応答には relay による総時間制限はありません。
- **inbound abort signal**: inbound request の abort signal を upstream fetch signal に連結します。OpenCode client が upstream ヘッダー到達前に切断/キャンセルした場合、upstream fetch を abort し応答を送信しません。ストリーム開始後に切断した場合、upstream response body をキャンセルし downstream stream を閉じます。これらのキャンセル経路は fallback や retry を一切引き起こしません。

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

## リリースチェックリスト（npm 公開）

1. [ ] OpenCode が `PluginInput` でホストバージョン能力を公開したリリースが出ていること。さらに activate 拒否時にホスト側が一致する Codex リクエストを block できること（拒否だけでは direct request を防げない）。
2. [ ] `SUPPORTED_OPENCODE_RANGE` と `peerDependencies.opencode` を実際の能力提供バージョンに更新し、`test/package-consistency.test.ts` を通すこと。
3. [ ] 保護付き acceptance suite（実 Cloudflare / Deno Deploy / ChatGPT OAuth 認証情報）を `protected-acceptance` 環境で実行し、200 SSE、tool call、reasoning、token refresh、代表エラー、両ログペイロードモード、Gateway log 作成、パスマッピングを確認すること。
4. [ ] README のサポート範囲表記を更新すること。
5. [ ] 初回は `npm publish --access public` を実行すること。

## スコープ外

- OAuth、token refresh、account extraction、model catalog、model rewriting、retry、cache、quota parsing、SSE reconstruction
- ChatGPT への direct fallback や generic proxy 動作
- `octg` 統合や変更
- Custom Provider または Deno Deploy provisioning の自動化
- ChatGPT OAuth traffic に対する OpenCode ビルトイン Cloudflare AI Gateway ネイティブ passthrough の使用
- ネイティブ custom Codex endpoint 統合（OpenCode が正式に対応する場合に fetch interposer を置き換える可能性がある）
