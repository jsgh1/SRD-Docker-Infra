import fs from "node:fs";
const services = {};
const volumes = { mysql_data: {} };
const names = ["gateway", "identity", "configuration", "records", "audit", "files", "calendar"];
const envVar = (n) => "${" + n + ":?Ejecuta scripts/Initialize.ps1}";
for (const name of names) {
  const environment = {
    APP_NAME: `SRD-${name}`,
    APP_ENV: "local",
    APP_DEBUG: "false",
    APP_KEY: envVar("APP_KEY_" + name.toUpperCase()),
    APP_URL: "http://localhost:8080",
    APP_LOCALE: "es",
    DB_CONNECTION: "mysql",
    DB_HOST: "mysql",
    DB_DATABASE: "srd_" + name,
    DB_USERNAME: "srd_" + name,
    DB_PASSWORD: envVar("DB_PASSWORD_" + name.toUpperCase()),
    SESSION_DRIVER: "file",
    SESSION_LIFETIME: "30",
    SESSION_COOKIE: "srd_session",
    SESSION_SAME_SITE: "strict",
    SESSION_SECURE_COOKIE: "false",
    CACHE_STORE: "file",
    HASH_DRIVER: "argon",
    MAIL_MAILER: "smtp",
    MAIL_HOST: "mailpit",
    MAIL_PORT: "1025",
    MAIL_FROM_ADDRESS: "seguridad@srd.test",
    MAIL_FROM_NAME: "SRD",
    INTERNAL_KEY: envVar("INTERNAL_KEY"),
    CHALLENGE_KEY: envVar("CHALLENGE_KEY"),
    PUBLIC_URL: "http://localhost:8080",
  };
  services[name] = {
    build: {
      context: ".",
      dockerfile: name === 'files' ? 'docker/files.Dockerfile' : 'docker/php.Dockerfile',
      args: { SERVICE: name },
    },
    environment,
    networks: ["internal"],
    depends_on: { mysql: { condition: "service_healthy" } },
    healthcheck: {
      test: [
        "CMD",
        "php",
        "-r",
        "exit(@file_get_contents('http://127.0.0.1:8000/up') === false ? 1 : 0);",
      ],
      interval: "15s",
      timeout: "5s",
      retries: 5,
    },
  };
  if (name === "gateway") {
    volumes.gateway_sessions = {};
    services[name].volumes = [
      "gateway_sessions:/app/services/gateway/storage/framework/sessions",
    ];
  }
  if (name === 'files') {
    volumes.files_objects = {};
    services[name].volumes = ['files_objects:/app/services/files/storage/app/private', 'antivirus_signatures:/var/lib/clamav:ro'];
  }
  if (["identity", "configuration", "records", "files", "calendar"].includes(name))
    services[name + "-scheduler"] = {
      build: services[name].build,
      environment,
      networks: ["internal"],
      ...(name === 'files' ? { volumes: services[name].volumes } : {}),
      command: ["php", "artisan", "schedule:work"],
      depends_on: {
        [name]: { condition: "service_healthy" },
        audit: { condition: "service_healthy" },
      },
    };
}
const clamavImage = 'clamav/clamav:1.4.6@sha256:71fbb76b397cd84a90043caf1178a7f81bd0c131a031e7b0619afd721fbfad41';
volumes.antivirus_signatures = {};
services.antivirus = {
  image: clamavImage,
  environment: { CLAMAV_NO_FRESHCLAMD: 'true', CLAMAV_NO_MILTERD: 'true', CLAMD_CONF_SelfCheck: '60', CLAMD_CONF_ConcurrentDatabaseReload: 'no' },
  networks: ['internal'],
  volumes: ['antivirus_signatures:/var/lib/clamav'],
  mem_limit: '2g',
  healthcheck: { test: ['CMD', 'clamdcheck.sh'], interval: '10s', timeout: '5s', start_period: '90s', retries: 18 },
};
services['antivirus-updater'] = {
  image: clamavImage,
  command: ['sh', '/srd-update-signatures.sh'],
  networks: ['signature_updates'],
  volumes: ['antivirus_signatures:/var/lib/clamav', './docker/update-signatures.sh:/srd-update-signatures.sh:ro'],
  mem_limit: '384m',
  healthcheck: { disable: true },
};
services.mysql = {
  image:
    "mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb",
  environment: {
    MYSQL_ROOT_PASSWORD: envVar("MYSQL_ROOT_PASSWORD"),
    ...Object.fromEntries(
      names.map((n) => [
        "DB_PASSWORD_" + n.toUpperCase(),
        envVar("DB_PASSWORD_" + n.toUpperCase()),
      ]),
    ),
  },
  volumes: [
    "mysql_data:/var/lib/mysql",
    "./database/03_dcl/01_grants/initialize-services.sh:/docker-entrypoint-initdb.d/01-services.sh:ro",
  ],
  networks: ["internal"],
  healthcheck: {
    test: ["CMD", "mysqladmin", "ping", "--protocol=TCP", "-h", "127.0.0.1"],
    interval: "10s",
    timeout: "5s",
    retries: 20,
  },
};
services.mailpit = {
  image:
    "axllent/mailpit:v1.31.1@sha256:98b916bd3c8d61f7633a52d3ea2f58d00620cb01ca57ab59edde68c347a95365",
  networks: ["internal", "local_access"],
  ports: ["127.0.0.1:8025:8025"],
};
services.web = {
  build: { context: ".", dockerfile: "docker/web.Dockerfile" },
  ports: ["127.0.0.1:8080:80"],
  networks: ["internal", "local_access"],
  depends_on: { gateway: { condition: "service_healthy" } },
};
fs.writeFileSync(
  "compose.yaml",
  JSON.stringify(
    {
      name: "srd",
      services,
      volumes,
      networks: { internal: { internal: true }, local_access: {}, signature_updates: {} },
    },
    null,
    2,
  ) + "\n",
);
fs.writeFileSync(
  ".env.example",
  [
    "MYSQL_ROOT_PASSWORD=",
    "INTERNAL_KEY=",
    "CHALLENGE_KEY=",
    ...names.flatMap((n) => [
      "APP_KEY_" + n.toUpperCase() + "=",
      "DB_PASSWORD_" + n.toUpperCase() + "=",
    ]),
  ].join("\n") + "\n",
);
