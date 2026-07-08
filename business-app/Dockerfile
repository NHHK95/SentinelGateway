FROM node:20-alpine

WORKDIR /app

RUN addgroup -S business && adduser -S business -G business

COPY server.js ./

USER business

CMD ["node", "server.js"]
