# Kanzume

Workers + KV + R2 だけの小さな Cloudflare。ハッカソン向け。

Cloudflare Workers 用に書いたコード（`export default { fetch(request, env, ctx) }` + `wrangler.jsonc`）を書き換えずに、セルフホストした 1 つのコンテナへデプロイできます。Render の無料プラン（512MB RAM / 0.1 CPU）で動かすことを想定しています。

- 1 つの Kanzume に置けるサイトは 1 つで、ルート（`https://<Kanzume の URL>/`）で配信する
- 管理画面は `/_admin/kanzume`（パスキーでログイン）。予約パスは `/_admin/kanzume`・`/_api/`・`/_health` だけ
- まだ何もデプロイしていなければ、管理画面から GitHub の public リポジトリの URL を指定してデプロイできる
- GitHub Actions に必要なのは、管理画面に表示される URL と Token の 2 つだけ

## Render に立てる

1. このリポジトリを fork する
2. Render の **New > Blueprint** で fork したリポジトリを選ぶ（`render.yaml` で Docker の無料 Web Service が作られる）
3. デプロイが終わったら `https://<サービス名>.onrender.com/_admin/kanzume` を開く
4. Render の Environment に自動生成された `KANZUME_SETUP_TOKEN` を入力して、パスキーを登録する
5. 2 人目以降のメンバーは、ログイン画面の「サインアップ」で設定に表示されるチーム ID を入力してパスキーを登録する

> [!WARNING]
> Render の無料プランは 15 分アクセスがないとスリープし、起動し直すとディスクが消えます。デプロイしたサイト・KV / R2 のデータ・パスキー・チーム ID・Token はすべて消えるので、そのたびにパスキーの登録と Token の再設定、再デプロイが必要です。

自前のサーバーで動かす場合:

```sh
docker build -t kanzume .
docker run -d -p 8080:8080 -v kanzume-data:/data -e KANZUME_ORIGIN=https://kanzume.example.com kanzume
```

`KANZUME_SETUP_TOKEN` を渡さなかった場合は、起動ログに出るセットアップトークンを使います。

## GitHub の URL からデプロイする

まだ何もデプロイしていないときは、管理画面のデプロイのページに GitHub の public リポジトリの URL を入れる欄が出ます。

- `https://github.com/<owner>/<repo>`（デフォルトブランチのトップ）か、`https://github.com/<owner>/<repo>/tree/<ブランチ>/<ディレクトリ>` の形式
- 空のまま「デプロイ」を押すと、このリポジトリのサンプル `https://github.com/kazukingzz/Kanzume/tree/main/examples/worker` をデプロイする

wrangler と `npm install` をサーバーで動かすと Render の無料プランでは重すぎるため、Kanzume に同梱した esbuild で `main` をバンドルします。そのため次のリポジトリは GitHub Actions からデプロイしてください。

- npm パッケージを import している（`node:*` と `cloudflare:workers`、相対 import だけなら OK）
- `assets.directory` をビルドで作る（ビルド済みのファイルがリポジトリにコミットされていれば OK）
- `.wasm` を import している、`build.command` が必要

## GitHub Actions からデプロイする

管理画面に表示される値を、デプロイしたいリポジトリに登録します。

- Variables: `KANZUME_URL`
- Secrets: `KANZUME_TOKEN`

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to Kanzume
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # 静的アセットをビルドする場合はここで npm ci && npm run build など
      - uses: kazukingzz/Kanzume/action@main
        with:
          url: ${{ vars.KANZUME_URL }}
          token: ${{ secrets.KANZUME_TOKEN }}
