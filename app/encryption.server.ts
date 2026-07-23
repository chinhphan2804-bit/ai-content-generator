import crypto from "crypto";

// Mã hoá đối xứng AES-256-GCM cho dữ liệu nhạy cảm lưu trong database
// (hiện dùng cho accessToken/refreshToken trong bảng Session — xem db.server.ts).
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // độ dài IV khuyến nghị cho GCM

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY chưa được set trong .env — cần 1 key base64 giải mã ra đúng 32 byte (AES-256)."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY không hợp lệ — phải giải mã base64 ra đúng 32 byte.");
  }
  return key;
}

export function encrypt(plainText: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Gộp iv + authTag + ciphertext thành 1 chuỗi để lưu gọn trong 1 cột text.
  return [iv.toString("base64"), authTag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decrypt(cipherText: string): string {
  const parts = cipherText.split(":");
  if (parts.length !== 3) {
    // Dữ liệu cũ chưa được mã hoá (từ trước khi bật tính năng này) — trả
    // nguyên văn thay vì crash, để không làm hỏng session đang hoạt động.
    return cipherText;
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const data = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}
