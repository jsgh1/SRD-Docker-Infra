FROM php:8.4-cli-bookworm@sha256:9cc9310a457019cd6b682109eb3c5dd8bf73498e7d3b9ee5c33d0d0b83d0faf3
RUN apt-get update && apt-get install -y --no-install-recommends libpng-dev libjpeg62-turbo-dev libwebp-dev && docker-php-ext-configure gd --with-jpeg --with-webp && docker-php-ext-install gd && rm -rf /var/lib/apt/lists/*
WORKDIR /work
RUN docker-php-ext-install exif
CMD ["php", "tools/check-file-safety.php"]
