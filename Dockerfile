FROM node:22-alpine AS web-build

WORKDIR /app/web
# Vite and TypeScript are devDependencies, so the frontend build must always
# install them even when Coolify forwards NODE_ENV=production as a build arg.
ENV NODE_ENV=development
COPY web/package*.json ./
RUN npm ci --include=dev
COPY web/ ./
RUN npm run build

FROM node:22-alpine AS production

ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "server/index.mjs"]
