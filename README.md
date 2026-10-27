# SRD · Docker Infra

> **Punto de entrada para instalar, ensamblar, levantar y validar SRD** — Sistema de Registro Digital para Juntas de Acción Comunal. Este repositorio reúne la orquestación Docker, el proxy web, los scripts de operación, las pruebas integradas y los procedimientos de despliegue.

[Backend](https://github.com/jsgh1/SRD-Backend/tree/dev) · [Frontend](https://github.com/jsgh1/SRD-Frontend/tree/dev) · [Database](https://github.com/jsgh1/SRD-Database/tree/dev) · [Docs](https://github.com/jsgh1/SRD-Docs/tree/dev)

## 1. Arquitectura general

```text
                    Web / Electron / apps móviles
                                  │
                             HTTP(S)/WSS
                                  ▼
                         Nginx / proxy web
                     ┌────────────┴─────────────┐
                     ▼                          ▼
             Gateway Laravel              Chat Reverb
                     │                       (WebSocket)
          ┌──────────┼────────────────┐
          ▼          ▼                ▼
        Identity   Records         Files · Calendar · ...
          │          │                │
          └──────────┴────────────────┘
                 MySQL 8.4
             11 bases / 11 usuarios

         Mailpit (solo desarrollo) · ClamAV
         Workers scheduler · Auditoría
```

**Principios de despliegue:** un entorno Docker aislado, credenciales por servicio y tráfico de APIs a través del Gateway. El código Backend, la web React y las migraciones se alojan en otros repositorios y **se reúnen solo en el directorio de construcción**.

## 2. Qué contiene este repositorio

```text
SRD-Docker-Infra/
├── compose.yaml                 # Infraestructura local/de desarrollo
├── compose.production.yaml      # Topología de producción (no usar sin revisión)
├── .env.example                 # Nombres de variables, SIN secretos
├── .env.production.example
├── docker/
│   ├── php.Dockerfile            # Imagen Laravel parametrizada por SERVICE
│   ├── web.Dockerfile            # Compilación/servido de React
│   ├── nginx.conf                # Entrada web y proxy a servicios
│   ├── nginx-locations.conf
│   ├── php-production.Dockerfile
│   ├── nginx-production.conf
│   ├── Caddyfile.production
│   └── update-signatures.sh      # Actualización ClamAV
├── scripts/
│   ├── Initialize.ps1            # Generación/actualización de .env local
│   ├── Up.ps1                    # Arranque y migración del stack
│   ├── Down.ps1                  # Apagado sin eliminar volúmenes
│   ├── Test.ps1                  # Pruebas unitarias y compilación en workspace completo
│   ├── Test-Browser.ps1          # Playwright E2E
│   ├── Test-MySqlIsolation.ps1   # Aislamiento entre usuarios MySQL
│   ├── Test-BackupRestore.ps1
│   └── ...
├── tools/
│   ├── initialize.mjs
│   ├── browser-tests/            # Escenarios Playwright
│   ├── create-fixtures.php
│   ├── check-mysql-isolation.php
│   └── ...
└── deploy/                      # Configuraciones/timers operativos del servidor
```

## 3. Tecnologías y contenedores

| Capa | Componentes |
| --- | --- |
| Backend | **11** servicios Laravel: gateway, identity, configuration, records, audit, files, calendar, notifications, treasury, inventory y chat |
| Procesamiento programado | **9** contenedores `*-scheduler` |
| Persistencia | MySQL 8.4 con bases `srd_<servicio>` y usuarios separados |
| Interfaz | React construido con Vite, servido por Nginx |
| Mensajería instantánea | Chat + **chat-reverb** (WebSocket) |
| Correo de desarrollo | **Mailpit**, SMTP interno y consola web en puerto 8025 |
| Archivos y protección | **ClamAV** y actualizador de firmas antivirus |
| Control de acceso | Redes Compose `internal`, `local_access`, `signature_updates` |

`compose.yaml` define 27 servicios posibles, incluido `web-tls`, que **no es parte del arranque habitual de `Up.ps1`**. El despliegue local validado utiliza **26 contenedores iniciados**. No confundir la cantidad de servicios definidos con los realmente lanzados.

## 4. Ensamblaje de los cinco repositorios

### 4.1 Requisitos en Windows

- **Git**, **Docker Desktop + Docker Compose**, **PowerShell 5.1+** y **Node.js** (usado por `Initialize.ps1`).
- Recursos suficientes para MySQL, 11 APIs, workers y antivirus (ClamAV puede demandar memoria considerable).
- Puertos **8080** para la web y **8025** para Mailpit disponibles. El entorno TLS opcional usa **8443**.
- No usar datos ni credenciales del VPS en un computador de pruebas.

El proyecto está **separado en cinco repositorios**; clonar únicamente Infra NO basta para construir imágenes.

### 4.2 Clonar ramas `dev`

Ejemplo en **un directorio nuevo y propio**, sin borrar carpetas existentes:

```powershell
$Base = Join-Path $env:USERPROFILE "Desktop\SRD-Integrado"
New-Item -ItemType Directory -Force -Path $Base | Out-Null

$Repos = @("SRD-Backend","SRD-Frontend","SRD-Database","SRD-Docker-Infra","SRD-Docs")
foreach ($Repo in $Repos) {
    git clone --branch dev "https://github.com/jsgh1/$Repo.git" (Join-Path $Base $Repo)
    if ($LASTEXITCODE -ne 0) { throw "Error clonando $Repo" }
}
```

Para una liberación reproducible en QA/producción se deben registrar **SHA específicos** de los cinco repositorios y no asumir que `dev` será inmutable.

### 4.3 Ensamblar un workspace nuevo con procedencia

El ensamblador versionado exige rutas explícitas a las cinco raíces Git, comprueba `origin`, limpieza y SHA, y se detiene ante un destino poblado. `--check` valida y detecta colisiones sin escribir. La ejecución real copia solo fuentes necesarias y deja `srd-provenance.json` con SHA de repositorios y archivos; no crea `.env`, no inicia Docker y no aplica migraciones. Ejecuta con Node 22 o posterior, tanto en Windows como en Linux:

```powershell
$Base = 'E:\Nueva carpeta\SRD-MultiRepo' # Cambia esta ruta a tus cinco clones
$Tool = Join-Path $Base 'SRD-Docker-Infra\tools\assemble-workspace.mjs'
$Sources = @('--infra',"$Base\SRD-Docker-Infra",'--backend',"$Base\SRD-Backend",'--frontend',"$Base\SRD-Frontend",'--database',"$Base\SRD-Database",'--docs',"$Base\SRD-Docs")
node $Tool @Sources --check
node $Tool @Sources --dest "$Base\workspace-nuevo"
```

La opción `--allow-dirty` sirve únicamente para diagnosticar cambios locales; el manifiesto los marca y ese resultado no constituye una reconstrucción reproducible desde commits. Nunca apuntes `--dest` al workspace QA existente. En CI, `.github/workflows/d8-cross-repo.yml` ensambla revisiones compañeras fijadas y utiliza el commit candidato de Infra; sus valores SHA deben actualizarse al preparar una nueva versión. El job de integración es manual y optativo: requiere un runner Windows **dedicado** con etiqueta `srd-integration-32gb`, comprueba recursos/puertos/volúmenes y utiliza un proyecto Compose exclusivo; conserva volúmenes para diagnóstico. No se ha ejecutado este job desde D8 local.

### 4.4 Copia manual de referencia

Estas copias **no mueven ni borran archivos de los clones**. No uses `/MIR`, `Remove-Item` ni scripts masivos de limpieza. El destino es un directorio independiente.

```powershell
$Work = Join-Path $Base "workspace"
New-Item -ItemType Directory -Force -Path $Work | Out-Null

function Copy-SrdTree([string]$From, [string]$To) {
    if (-not (Test-Path -LiteralPath $From)) { throw "Falta: $From" }
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    & robocopy $From $To /E /XD .git .github /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -ge 8) { throw "Error al copiar $From" }
}

Copy-SrdTree "$Base\SRD-Docker-Infra" $Work
Copy-SrdTree "$Base\SRD-Backend\services" "$Work\services"
Copy-SrdTree "$Base\SRD-Backend\packages" "$Work\packages"
Copy-SrdTree "$Base\SRD-Backend\contracts" "$Work\contracts"
Copy-SrdTree "$Base\SRD-Frontend\apps" "$Work\apps"
# Las migraciones se superponen DESPUÉS del código Laravel:
Copy-SrdTree "$Base\SRD-Database\services" "$Work\services"
Copy-SrdTree "$Base\SRD-Database\database" "$Work\database"

Set-Location -LiteralPath $Work
Test-Path .\services\identity\artisan
Test-Path .\services\records\database\migrations
Test-Path .\apps\web\package.json
Test-Path .\compose.yaml
```

Los cuatro `Test-Path` deben devolver `True`. **SRD-Docs no participa de la imagen**: se conserva clonado para consulta de entregables.

> Si el destino `workspace` ya tiene archivos modificados o una instalación en uso, **no sobrescribirlo automáticamente**. Prepara un `workspace` nuevo para no perder ajustes locales. La reconstrucción desde `dev` es una validación distinta del entorno SENA creado anteriormente.

## 5. Levantar SRD en Docker

### 5.1 Aislamiento en equipos compartidos

`compose.yaml` declara por defecto el nombre `srd`. **No lo utilices sin más en una computadora con proyectos de otros estudiantes.** Asigna un nombre Compose exclusivo:

```powershell
Set-Location -LiteralPath $Work
$env:COMPOSE_PROJECT_NAME = "srd-mi-entorno"
docker compose config --format json
```

Revisa antes de iniciar que el nombre y los volúmenes correspondan a tu proyecto y que los puertos **8080/8025** estén libres. El nombre de proyecto separa recursos Docker pero **no evita conflictos de puertos publicados**.

### 5.2 Inicializar secretos y arrancar

```powershell
# Siempre en el workspace ensamblado, con COMPOSE_PROJECT_NAME establecido
.\scripts\Initialize.ps1
.\scripts\Up.ps1

docker compose ps
```

`Initialize.ps1` usa `tools/initialize.mjs`, que genera `.env` con claves locales nuevas si aún no existe y agrega claves faltantes sin rotar las existentes. **Nunca publiques ese archivo**.

`Up.ps1` prepara primero MySQL y Mailpit, aprovisiona bases/usuarios, levanta las APIs, aplica `php artisan migrate --force`, ejecuta el *backfill* de recordatorios, inicia la web, el Reverb de Chat, los workers y el antivirus. No ejecutarlo sobre un proyecto Compose equivocado.

### 5.3 Accesos y diagnóstico

| Recurso | URL en desarrollo |
| --- | --- |
| Aplicación web | <http://127.0.0.1:8080/> |
| Mailpit (mensajes de prueba) | <http://127.0.0.1:8025/> |
| HTTPS local (solo si configurado) | <https://127.0.0.1:8443/> |

```powershell
docker compose ps
docker compose logs --tail 100 gateway
docker compose logs --tail 100 identity
docker compose logs --tail 100 chat-reverb
docker compose exec -T records php artisan migrate:status
```

Para detener **solo tu proyecto** sin borrar volúmenes: `docker compose down` con el mismo `COMPOSE_PROJECT_NAME`, o `.\scripts\Down.ps1`. No utilizar `down -v`, `docker system prune` ni acciones que afecten recursos ajenos.

## 6. Conexión interna de servicios

- **Web → Gateway:** Nginx enruta API `/api/v1/`; los clientes normalmente no necesitan URLs de cada microservicio.
- **Gateway → microservicios:** resolución DNS por nombre de servicio en la red `internal` (por ejemplo, `identity:8000`, `records:8000`).
- **Servicios → MySQL:** `DB_HOST=mysql` y `DB_DATABASE=srd_<servicio>`, cada uno con usuario propio.
- **Identity → Mailpit:** SMTP dentro de la red Docker; Mailpit expone su bandeja web local por 8025.
- **Chat → Reverb:** servidor WebSocket `chat-reverb` usando la imagen construida desde **el mismo código Chat**, sin depender de una etiqueta global `srd-chat`.
- **Files → ClamAV:** escaneo previo a la aceptación de archivos; el motor y la actualización de firmas son procesos separados.
- **Schedulers → auditoría y servicios:** procesos programados con checks propios para reintentos, entregas y tareas periódicas.

No publicar los puertos internos de MySQL, APIs ni ClamAV hacia toda la red sin necesidad.

## 7. Pruebas

### Control rápido, sin escrituras destructivas

```powershell
docker compose ps
Invoke-WebRequest http://127.0.0.1:8080/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:8025/ -UseBasicParsing
```

### PHPUnit, base y compilación

- Backend: [matriz PHPUnit para 11 servicios](https://github.com/jsgh1/SRD-Backend/actions/workflows/migration-phpunit.yml), que añade migraciones del repo Database.
- Database: [sintaxis de las migraciones](https://github.com/jsgh1/SRD-Database/actions/workflows/migration-migrations-lint.yml).
- Frontend: [TypeScript + Vite build](https://github.com/jsgh1/SRD-Frontend/actions/workflows/migration-web-build.yml).
- Infra: [validación Compose y compilación limpia de Reverb](.github/workflows/migration-compose-validation.yml).

**Resultados de QA del 23/10/2026:** **305/305 pruebas PHPUnit**, **6.292 aserciones**, **72** migraciones validadas, **11/11** usuarios de MySQL aislados, **110/110** intentos de lectura cruzada denegados, **2/2** E2E de acceso aprobadas y prueba EICAR detectada. Son evidencias de esa revisión, no un certificado permanente de producción.

### Playwright E2E

```powershell
# Importante: crea juntas/usuarios sintéticos; usar SOLO staging/QA aislado
$env:COMPOSE_PROJECT_NAME = "srd-mi-entorno"
npm ci --prefix tools/browser-tests --no-audit --no-fund
.\scripts\Test-Browser.ps1 -Compose -Spec "access.spec.mjs"
```

Hay más escenarios en `tools/browser-tests/` sobre permisos, aislamiento, documentos, calendario y Reverb. El script `Seed-ComposeTests.ps1` escribe **datos sintéticos**; nunca se debe ejecutar contra una base real sin revisión.

### Aislamiento MySQL

El comprobador `tools/check-mysql-isolation.php` intenta leer cada esquema externo con las credenciales del servicio. Para conservar el aislamiento de proyectos en una PC compartida, **no ejecutes `Test-MySqlIsolation.ps1` sin establecer antes el proyecto Compose exclusivo**. El script utiliza `docker compose` y hereda `COMPOSE_PROJECT_NAME`.

## 8. Respaldo y operación

`scripts/Backup-Local.ps1` y `scripts/Test-BackupRestore.ps1` documentan funciones de respaldo y restauración; `deploy/` y los scripts `*-production*` corresponden a procedimientos de servidor. **No ejecutar scripts de producción en una estación de pruebas ni actualizar el VPS automáticamente**. Una copia válida debe poder restaurarse y verificarse antes de modificar datos existentes.

## 9. Solución de problemas

| Fallo | Acción |
| --- | --- |
| `COPY services/...: not found` | Falta reunir Backend o migraciones Database en `workspace` |
| `COPY apps/web: not found` | Falta reunir Frontend en `workspace/apps/` |
| `APP_KEY_... is required` | Inicializar `.env` solo en el workspace correcto |
| MySQL `Access denied` | Credenciales por servicio no corresponden al volumen inicializado |
| `chat-reverb` falla al construir | Confirmar Dockerfile, `services/chat` y `packages/php`; no usar imagen global manual |
| Puerto 8080/8025 ocupado | Verificar quién usa el puerto antes de cambiar configuración; no detener proyectos ajenos |
| Antivirus `unhealthy` | Revisar memoria disponible, estado de ClamAV, firmas y `docker compose logs antivirus` |
| Un E2E modifica la demo | Usar un proyecto MySQL/Compose de QA separado; verificar fixtures antes de ejecutar |
| Deseas actualizar el entorno | Fijar SHAs, ensamblar en otro workspace, pasar CI y generar respaldo antes de sustituir |

## 10. Flujo Git y releases

1. Desarrollar en ramas hijas desde `dev`, abrir PR por repositorio y coordinar cambios de contratos con los demás.
2. CI automatizada + pruebas integradas usando **el mismo conjunto de commits** de Backend, Frontend, Database e Infra.
3. Promoción a `qa` para aceptación; luego PR a `main` cuando se haya aprobado el release.
4. Los cambios en `dev` **no se aplican al VPS por el mero hecho de fusionarlos**. Un despliegue productivo necesita ejecución explícita, respaldos, pruebas y autorización.

---

**Orquestador:** [jsgh1/SRD-Docker-Infra](https://github.com/jsgh1/SRD-Docker-Infra) · **Entrega documental:** [SRD-Docs](https://github.com/jsgh1/SRD-Docs/tree/dev).
