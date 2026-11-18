FROM node:24-alpine3.24 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
# TypeScript のソースを dist/ にまとめる（実行時の変換をなくし、待機中のメモリを減らす）。
# esbuild 以外の依存は dist/ に入るので、最終イメージの node_modules は esbuild だけにする
COPY scripts ./scripts
COPY src ./src
RUN node scripts/build.mjs \
  && mkdir -p /out/node_modules \
  && cp -R node_modules/esbuild node_modules/@esbuild /out/node_modules/

# node:24-alpine をそのまま使わないのは、npm / yarn / corepack（約 25MB）を最終イメージに含めないため
FROM alpine:3.24
# git と git-daemon（git-http-backend が入っている）は Kanzume を Git のリモートにするため
# 本体は root で動かし、Worker（ユーザーのコード）はサイトごとに別のユーザーの子プロセスで動かす（src/runtime/process.ts）
RUN apk add --no-cache libstdc++ git git-daemon \
  && mkdir -p /data && chmod 0711 /data
COPY --from=build /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY web ./web
ENV NODE_ENV=production KANZUME_DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=256", "dist/server.mjs"]
