FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# ติดตั้งเบราว์เซอร์ให้ตรงกับไลบรารีที่เพิ่งติดตั้งจริง
# base image มีเบราว์เซอร์มาให้แล้ว แต่ถ้าเวอร์ชันไม่ตรงบรรทัดนี้จะเติมให้ตรง
RUN npx playwright install chromium

COPY server.js ./

ENV PORT=10000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 10000

CMD ["node","server.js"]
