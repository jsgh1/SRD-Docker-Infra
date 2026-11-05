FROM node:24-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS build
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web ./
RUN npm run build
FROM nginx:stable-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-locations.conf /etc/nginx/srd-locations.conf
COPY --from=build /web/dist /usr/share/nginx/html
