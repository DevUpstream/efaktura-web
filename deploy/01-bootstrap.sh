#!/usr/bin/env bash
# 01-bootstrap.sh - Faza 0: swap, azuriranja, firewall 80/443, Docker
# Se pusta so: sudo bash /tmp/01-bootstrap.sh   (moze povekje pati - idempotentno)
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "== 1/5 Swap 2 GB =="
if ! swapon --show | grep -q '/swapfile'; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi
grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-efaktura.conf
sysctl -p /etc/sysctl.d/99-efaktura.conf >/dev/null

echo "== 2/5 Azuriranja i alatki =="
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl git nano htop unattended-upgrades iptables-persistent
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CFG'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CFG
timedatectl set-timezone Europe/Skopje || true

echo "== 3/5 Firewall: 80 i 443 pred REJECT =="
for p in 443 80; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null; then
    n=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')
    iptables -I INPUT "${n:-1}" -p tcp -m state --state NEW --dport "$p" -j ACCEPT
  fi
done
netfilter-persistent save   # se zacuvuva PRED Docker, za da ne se zacuvaat Docker pravilata

echo "== 4/5 Docker =="
apt-get -y -q install docker.io
apt-get -y -q install docker-compose-v2 || apt-get -y -q install docker-compose-plugin
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'CFG'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
CFG
systemctl enable docker >/dev/null
systemctl restart docker
usermod -aG docker ubuntu

echo "== 5/5 Rezultat =="
free -m
swapon --show
iptables -L INPUT -n --line-numbers
docker --version
docker compose version
[ -f /var/run/reboot-required ] && echo "!! POTREBEN REBOOT (prasaj pred da napravis)" || echo "Reboot ne e potreben"
echo "GOTOVO"
