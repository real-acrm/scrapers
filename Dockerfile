FROM node:20-slim

WORKDIR /app

# Skip browser binary downloads — the API doesn't use them, only the
# scrapers do (and scrapers run in GitHub Actions, not here).
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

EXPOSE 8080
CMD ["npm", "start"]
