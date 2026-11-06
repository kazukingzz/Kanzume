# Kanzume

Workers + KV + R2 だけの小さなホスティング。ハッカソン向け。

Workers 用のコード（`export default { fetch }` + `wrangler.jsonc`）を書き換えずに、セルフホストした 1 つのコンテナへデプロイできます。管理画面は `/_admin/kanzume`（パスキーでログイン）です。

サイトはいくつでも置けて、wrangler の設定の `name` がサブドメインになります（`name = "blog"` → `blog.example.com`。管理画面で変更可）。DNS はドメイン本体とワイルドカード（`*.example.com`）を Kanzume に向けて、初回のパスキー登録時か管理画面の「管理者設定 > ドメイン」で `example.com` を設定してください（管理画面はサイト以外のホスト、例えば `admin.example.com` でも開けます）。KV / R2 のデータはサイトごとに分かれ、管理画面の「データベース」（KV のキーと値）と「ストレージ」（R2 のオブジェクト）タブで見たり、追加・編集・削除したりできます。最初にデプロイしたサイトはルートドメインでも配信します（管理画面で変更可）。

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

## メンバー

初回セットアップでパスキーを登録した人が管理者になり、全体の設定（ドメイン・バックアップ・メンバー）とすべてのサイトを扱えます。ほかの人は招待リンクから参加します（管理者設定でメンバーを管理者にすることもできます）。

サイトだけを任せたい人には、そのサイトの「サイト設定 > メンバー」で招待リンク（1 人 1 回・7 日間有効）を作って渡します。リンクからパスキーを登録した人はそのサイトのメンバーになり、そのサイトのデプロイ・設定・削除と、同じ名前のリポジトリを扱えます。GitHub Actions や git push には、各自が「設定 > トークン」で発行する個人トークン（参加しているサイトにだけ push・デプロイできる）を使います。

## バックアップ

`KANZUME_BACKUP_URL` に S3 互換ストレージ（Cloudflare R2・AWS S3・B2・MinIO）を指定すると、データ（サイト・KV・R2・パスキー・リポジトリ・ログ）を暗号化して外部に保存し、`/data` が空の状態で起動したときに最新の世代を自動で復元します（復元が終わるまでリクエストは受け付けません）。デプロイや設定の変更のあとと 1 時間ごとに、変わったファイルだけを送ります。未設定ならバックアップしません。

```sh
KANZUME_BACKUP_URL=s3://<ACCESS_KEY_ID>:<SECRET_ACCESS_KEY>@<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>[/<PREFIX>]
```

- R2 の API トークンは「Object Read & Write」で、対象をそのバケットだけに絞って作ります
- 鍵に `/` `+` `@` などが入るときはパーセントエンコードします
- クエリで `keep`（残す世代数、48）・`interval`（分、60）を変えられます。`file:///path` はローカルのディレクトリに保存します（開発用）
- 暗号化の鍵は SECRET_ACCESS_KEY から導出します。トークンを作り直したら、一度だけ `?previous=<旧 SECRET>` を付けて起動すると鍵が引き継がれ、以後は外して構いません

## デプロイする

管理画面の「サイトを追加」でサイト名（サブドメイン）を決めてサイトを作り、そのサイトの「デプロイ」タブで方法を選びます（デプロイ済みのサイトでも「新しくデプロイ」から選べます）。環境変数・シークレットはデプロイ前でも「サイト設定」で設定できます。

- **サンプルから**: [`examples/worker`](examples/worker)・[`examples/portfolio`](examples/portfolio) をそのままデプロイします。
- **GitHub の公開リポジトリから**: public リポジトリ（のディレクトリ）の URL を指定してデプロイします。
- **GitHub Actions から**: 「設定 > トークン」で発行した個人トークンを `KANZUME_TOKEN`（Secrets）、管理画面の URL を `KANZUME_URL`（Variables）に登録して、次のワークフローを置きます。wrangler の設定の `name` はサイト名にします。

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

- **サイトのリポジトリから**: サイトの「リポジトリ」タブで Kanzume 上にサイトと同じ名前の Git リポジトリを作り、`main` に push するとデプロイします（GitHub は不要）。パスワードには「設定 > トークン」で発行した個人トークンを使います。

```sh
git remote add origin https://example.com/_git/my-app.git
git push -u origin main
```

GitHub の URL とリポジトリからのデプロイは Kanzume の中でバンドルするので、npm パッケージの import・ビルドが必要なものは Actions を使ってください。

## 対応している機能

- ○ fetch ハンドラ（ES Modules / `WorkerEntrypoint`）、`ctx.waitUntil`、`vars`・シークレット（管理画面で設定）、Static Assets、KV、R2、Web 標準 API
- △ `nodejs_compat`（fs・net・child_process などは不可）
- × Cron Triggers / D1 / Durable Objects / Queues / WebSocket / HTMLRewriter / Service Worker 形式

Worker は `node:vm` で、Kanzume と同じプロセスの中で動かします。セキュリティ境界ではないので、デプロイできる人（サイトのメンバーと、その個人トークンを持つ人）は管理者と同等で、サーバー上のすべてにアクセスできます。ルートドメインで配信するサイトも管理画面と同じオリジンで動くので同様です。信頼できる相手にだけ渡してください。

## 環境変数

`PORT`（8080）、`KANZUME_DATA_DIR`（/data）、`KANZUME_ORIGIN`（ルートドメインの URL。管理画面の「管理者設定 > ドメイン」より優先する。どちらもなければ管理画面を開いたホスト）、`KANZUME_SETUP_TOKEN`、`KANZUME_MAX_UPLOAD_MB`（50）、`KANZUME_REPO_QUOTA_MB`（git リポジトリ 1 つあたりの容量の上限、200）、`KANZUME_WORKER_IDLE_SEC`（600）、`KANZUME_CPU_TIMEOUT_MS`（5000）、`KANZUME_MAX_WORKERS`（同時にメモリに載せる Worker の数、5）、`KANZUME_LOG_RETENTION_HOURS`（72）、`KANZUME_BACKUP_URL`（上記）、`KANZUME_SAMPLES_REPO`（管理画面のサンプルの取得元。fork したら自分のリポジトリの `https://github.com/<owner>/<repo>/tree/<branch>` にする）

## 開発

```sh
npm install
npm run dev
npm test
```

Node 24 の型ストリップで TypeScript をそのまま実行します（ビルド不要）。
