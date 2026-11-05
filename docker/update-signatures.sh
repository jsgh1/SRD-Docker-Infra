#!/bin/sh
set -eu
# Signature authenticity is still checked by FreshClam; avoid loading a second
# full scanner into memory merely to test databases on this local workstation.
sed '/^[[:space:]]*TestDatabases[[:space:]]/d; /^[[:space:]]*NotifyClamd[[:space:]]/d' /etc/clamav/freshclam.conf > /tmp/srd-freshclam.conf
printf '\nTestDatabases no\n' >> /tmp/srd-freshclam.conf
# This container mounts signatures only, never private objects or quarantine.
while true; do
  if freshclam --foreground --stdout --config-file=/tmp/srd-freshclam.conf; then
    date +%s > /var/lib/clamav/srd-update-ok.tmp
    chmod 644 /var/lib/clamav/srd-update-ok.tmp
    mv /var/lib/clamav/srd-update-ok.tmp /var/lib/clamav/srd-update-ok
  fi
  sleep 21600
done
