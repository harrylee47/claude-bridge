FROM node:22-alpine
RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src/ ./src/
COPY public/ ./public/
COPY config.example.json ./

EXPOSE 3457

ENV PORT=3457
ENV BRIDGE_API_KEY=4545945

CMD ["node", "src/index.js"]
