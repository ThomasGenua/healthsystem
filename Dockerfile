FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /opt/northstar
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /var/lib/northstar /opt/northstar/empty && chown node:node /var/lib/northstar
USER node
ENV NORTHSTAR_DATA=/var/lib/northstar NORTHSTAR_CHANNELS=/opt/northstar/empty
EXPOSE 8686
CMD ["node", "src/server.ts"]
