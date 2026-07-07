FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package*.json ./
COPY client/package*.json ./client/
RUN npm ci
RUN cd client && npm ci

# Build client
FROM deps AS client-build
COPY client/ ./client/
RUN cd client && npm run build

# Build server
FROM deps AS server-build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Production image
FROM base AS runner
ENV NODE_ENV=production

COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist
COPY package*.json ./
RUN npm ci --omit=dev

VOLUME ["/app/data"]
EXPOSE 3000 3001

CMD ["node", "dist/index.js"]
