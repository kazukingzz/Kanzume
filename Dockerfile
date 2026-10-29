FROM node:24-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# node:24-alpine をそのまま使わないのは、npm / yarn / corepack（約 25MB）を最終イメージに含めないため
FROM alpine:3.24
RUN apk add --no-cache libstdc++ \
  && addgroup -S kanzume && adduser -S -G kanzume kanzume \
  && mkdir -p /data && chown kanzume:kanzume /data
COPY --from=deps /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY web ./web
ENV NODE_ENV=production KANZUME_DATA_DIR=/data PORT=8080
USER kanzume
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "--max-old-space-size=256", "src/server.ts"]
