# Kanzume

Workers + KV + R2 だけの小さなホスティング。ハッカソン向け。

Workers 用のコード（`export default { fetch }` + `wrangler.jsonc`）を書き換えずに、セルフホストした 1 つのコンテナへデプロイできます。管理画面は `/_admin/kanzume`（パスキーでログイン）です。

サイトはいくつでも置けて、wrangler の設定の `name` がサブドメインになります（`name = "blog"` → `blog.example.com`）。DNS はワイルドカード（`*.example.com`）で Kanzume に向けてください。KV / R2 のデータはサイトごとに分かれます。最初にデプロイしたサイトはルートドメインでも配信します（管理画面で変更可）。

## 立てる

```sh
docker build -t kanzume .
docker run -d -p 8080:8080 -v kanzume-data:/data kanzume
```

`/_admin/kanzume` を開き、起動ログに出るセットアップトークンでパスキーを登録します。

## デプロイする

**GitHub Actions**: 管理画面に表示される `KANZUME_URL`（Variables）と `KANZUME_TOKEN`（Secrets）を登録して、次のワークフローを置きます。

```yaml
name: Deploy to Kanzume
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kazukingzz/Kanzume/action@main
        with:
          url: ${{ vars.KANZUME_URL }}
          token: ${{ secrets.KANZUME_TOKEN }}
```

**GitHub の URL**: 管理画面の「サイトを追加」から、public リポジトリの URL を指定してデプロイできます。サンプル（[`examples/worker`](examples/worker)・[`examples/portfolio`](examples/portfolio)）もそこからワンクリックで追加できます。npm パッケージの import・ビルドが必要なものは Actions を使ってください。

## 対応している機能

- ○ fetch ハンドラ（ES Modules / `WorkerEntrypoint`）、`ctx.waitUntil`、`vars`、Static Assets、KV、R2、Web 標準 API
- △ `nodejs_compat`（fs・net・child_process などは不可）
- × Cron Triggers / D1 / Durable Objects / Queues / WebSocket / HTMLRewriter / secrets / Service Worker 形式

Worker は `node:vm` で動かします。セキュリティ境界ではないので、デプロイできる人は信頼する前提です。

## 環境変数

`PORT`（8080）、`KANZUME_DATA_DIR`（/data）、`KANZUME_ORIGIN`（ルートドメインの URL。未設定ならアクセスされたドメイン。設定すると存在しないサブドメインを 404 にできる）、`KANZUME_SETUP_TOKEN`、`KANZUME_MAX_UPLOAD_MB`（50）、`KANZUME_WORKER_IDLE_SEC`（600）、`KANZUME_CPU_TIMEOUT_MS`（5000）、`KANZUME_MAX_WORKERS`（同時にメモリに載せる Worker の数、5）、`KANZUME_LOG_RETENTION_HOURS`（72）

## 開発

```sh
npm install
npm run dev
npm test
```

Node 24 の型ストリップで TypeScript をそのまま実行します（ビルド不要）。
