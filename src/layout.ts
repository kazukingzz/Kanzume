/**
 * データのディレクトリ（KANZUME_DATA_DIR）の中の置き場所。パスとファイルの区分はここにだけ書く
 * （権限をそろえる server.ts / runtime/process.ts と、バックアップが同じものを見る）。
 *
 * <data>/
 *   admin.json            ユーザー・パスキー・セッション・トークン（秘密）
 *   meta.sqlite           デプロイの履歴
 *   events.sqlite         リクエストのログ（バックアップしない）
 *   logs/server.log(.1)   本体のログ（バックアップする）
 *   repos/<site>.git      サイトのリポジトリ
 *   git-hooks/            git のフック（起動のたびに書き出す。バックアップしない）
 *   build/                デプロイのビルドの作業ディレクトリ（起動のたびに空にする。バックアップしない）
 *   sites/_root           ルートドメインのサイト
 *   sites/_uids.json      サイトごとの uid（Worker の子プロセス用）
 */
import path from "node:path";

export const ADMIN_FILE = "admin.json";
export const META_DB = "meta.sqlite";
export const EVENTS_DB = "events.sqlite";
export const LOGS_DIR = "logs";
export const SERVER_LOG = "server.log";
export const REPOS_DIR = "repos";
export const HOOKS_DIR = "git-hooks";
export const BUILD_DIR = "build";
export const SITES_DIR = "sites";
export const ROOT_FILE = "_root";
export const UIDS_FILE = "_uids.json";
export const SETTINGS_FILE = "settings.json";
export const SITE_DATA_DIR = "data";

/** SQLite の本体と一緒にできるファイル */
export const withSqliteSidecars = (db: string) => [db, `${db}-wal`, `${db}-shm`];

/** 本体だけが読み書きするファイル（Worker の子プロセスや、ほかのユーザーには見せない。0600） */
export const PRIVATE_FILES = [
  ADMIN_FILE,
  ...withSqliteSidecars(META_DB),
  ...withSqliteSidecars(EVENTS_DB),
  `${SITES_DIR}/${ROOT_FILE}`,
  `${SITES_DIR}/${UIDS_FILE}`,
];
/** 本体だけが使うディレクトリ（0700） */
export const PRIVATE_DIRS = [REPOS_DIR, HOOKS_DIR, LOGS_DIR, BUILD_DIR];

/** バックアップしないもの（トップレベル）: ログ（数日で消え、リクエストのたびに変わる）・フック（起動のたびに書き出す）・ビルドの作業ディレクトリ */
export const NOT_BACKED_UP = [HOOKS_DIR, BUILD_DIR, ...withSqliteSidecars(EVENTS_DB)];

export const sitesDir = (dataDir: string) => path.join(dataDir, SITES_DIR);
export const siteSettingsFile = (siteDir: string) => path.join(siteDir, SETTINGS_FILE);
/** サイトの KV / R2 の置き場所。Worker の子プロセスが書き込めるのはここだけ */
export const siteDataDir = (siteDir: string) => path.join(siteDir, SITE_DATA_DIR);
