FROM composer:2@sha256:d8f6343d3fae98107426bc49163ccad46ef85aabd4a27d80a74401fab4aba332 AS composer
FROM php:8.4-apache-bookworm

ARG SERVICE
RUN test -n "$SERVICE" && apt-get update && apt-get install -y --no-install-recommends \
    libonig-dev libzip-dev libxml2-dev unzip \
    && docker-php-ext-install pdo_mysql mbstring zip bcmath pcntl \
    && if [ "$SERVICE" = gateway ]; then apt-get install -y --no-install-recommends libcurl4-openssl-dev && docker-php-ext-install curl; fi \
    && if [ "$SERVICE" = records ] || [ "$SERVICE" = files ]; then apt-get install -y --no-install-recommends libpng-dev libjpeg62-turbo-dev libwebp-dev && docker-php-ext-configure gd --with-jpeg --with-webp && docker-php-ext-install gd; fi \
    && if [ "$SERVICE" = files ]; then apt-get install -y --no-install-recommends poppler-utils ffmpeg && docker-php-ext-install exif; fi \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/local/bin/composer
WORKDIR /app/services/${SERVICE}
COPY packages/php /app/packages/php
COPY services/${SERVICE} /app/services/${SERVICE}
RUN mkdir -p bootstrap/cache storage/framework/cache/data storage/framework/sessions storage/framework/views storage/framework/scheduler-health storage/logs storage/app/private/photos storage/app/private/quarantine \
    && composer install --no-dev --no-interaction --prefer-dist --optimize-autoloader \
    && chown -R www-data:www-data storage bootstrap/cache \
    && a2enmod rewrite headers \
    && sed -i 's/Listen 80/Listen 8000/' /etc/apache2/ports.conf \
    && printf '<VirtualHost *:8000>\n    DocumentRoot /app/services/%s/public\n    DirectoryIndex index.php\n    <Directory /app/services/%s/public>\n        AllowOverride All\n        Require all granted\n        FallbackResource /index.php\n    </Directory>\n</VirtualHost>\n' "$SERVICE" "$SERVICE" > /etc/apache2/sites-available/000-default.conf \
    && printf 'ServerName localhost\nServerTokens Prod\nServerSignature Off\n' > /etc/apache2/conf-available/srd-security.conf \
    && a2enconf srd-security
RUN if [ "$SERVICE" = gateway ] || [ "$SERVICE" = files ]; then printf 'memory_limit=256M\npost_max_size=32M\n' > /usr/local/etc/php/conf.d/srd-service.ini; fi \
    && if [ "$SERVICE" = records ]; then printf 'memory_limit=512M\n' > /usr/local/etc/php/conf.d/srd-service.ini; fi
EXPOSE 8000
CMD ["apache2-foreground"]