```

Action がやること:

1. `node_modules` がなければロックファイルに合わせて依存をインストールする
2. `wrangler deploy --dry-run` でバンドルする（TypeScript や `nodejs_compat` の処理は wrangler に任せる）
3. バンドルを esbuild で CommonJS に変換する
4. wrangler の設定・バンドル・`assets.directory` を tar.gz にして `POST /_api/deploy` に送る

`wrangler.jsonc` / `wrangler.json` / `wrangler.toml` があるディレクトリが別の場所なら `working-directory` を指定してください。

サンプルは [`examples/worker`](examples/worker) にあります。同じコードを `wrangler deploy` で Cloudflare にもそのままデプロイできます。

Action はビルドログ・コミット情報・ソースマップから取り出した元のソースも一緒に送ります（`node_modules` 配下のソースは送りません）。ビルドに失敗した場合も失敗として記録されます。

## 管理画面

`/_admin/kanzume` のサイドメニューで次のタブを切り替えます。

| タブ | 内容 |
|---|---|
| デプロイ | 現在のデプロイ（コミット・ブランチ・実行者・Actions の実行ログへのリンク）と、過去 50 件のデプロイ履歴。各デプロイのビルドログと Kanzume 側のログを見られる。未デプロイなら GitHub の URL からのデプロイ |
| コード | デプロイ中のコードの読み取り専用ビュワー。元のソース・wrangler の設定・変換後の Worker・アセット |
| 可観測性 | 概要（リクエスト数・エラー数・実行時間 p50 / p99 のグラフ）と、イベント（リクエストごとのステータス・実行時間・console 出力・例外・サブリクエスト）。結果・種類・文字列で絞り込め、ライブで追従もできる |
| 設定 | チーム ID、GitHub Actions 用の URL と Token、サイトの構成（vars・バインディング・assets）、サイトの削除 |

### ログインとチーム ID

- 最初の 1 人はセットアップトークンでパスキーを登録する
- ログイン画面は「サインイン」と「サインアップ」を切り替えられる
  - サインイン：登録済みのパスキーだけでログインする
  - サインアップ：チーム ID（16 文字、約 80 ビット）を入力して、そのデバイスのパスキーを登録する。チーム ID は設定のページで確認できる
- チーム ID は大文字小文字・ハイフン・空白の違いを無視し、`O` と `0`、`I` / `L` と `1` も同じ文字として扱う

イベントは `KANZUME_LOG_RETENTION_HOURS`（既定 72 時間）を過ぎると削除します。実行時間は Worker が応答を返し終えるまでの実時間で、CPU 時間ではありません。

## 対応している機能

| 機能 | 対応 |
|---|---|
| fetch ハンドラ（ES Modules 形式） | ○ オブジェクトと `WorkerEntrypoint` クラスの両方 |
| `ctx.waitUntil` / `ctx.passThroughOnException` | ○ |
| `vars` | ○ |
| Workers Static Assets | ○ `html_handling` / `not_found_handling` / `run_worker_first` / `binding` |
| KV | ○ get（text / json / arrayBuffer / stream、複数キー）/ getWithMetadata / put（expirationTtl / expiration / metadata）/ delete / list |
| R2 | ○ get（range / onlyIf）/ put（httpMetadata / customMetadata / onlyIf / md5）/ head / delete / list（prefix / delimiter / cursor / include） |
| `nodejs_compat` | △ buffer / crypto / events / stream / util / path / url / zlib / async_hooks など。fs・net・child_process などは使えない |
| Web 標準 API | ○ Node 24 の fetch / Request / Response / URL / crypto.subtle / Streams / CompressionStream など |
| Cron Triggers / D1 / Durable Objects / Queues / WebSocket / HTMLRewriter / R2 マルチパート | × |
| Service Worker 形式（`addEventListener("fetch")`） | × |
| secrets（`wrangler secret`） | × `vars` を使ってください |

KV の namespace と R2 の bucket は binding 名 / bucket 名で分かれます。wrangler の設定に書いた Cloudflare の `id` は無視するので、そのまま置いておいて構いません。データは再デプロイしても残り、サイトを削除すると消えます。

### 隔離について

Worker は `node:vm` のコンテキストで動かします。vm はセキュリティ境界ではないので、Token を渡した人とチームのメンバー（＝デプロイできる人）は信頼する前提です。

- 同期処理が `KANZUME_CPU_TIMEOUT_MS`（実時間）を超えると打ち切ります。非同期処理の中の無限ループは止められません
- メモリの上限は Worker ごとには掛けられません

## 環境変数

| 変数 | 既定値 | 説明 |
|---|---|---|
| `PORT` | `8080` | Render が自動で設定する |
| `KANZUME_DATA_DIR` | `/data` | デプロイしたサイト・KV / R2・管理画面の状態の保存先 |
| `KANZUME_ORIGIN` | `RENDER_EXTERNAL_URL`、なければリクエストの Host | 公開 URL。パスキーの RP ID にも使う |
| `KANZUME_SETUP_TOKEN` | 起動時にランダム生成してログに出す | 最初のパスキー登録に使う |
| `KANZUME_MAX_UPLOAD_MB` | `50` | アップロードの上限（展開後はこの 4 倍まで） |
| `KANZUME_WORKER_IDLE_SEC` | `600` | この時間使われていない Worker はメモリから捨てる（次のリクエストで読み込み直す） |
| `KANZUME_CPU_TIMEOUT_MS` | `5000` | 1 リクエストの同期処理の上限 |
| `KANZUME_LOG_RETENTION_HOURS` | `72` | 可観測性のイベントを残す時間 |

## 計測値

`docker run --cpus=0.1 --memory=512m`（Render 無料プラン相当）、Apple Silicon 上の colima で計測しました。

| 項目 | 値 |
|---|---|
| イメージサイズ | gzip 55.7MB。大半は node 本体の 128MB（非圧縮）、esbuild が約 10MB |
| メモリ（起動直後） | 35MiB |
| メモリ（負荷をかけた後） | 45MiB |
| 応答時間（同時 1） | p50 約 5ms / p95 約 85ms |
| スループット（同時 10） | 40〜55 req/s、p50 約 200ms |

## 開発

```sh
npm install
npm run dev        # KANZUME_DATA_DIR=.data で起動
npm test           # node:test
npm run typecheck
```

Node 24 の型ストリップで TypeScript をそのまま実行するので、ビルドは不要です。

```
src/server.ts          エントリ
src/router.ts          パスの振り分け、アセットと Worker の優先順位
src/store.ts           リリースの保存と atomic な切り替え
src/deploy/            /_api/deploy、GitHub からのデプロイ、tar の展開、wrangler 設定の読み込み、デプロイ履歴
src/runtime/           vm コンテキストでの Worker 実行
src/bindings/          KV（node:sqlite）、R2（ファイル + sqlite）、ASSETS
src/admin/             管理画面の API（パスキー・チーム ID・セッション・Token・コード閲覧）
src/observability/     リクエストのイベント記録とメトリクス集計
web/admin/             管理画面（素の HTML / CSS / JS）
action/                GitHub Action
examples/worker/       サンプル
```
