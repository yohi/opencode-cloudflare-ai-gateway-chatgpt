# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

## 経路

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

## プラグイン設定

- Account ID: 環境変数 `CLOUDFLARE_ACCOUNT_ID`（必須）
- Gateway ID: 環境変数 `CLOUDFLARE_GATEWAY_ID`（必須）
- Gateway token: `CLOUDFLARE_API_TOKEN` → `CF_AIG_TOKEN` →
  プラグイン `apiKey`
- Relay token: `CLOUDFLARE_CHATGPT_RELAY_TOKEN` →
  プラグイン `relayToken`
- Provider slug: `CLOUDFLARE_CHATGPT_PROVIDER_SLUG` →
  プラグイン `providerSlug` → 既定 `chatgpt-codex-deno`
- ログペイロード収集:
  `CLOUDFLARE_AIG_COLLECT_LOG_PAYLOAD`（`true` / `false` のみ）→
  プラグイン `collectLogPayload`（boolean）→ 既定 `true`
- Gateway base URL: 本番は `https://gateway.ai.cloudflare.com`。
  `CLOUDFLARE_AIG_TEST_MODE=true` かつ許可された origin
  `https://gateway.test.invalid` の場合のみ、
  `CLOUDFLARE_AIG_BASE_URL` で上書きできます。

プラグイン設定は `opencode.json` の `plugin` 配列でオブジェクト形式
（`["パッケージ名", { オプション }]`）で渡します。

## パスマッピング

Custom Provider の `base_url` には relay の origin のみを指定します（`/v1`
を含めません）。Gateway URL は次の形式で、relay の `POST /v1/responses` に対応します。

```text
{base}/v1/{account}/{gateway}/custom-{slug}/v1/responses
```

プラグインが書き換えるのは、次の ChatGPT Codex endpoint への `POST` だけです。
OAuth、`api.openai.com`、その他の `chatgpt.com` traffic は変更されません。

## サポート対象バージョンとフェイルクローズ

- サポート範囲は `packages/opencode-plugin/package.json` の
  `peerDependencies.opencode`（現行 `>=1.19.0 <2`）を正とします。
- OpenCode がホストバージョン能力を公開していない場合、プラグインは
  activate を拒否し、interposer を導入しません。
- 必須設定がない場合も、対象 endpoint のリクエストだけがエラーになり、
  直接 ChatGPT へ迂回することはありません。
- npm 公開は、OpenCode 側でホストバージョン能力が提供されるまで blocked です。

## BYOK 互換性

`@yohi/cloudflare-ai-gateway-byok` の互換リリース以降と組み合わせて使用してください。
BYOK は自ら生成したリクエスト以外の `Authorization` を削除しないことが契約です。
`packages/opencode-plugin/test/byok-contract.test.ts` が両ロード順を検証します。

## 開発

```bash
deno test apps/deno-relay               # relay のテスト
deno lint                                # lint
deno fmt --check                         # フォーマット検査
cd packages/opencode-plugin
npm ci --legacy-peer-deps                 # plugin 依存
npm run typecheck && npm test             # plugin 型検査・テスト
```

## リリースチェックリスト（npm 公開）

1. [ ] OpenCode が `PluginInput` でホストバージョン能力を公開したリリースが
   出ていること。
2. [ ] `SUPPORTED_OPENCODE_RANGE` と `peerDependencies.opencode` を実際の
   能力提供バージョンに更新し、`test/package-consistency.test.ts` を通すこと。
3. [ ] 保護付き acceptance suite（実 Cloudflare / Deno Deploy / ChatGPT OAuth
   認証情報）を `protected-acceptance` 環境で実行し、200 SSE、tool call、
   reasoning、token refresh、代表エラー、両ログペイロードモード、Gateway
   log 作成、パスマッピングを確認すること。
4. [ ] README のサポート範囲表記を更新すること。
5. [ ] 初回は `npm publish --access public` を実行すること。

設計詳細は `docs/superpowers/specs/2026-08-20-chatgpt-ai-gateway-design.md` を参照。
