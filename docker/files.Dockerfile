FROM composer:2@sha256:d8f6343d3fae98107426bc49163ccad46ef85aabd4a27d80a74401fab4aba332 AS composer
FROM php:8.4-cli-bookworm@sha256:9cc9310a457019cd6b682109eb3c5dd8bf73498e7d3b9ee5c33d0d0b83d0faf3
RUN apt-get update && apt-get install -y --no-install-recommends libonig-dev libzip-dev libxml2-dev libpng-dev libjpeg62-turbo-dev libwebp-dev poppler-utils ffmpeg unzip && docker-php-ext-configure gd --with-jpeg --with-webp && docker-php-ext-install gd pdo_mysql mbstring zip bcmath pcntl && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
RUN docker-php-ext-install exif
ARG SERVICE=files
WORKDIR /app/services/${SERVICE}
COPY packages/php /app/packages/php
COPY services/${SERVICE} /app/services/${SERVICE}
RUN composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader && mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views storage/framework/scheduler-health storage/logs storage/app/private/photos storage/app/private/quarantine && chown -R www-data:www-data storage bootstrap/cache
RUN printf "memory_limit=256M\npost_max_size=32M\n" > /usr/local/etc/php/conf.d/srd-files.ini
USER www-data
EXPOSE 8000
CMD ["php", "-S", "0.0.0.0:8000", "-t", "public", "public/index.php"]
