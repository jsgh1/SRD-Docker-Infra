FROM nginx:stable-alpine@sha256:dc5069ad14f19660b141b21236140b91656bf89bbc3e2417c70ae650cd66104c
ARG SERVICE
ARG SRD_BACKEND_REVISION=unknown
ARG SRD_INFRA_REVISION=unknown
ENV SERVICE=${SERVICE}
ENV NGINX_ENVSUBST_FILTER=^SERVICE$
LABEL org.opencontainers.image.title="SRD ${SERVICE} Nginx FastCGI candidate" \
      org.opencontainers.image.source="https://github.com/jsgh1/SRD-Docker-Infra" \
      org.opencontainers.image.revision="${SRD_INFRA_REVISION}" \
      io.srd.backend.revision="${SRD_BACKEND_REVISION}"
RUN case "$SERVICE" in gateway|identity|configuration|records|audit|files|calendar|notifications|treasury|inventory|chat) ;; *) echo "Unsupported SERVICE" >&2; exit 2 ;; esac \
    && rm -f /etc/nginx/conf.d/default.conf \
    && mkdir -p "/srv/$SERVICE/public"
COPY docker/nginx-service-fpm.conf.template /etc/nginx/templates/default.conf.template
COPY services/${SERVICE}/public/ /srv/${SERVICE}/public/
RUN chown -R nginx:nginx "/srv/${SERVICE}"
EXPOSE 8000
