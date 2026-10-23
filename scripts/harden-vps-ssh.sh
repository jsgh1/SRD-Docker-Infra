#!/usr/bin/env bash
set -euo pipefail
test "$(id -u)" -eq 0
install -m 644 /tmp/00-srd-ssh-hardening.conf /etc/ssh/sshd_config.d/00-srd-ssh-hardening.conf
sshd -t
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|pubkeyauthentication) '
systemctl reload ssh
