# opencode-cloudflare-ai-gateway-chatgpt

OpenCode の ChatGPT Codex 通信を Cloudflare AI Gateway 経由で観測可能にするリポジトリ。

## 構成

- `packages/opencode-plugin`: npm パッケージ `@yohi/cloudflare-ai-gateway-chatgpt`(実装予定)
- `apps/deno-relay`: Deno Deploy 固定アップストリーム egress relay

## 経路

```text
OpenCode built-in ChatGPT OAuth
  -> plugin fetch interposer
  -> Cloudflare AI Gateway Custom Provider
  -> Deno Deploy relay
  -> https://chatgpt.com/backend-api/codex/responses
```

## 開発

```bash
deno test        # relay のテスト
deno lint        # lint
deno fmt --check # フォーマット検査
```

設計詳細は `docs/superpowers/specs/2026-08-20-chatgpt-ai-gateway-design.md` を参照。
