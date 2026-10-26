#!/bin/sh
# Explicit provisioning inside the Hub container only. Paths, never key contents, in argv.
set -eu
key=${1:?Private minisign key file required}
pub=${2:?Public minisign file required}
[ "$(id -u)" = 0 ]
command -v minisign >/dev/null
hub_user=$(systemctl show enki-hub -p User --value)
hub_group=$(systemctl show enki-hub -p Group --value)
[ -n "$hub_user" ] && [ -n "$hub_group" ]
getent passwd enki-release-signer >/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin enki-release-signer
install -d -m 700 -o enki-release-signer -g "$hub_group" /etc/enki-release-signer
# Existing keys are never replaced silently.
if [ -e /etc/enki-release-signer/release.key ]; then
 cmp -s "$key" /etc/enki-release-signer/release.key
 cmp -s "$pub" /etc/enki-release-signer/release.pub
else
 install -m 600 -o enki-release-signer -g "$hub_group" "$key" /etc/enki-release-signer/release.key
 install -m 600 -o enki-release-signer -g "$hub_group" "$pub" /etc/enki-release-signer/release.pub
fi
printf 'ENKI_HUB_UID=%s\n' "$(id -u "$hub_user")" > /etc/enki-release-signer/service.env
chmod 600 /etc/enki-release-signer/service.env
sed "s/^Group=enki-hub$/Group=$hub_group/" /opt/enki-hub/deploy/enki-release-signer.service > /etc/systemd/system/enki-release-signer.service
chown root:root /opt/enki-hub /opt/enki-hub/release_signer.py /opt/enki-hub/device_updates.py /opt/enki-hub/releases.py /opt/enki-hub/durable.py /opt/enki-hub/native_updates.py
systemctl daemon-reload
systemctl enable --now enki-release-signer
