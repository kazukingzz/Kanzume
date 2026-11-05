# Kanzume

Workers + KV + R2 だけの小さなホスティング。ハッカソン向け。

Workers 用のコード（`export default { fetch }` + `wrangler.jsonc`）を書き換えずに、セルフホストした 1 つのコンテナへデプロイできます。管理画面は `/_admin/kanzume`（パスキーでログイン）です。

サイトはいくつでも置けて、wrangler の設定の `name` がサブドメインになります（`name = "blog"` → `blog.example.com`。管理画面で変更可）。DNS はドメイン本体とワイルドカード（`*.example.com`）を Kanzume に向けて、初回のパスキー登録時か管理画面の「設定 > ドメイン」で `example.com` を設定してください（管理画面はサイト以外のホスト、例えば `admin.example.com` でも開けます）。KV / R2 のデータはサイトごとに分かれます。最初にデプロイしたサイトはルートドメインでも配信します（管理画面で変更可）。

## 立てる

```sh
docker compose up -d
```

`/_admin/kanzume` を開き、起動ログ（`docker compose logs`）に出るセットアップトークンでパスキーを登録します。`KANZUME_ORIGIN`・`KANZUME_SETUP_TOKEN`・`KANZUME_PORT`（公開するポート、既定 8080）は `.env` か環境変数で渡せます。

compose を使わない場合:

```sh
docker build -t kanzume .
docker run -d -p 8080:8080 -v kanzume-data:/data kanzume
```

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

**Kanzume に git push**: 管理画面の「リポジトリ」で作ったリポジトリに push すると、`main` の内容を wrangler の設定どおりにデプロイします（GitHub は不要）。パスワードには `KANZUME_TOKEN` か、リポジトリごとに発行したトークン（read / write・期限付き）を使います。

```sh
git remote add kanzume https://example.com/_git/my-app.git
git push kanzume main
```

**GitHub の URL**: 管理画面の「サイトを追加」から、public リポジトリの URL を指定してデプロイできます。URL を入れると、サイト名（サブドメイン）・環境変数・シークレットを決める画面になります（デプロイ後も「サイト設定」で変えられ、再デプロイなしで反映されます）。サンプル（[`examples/worker`](examples/worker)・[`examples/portfolio`](examples/portfolio)）もそこからワンクリックで追加できます。git push と GitHub の URL からのデプロイは Kanzume の中でバンドルするので、npm パッケージの import・ビルドが必要なものは Actions を使ってください。

## 対応している機能

- ○ fetch ハンドラ（ES Modules / `WorkerEntrypoint`）、`ctx.waitUntil`、`vars`・シークレット（管理画面で設定）、Static Assets、KV、R2、Web 標準 API
- △ `nodejs_compat`（fs・net・child_process などは不可）
- × Cron Triggers / D1 / Durable Objects / Queues / WebSocket / HTMLRewriter / Service Worker 形式

Worker は `node:vm` で、Kanzume と同じプロセスの中で動かします。セキュリティ境界ではないので、デプロイできる人（全体の Token・リポジトリ用の write トークンを持つ人）は管理者と同等で、サーバー上のすべてにアクセスできます。ルートドメインで配信するサイトも管理画面と同じオリジンで動くので同様です。信頼できる相手にだけ渡してください。

## 環境変数

`PORT`（8080）、`KANZUME_DATA_DIR`（/data）、`KANZUME_ORIGIN`（ルートドメインの URL。管理画面の「設定 > ドメイン」より優先する。どちらもなければ管理画面を開いたホスト）、`KANZUME_SETUP_TOKEN`、`KANZUME_MAX_UPLOAD_MB`（50）、`KANZUME_REPO_QUOTA_MB`（git リポジトリ 1 つあたりの容量の上限、200）、`KANZUME_WORKER_IDLE_SEC`（600）、`KANZUME_CPU_TIMEOUT_MS`（5000）、`KANZUME_MAX_WORKERS`（同時にメモリに載せる Worker の数、5）、`KANZUME_LOG_RETENTION_HOURS`（72）、`KANZUME_SAMPLES_REPO`（管理画面のサンプルの取得元。fork したら自分のリポジトリの `https://github.com/<owner>/<repo>/tree/<branch>` にする）

## 開発

```sh
npm install
npm run dev
npm test
```

Node 24 の型ストリップで TypeScript をそのまま実行します（ビルド不要）。
