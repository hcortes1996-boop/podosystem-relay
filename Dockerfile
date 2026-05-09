FROM node:20-slim

# Instalar libatomic1 y build tools para compilar better-sqlite3
RUN apt-get update && apt-get install -y \
    libatomic1 python3 make g++ \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 3010
CMD ["node", "src/index.js"]
