FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# Install dependencies for every workspace before copying sources (layer caching).
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/questions/package.json packages/questions/
RUN npm ci --omit=dev && npm cache clean --force

COPY apps/server apps/server
COPY apps/web apps/web
COPY packages/questions packages/questions
COPY templates templates

ENV PORT=3000 DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/server/src/server.js"]