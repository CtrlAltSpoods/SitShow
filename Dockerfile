FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/CtrlAltSpoods/SitShow" \
      org.opencontainers.image.title="Sit Show" \
      org.opencontainers.image.description="Musical Chairs Royale - a multiplayer browser game show"
WORKDIR /app
COPY package.json server.js puzzles.js ./
COPY public ./public
# The server starts as root only long enough to fix /data ownership, then drops to PUID:PGID.
# 99:100 (nobody:users) matches Unraid's appdata defaults.
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data PUID=99 PGID=100
RUN mkdir -p /data/music
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
