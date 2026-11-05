FROM composer:2@sha256:d8f6343d3fae98107426bc49163ccad46ef85aabd4a27d80a74401fab4aba332 AS composer

FROM php:8.4-cli-bookworm@sha256:54b467ede1db96c66675e7b78457dd43729d0e7be31978d4a1e5c069ceabcf76 AS build
ARG SERVICE
RUN case "$SERVICE" in gateway|identity|configuration|records|audit|files|calendar|notifications|treasury|inventory|chat) ;; *) echo "Unsupported SERVICE" >&2; exit 2 ;; esac \
    && apt-get update \
    && apt-get install -y --no-install-recommends libonig-dev libzip-dev libxml2-dev unzip \
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
    && rm -f /usr/local/bin/composer \
    && rm -rf /root/.composer/cache

FROM php:8.4-fpm-bookworm@sha256:1b6bb4f3d32dfbcd1e159d7bd47caa8852507f61666db7731d73f34acec781b6 AS runtime
ARG SERVICE
ARG SRD_BACKEND_REVISION=unknown
ARG SRD_INFRA_REVISION=unknown
ARG SRD_DATABASE_REVISION=unknown
LABEL org.opencontainers.image.title="SRD ${SERVICE} PHP-FPM candidate" \
      org.opencontainers.image.source="https://github.com/jsgh1/SRD-Backend" \
      org.opencontainers.image.revision="${SRD_BACKEND_REVISION}" \
      io.srd.infra.revision="${SRD_INFRA_REVISION}" \
      io.srd.database.revision="${SRD_DATABASE_REVISION}"
RUN case "$SERVICE" in gateway|identity|configuration|records|audit|files|calendar|notifications|treasury|inventory|chat) ;; *) echo "Unsupported SERVICE" >&2; exit 2 ;; esac \
    && apt-get update \
    && apt-get install -y --no-install-recommends libonig5 libzip4 libxml2 libcurl4 libonig-dev libzip-dev libxml2-dev unzip \
    && if [ "$SERVICE" = gateway ]; then apt-get install -y --no-install-recommends libcurl4-openssl-dev; fi \
    && if [ "$SERVICE" = records ] || [ "$SERVICE" = files ]; then apt-get install -y --no-install-recommends libpng16-16 libjpeg62-turbo libwebp7 libpng-dev libjpeg62-turbo-dev libwebp-dev; fi \
    && if [ "$SERVICE" = files ]; then apt-get install -y --no-install-recommends poppler-utils ffmpeg; fi \
    && docker-php-ext-install pdo_mysql mbstring zip bcmath pcntl \
    && if [ "$SERVICE" = gateway ]; then docker-php-ext-install curl; fi \
    && if [ "$SERVICE" = records ] || [ "$SERVICE" = files ]; then docker-php-ext-configure gd --with-jpeg --with-webp && docker-php-ext-install gd; fi \
    && if [ "$SERVICE" = files ]; then docker-php-ext-install exif; fi \
    && apt-get purge -y --auto-remove libonig-dev libzip-dev libxml2-dev unzip libcurl4-openssl-dev libpng-dev libjpeg62-turbo-dev libwebp-dev \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
WORKDIR /app/services/${SERVICE}
RUN mkdir -p bootstrap/cache storage/framework/cache/data storage/framework/sessions storage/framework/views storage/framework/scheduler-health storage/logs storage/app/private/photos storage/app/private/quarantine \
    && chown -R www-data:www-data storage bootstrap/cache \
    && printf 'expose_php=Off\ncgi.fix_pathinfo=0\n' > /usr/local/etc/php/conf.d/zz-srd-hardening.ini \
    && sed -i -E 's/^[;[:space:]]*clear_env[[:space:]]*=.*/clear_env = no/' /usr/local/etc/php-fpm.d/www.conf \
    && printf '\nsecurity.limit_extensions = .php\n' >> /usr/local/etc/php-fpm.d/www.conf \
    && php-fpm -t \
    && test -s vendor/autoload.php
RUN if [ "$SERVICE" = gateway ] || [ "$SERVICE" = files ]; then printf 'memory_limit=256M\npost_max_size=32M\n' > /usr/local/etc/php/conf.d/srd-service.ini; fi \
    && if [ "$SERVICE" = records ]; then printf 'memory_limit=512M\n' > /usr/local/etc/php/conf.d/srd-service.ini; fi
EXPOSE 9000
CMD ["php-fpm", "--nodaemonize"]
