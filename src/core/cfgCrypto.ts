/**
 * 配置分享包加解密 — AES-GCM（WebCrypto）
 *
 * 用途：「含密钥导出」时把整份配置加密成不可读的分享包（.momocfg 结构），
 * 接收方导入即可直接使用，密钥不以明文出现在文件里。
 *
 * 诚实说明：密钥派生自应用内置口令（接收方的应用要能解开才能用），
 * 所以这是"防翻看"而不是"防提取"——技术上不存在"既能用又绝对拿不到"的方案。
 * 对应 UI 文案也按这个口径写，不夸大安全性。
 */

const APP_PASS = "momo-canvas-cfg-v1";

async function deriveKey(): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(APP_PASS));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const b64 = (buf: ArrayBuffer | Uint8Array) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export type EncryptedCfg = { momoEnc: 1; iv: string; data: string };

export function isEncryptedCfg(v: unknown): v is EncryptedCfg {
  return !!v && typeof v === "object" && (v as EncryptedCfg).momoEnc === 1 && typeof (v as EncryptedCfg).data === "string";
}

/** 配置 JSON → 加密分享包 */
export async function encryptCfg(json: string): Promise<EncryptedCfg> {
  const key = await deriveKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json));
  return { momoEnc: 1, iv: b64(iv), data: b64(data) };
}

/** 加密分享包 → 配置 JSON（解不开抛中文错误） */
export async function decryptCfg(pkg: EncryptedCfg): Promise<string> {
  try {
    const key = await deriveKey();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(pkg.iv) }, key, unb64(pkg.data));
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("配置分享包解密失败：文件可能损坏，或来自不兼容的版本");
  }
}
