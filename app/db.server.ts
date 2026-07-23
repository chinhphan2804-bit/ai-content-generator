import { PrismaClient } from "@prisma/client";
import { encrypt, decrypt } from "./encryption.server";

function decryptSessionRow<T extends { accessToken?: string | null; refreshToken?: string | null } | null>(
  row: T
): T {
  if (!row) return row;
  if (row.accessToken) row.accessToken = decrypt(row.accessToken);
  if (row.refreshToken) row.refreshToken = decrypt(row.refreshToken);
  return row;
}

// Bọc thêm 1 lớp mã hoá trong suốt cho accessToken/refreshToken của bảng
// Session — PrismaSessionStorage (từ SDK Shopify) không hề biết việc này,
// nó vẫn gọi prisma.session.upsert/findUnique/findMany như bình thường,
// chỉ là dữ liệu thật sự nằm trên đĩa đã được mã hoá AES-256-GCM.
function createPrismaClient() {
  return new PrismaClient().$extends({
    name: "encrypt-session-tokens",
    query: {
      session: {
        async upsert({ args, query }) {
          const create = args.create as Record<string, unknown>;
          const update = args.update as Record<string, unknown>;
          if (typeof create?.accessToken === "string") create.accessToken = encrypt(create.accessToken);
          if (typeof update?.accessToken === "string") update.accessToken = encrypt(update.accessToken);
          if (typeof create?.refreshToken === "string") create.refreshToken = encrypt(create.refreshToken);
          if (typeof update?.refreshToken === "string") update.refreshToken = encrypt(update.refreshToken);
          return query(args);
        },
        async findUnique({ args, query }) {
          return decryptSessionRow(await query(args));
        },
        async findFirst({ args, query }) {
          return decryptSessionRow(await query(args));
        },
        async findMany({ args, query }) {
          const rows = await query(args);
          return (rows as any[]).map((r) => decryptSessionRow(r));
        },
      },
    },
  });
}

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: ReturnType<typeof createPrismaClient>;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createPrismaClient();
  }
}

const prisma = global.prismaGlobal ?? createPrismaClient();

export default prisma;
