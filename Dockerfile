FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /opt/healthsystems
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
RUN mkdir -p /var/lib/healthsystems /opt/healthsystems/empty && chown node:node /var/lib/healthsystems
USER node
ENV HEALTHSYSTEMS_DATA=/var/lib/healthsystems HEALTHSYSTEMS_CHANNELS=/opt/healthsystems/empty
EXPOSE 8686
CMD ["node", "src/server.ts"]
