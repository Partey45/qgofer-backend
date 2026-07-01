FROM node:20-alpine
WORKDIR /app
COPY src/ ./src/
EXPOSE 3001
CMD ["node", "src/index.js"]
