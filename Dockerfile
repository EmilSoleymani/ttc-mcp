# Self-hosted image: bakes a local libSQL file from the live TTC GTFS feed at
# build time (docs/spec/gtfs-ingestion.md "Docker: an embedded local libSQL
# file baked at image-build time — self-contained, zero external dependency
# for self-hosters"). Multi-stage, non-root runtime (stack-baseline: inherits
# go-planner's docker-deployment spec).

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Bake the optimized DB (+ synthetic transfers) into the image. Needs network
# access at build time to download the TTC GTFS ZIPs from CKAN.
RUN mkdir -p /app/data \
    && LIBSQL_URL=file:/app/data/ttc.db node dist/entry/ingest.js

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV LIBSQL_URL=file:/app/data/ttc.db
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/data ./data

RUN addgroup -S ttc && adduser -S ttc -G ttc && chown -R ttc:ttc /app
USER ttc

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/entry/http.js"]
