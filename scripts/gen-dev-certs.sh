#!/usr/bin/env bash
#
# Generates a self-signed CA plus a server and a client certificate for local
# mutual-TLS work. Development only: these are not certificates any
# jurisdiction will trust, and the private keys are written unencrypted.
#
#   ./scripts/gen-dev-certs.sh [outdir]        (default: ./certs)
#
# Then:
#   PORTAGE_TLS_CERT=certs/server.crt \
#   PORTAGE_TLS_KEY=certs/server.key \
#   PORTAGE_TLS_CLIENT_CA=certs/ca.crt \
#   npm start
#
#   curl --cacert certs/ca.crt --cert certs/client.crt --key certs/client.key \
#        https://localhost:8686/api/health
set -euo pipefail

OUT="${1:-certs}"
DAYS=365
mkdir -p "$OUT"

echo "generating dev CA"
openssl req -x509 -newkey rsa:2048 -nodes -days "$DAYS" \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt" \
  -subj "/CN=Portage Dev CA" 2>/dev/null

gen() {
  local name="$1" cn="$2" ext="$3"
  echo "generating $name certificate ($cn)"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$OUT/$name.key" -out "$OUT/$name.csr" \
    -subj "/CN=$cn" 2>/dev/null
  openssl x509 -req -in "$OUT/$name.csr" \
    -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
    -out "$OUT/$name.crt" -days "$DAYS" \
    -extfile <(printf '%s' "$ext") 2>/dev/null
  rm -f "$OUT/$name.csr"
}

gen server localhost "subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth"

gen client portage-client "extendedKeyUsage=clientAuth"

rm -f "$OUT/ca.srl"
chmod 600 "$OUT"/*.key

echo
echo "wrote to $OUT/:"
echo "  ca.crt      trust anchor for both sides"
echo "  server.crt  PORTAGE_TLS_CERT      server.key  PORTAGE_TLS_KEY"
echo "  client.crt  curl --cert           client.key  curl --key"
