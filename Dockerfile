# Multi-stage build; the runtime image contains only compiled JS and production deps.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Web-session automation and the audio lab need a browser and ffmpeg at runtime.
RUN apk add --no-cache chromium ffmpeg
ENV SC_WEB_CHROME=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
ENV DATA_DIR=/data
ENV HOST=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "dist/index.js"]
