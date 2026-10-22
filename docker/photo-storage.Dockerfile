FROM srd-file-safety-check:latest
RUN docker-php-ext-install pdo_mysql pcntl
CMD ["php", "tools/check-photo-storage.php"]
