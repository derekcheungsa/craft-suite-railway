# syntax=docker/dockerfile:1
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
EXPOSE 8080
CMD ["node", "src/server.js"]
