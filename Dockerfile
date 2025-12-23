# Stage 1: Dependencies
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat

COPY ./capturit-shared ./capturit-shared

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package files
COPY capturit-payment-service/package.json capturit-payment-service/pnpm-lock.yaml* ./

# Install dependencies (all dependencies needed for build)
RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:20-alpine AS builder

COPY --from=deps ./capturit-shared ./capturit-shared

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY ./capturit-payment-service .

# Disable telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Build the application
RUN pnpm run build

# Stage 3: Production dependencies
FROM node:20-alpine AS prod-deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Reuse package.json from builder
COPY --from=deps /app/package.json /app/pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 4 : Runner
FROM node:20-alpine AS runner

COPY --from=builder ./capturit-shared ./capturit-shared

WORKDIR /app

ENV NODE_ENV=production

# Copy only production dependencies
COPY --from=prod-deps /app/node_modules ./node_modules

# Copy compiled code (JavaScript)
COPY --from=builder /app/dist ./dist

# Copy package.json (for version info, etc.)
COPY --from=builder /app/package.json ./

EXPOSE 3000

# Start the compiled server
CMD ["node", "dist/server.js"]