FROM node:24-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY build.js concept-map.html ./
COPY src/ ./src/
RUN node build.js

FROM node:24-alpine
WORKDIR /app
COPY server.js ./
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "server.js"]
