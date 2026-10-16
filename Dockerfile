FROM node:20-alpine
WORKDIR /app
# 无第三方依赖, 直接拷贝源码
COPY package.json ./
COPY src ./src
COPY bin ./bin
# 启动自研 NTP 服务端; 端口/密码来自环境变量
EXPOSE 9443
ENV NETUNEL_HOST=0.0.0.0
CMD ["node", "bin/netunel.js", "server"]
