FROM composer:2@sha256:d8f6343d3fae98107426bc49163ccad46ef85aabd4a27d80a74401fab4aba332 AS composer
FROM php:8.4-cli-bookworm@sha256:9cc9310a457019cd6b682109eb3c5dd8bf73498e7d3b9ee5c33d0d0b83d0faf3
RUN apt-get update && apt-get install -y --no-install-recommends libonig-dev libzip-dev libxml2-dev unzip && docker-php-ext-install pdo_mysql mbstring zip bcmath pcntl && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
ARG SERVICE
RUN if [ "$SERVICE" = gateway ]; then apt-get update && apt-get install -y --no-install-recommends libcurl4-openssl-dev && docker-php-ext-install curl && rm -rf /var/lib/apt/lists/*; fi
RUN if [ "$SERVICE" = records ]; then apt-get update && apt-get install -y --no-install-recommends libpng-dev && docker-php-ext-install gd && rm -rf /var/lib/apt/lists/*; fi
WORKDIR /app/services/${SERVICE}
COPY services/${SERVICE}/composer.json services/${SERVICE}/composer.lock ./
RUN composer install --no-dev --no-interaction --prefer-dist --no-scripts --no-autoloader
COPY packages/php /app/packages/php
COPY services/${SERVICE} /app/services/${SERVICE}
RUN composer dump-autoload --no-dev --optimize && mkdir -p storage/framework/cache/data storage/framework/sessions storage/framework/views storage/framework/scheduler-health storage/logs && chown -R www-data:www-data storage bootstrap/cache
RUN if [ "$SERVICE" = gateway ]; then printf "memory_limit=256M\npost_max_size=32M\n" > /usr/local/etc/php/conf.d/srd-gateway.ini; fi
RUN if [ "$SERVICE" = records ]; then printf "memory_limit=512M\n" > /usr/local/etc/php/conf.d/srd-records.ini; fi
USER www-data
EXPOSE 8000
CMD ["php", "-S", "0.0.0.0:8000", "-t", "public", "public/index.php"]
