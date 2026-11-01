// パスキーに識別名を付ける。AAGUID（パスキーを保存した認証器の種類）と、登録したブラウザの User-Agent から推測する

// よく使われるパスキープロバイダーの AAGUID。https://github.com/passkeydeveloper/passkey-authenticator-aaguids から抜粋
const PROVIDERS: Record<string, string> = {
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "iCloud キーチェーン",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud キーチェーン",
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google パスワード マネージャー",
  "adce0002-35bc-c60a-648b-0b25f1f05503": "Chrome（Mac）",
  "771b48fd-d3d4-4f74-9232-fc157ab0507a": "Edge（Mac）",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export function providerName(aaguid: string | undefined): string | undefined {
  return aaguid ? PROVIDERS[aaguid.toLowerCase()] : undefined;
}

/** User-Agent から「Mac・Chrome」のような短い説明を作る */
export function describeDevice(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;
  const os = /iPhone/.test(userAgent)
    ? "iPhone"
    : /iPad/.test(userAgent)
      ? "iPad"
      : /Android/.test(userAgent)
        ? "Android"
        : /CrOS/.test(userAgent)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(userAgent)
            ? "Mac"
            : /Windows/.test(userAgent)
              ? "Windows"
              : /Linux/.test(userAgent)
                ? "Linux"
                : undefined;
  const browser = /Edg(e|A|iOS)?\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\/|FxiOS\//.test(userAgent)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : undefined;
  const parts = [os, browser].filter(Boolean);
  return parts.length ? parts.join("・") : undefined;
}

export const MAX_PASSKEY_NAME = 40;

export function normalizePasskeyName(input: unknown): string {
  return String(input ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, MAX_PASSKEY_NAME);
}
