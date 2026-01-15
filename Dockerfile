# Stage 1: Dependencies
FROM hub.c2.agence418.fr/agence418/builder-os AS deps
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml* ./

# Install dependencies (all dependencies needed for build)
RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Disable telemetry
ENV NEXT_TELEMETRY_DISABLED=1

# Build the application
RUN pnpm run build

# Stage 3: Production dependencies
FROM hub.c2.agence418.fr/agence418/builder-os AS prod-deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Reuse package.json from builder
COPY --from=deps /app/package.json /app/pnpm-lock.yaml* ./

RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# Stage 4 : Runner
FROM node:20-alpine AS runner
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