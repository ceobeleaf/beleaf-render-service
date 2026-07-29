FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# v4.2: ตัด `RUN npx playwright install chromium` ออก
# base image v1.47.0-jammy มี chromium ที่ตรงเวอร์ชันติดมาให้แล้ว
# และ package.json ก็ pin playwright 1.47.0 ตรงกันเป๊ะ
# บรรทัดเดิมจึงเป็นการโหลดเบราว์เซอร์ซ้ำของที่มีอยู่ ทำให้ build นานจน timeout บน Free tier

COPY server.js ./

ENV PORT=10000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
EXPOSE 10000

CMD ["node","server.js"]
