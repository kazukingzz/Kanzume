/**
 * 利用者に見せてよいエラー。メッセージをそのまま返し、status を HTTP のステータスにする。
 * これ以外の例外は、作りの誤りとしてログに出し、500 にする（メッセージは返さない）
 */
export class UserFacingError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/** バイト数を MiB の表示にする（上限のメッセージ用） */
export function mib(bytes: number): string {
  const v = bytes / 1024 / 1024;
  return `${Number.isInteger(v) ? v : Math.round(v * 10) / 10} MB`;
}

/** 本文が上限を超えたとき */
export const tooLarge = (limit: number) => new UserFacingError(`アップロードは ${mib(limit)} 以内にしてください`, 413);
