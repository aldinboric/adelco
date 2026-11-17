FROM node:20-slim

WORKDIR /app

# Install build dependencies for native Node addons (better-sqlite3, sharp)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install

COPY . .

# Build frontend production bundle
RUN npm run build

# Create data directory and volume mount point
RUN mkdir -p /app/data

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "start"]
