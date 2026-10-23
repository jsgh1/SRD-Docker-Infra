#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo 'Ejecuta este script como root.' >&2
    exit 1
fi
key_file=${1:-/root/srd_deploy_20261020.pub}
if [ ! -s "$key_file" ]; then
    echo 'Falta la clave publica de SRD.' >&2
    exit 1
fi
if ! id -u srdadmin >/dev/null 2>&1; then
    useradd --create-home --shell /bin/bash srdadmin
fi
install -d -m 700 -o srdadmin -g srdadmin /home/srdadmin/.ssh
touch /home/srdadmin/.ssh/authorized_keys
while IFS= read -r key; do
    case "$key" in
        ssh-ed25519\ *)
            if ! grep -qxF "$key" /home/srdadmin/.ssh/authorized_keys; then
                printf '%s\n' "$key" >> /home/srdadmin/.ssh/authorized_keys
            fi
            ;;
        *) echo 'Formato de clave publica inesperado.' >&2; exit 1 ;;
    esac
done < "$key_file"
chown srdadmin:srdadmin /home/srdadmin/.ssh/authorized_keys
chmod 600 /home/srdadmin/.ssh/authorized_keys
usermod -aG sudo srdadmin
if [ ! -e /etc/sudoers.d/90-srdadmin ]; then
    sudoers_temp=$(mktemp)
    printf '%s\n' 'srdadmin ALL=(ALL) NOPASSWD: ALL' > "$sudoers_temp"
    visudo -c -f "$sudoers_temp"
    install -m 0440 "$sudoers_temp" /etc/sudoers.d/90-srdadmin
    rm "$sudoers_temp"
fi
visudo -c -f /etc/sudoers.d/90-srdadmin
echo 'srdadmin configurado. Verifica una segunda sesion antes de cambiar SSH.'
