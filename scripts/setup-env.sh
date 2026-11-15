#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then
  echo "Usage: ./scripts/setup-env.sh https://relayproof.example.com" >&2
  exit 1
fi
case "$1" in
  https://*) ;;
  *) echo "Set the public HTTPS origin." >&2; exit 1 ;;
esac
case "$1" in
  *[!a-zA-Z0-9.:/-]*) echo "Enter a valid HTTPS URL." >&2; exit 1 ;;
esac
umask 077
set -C
{
  printf 'APP_URL=%s\n' "$1"
  printf 'COOKIE_SECURE=true\nLOCAL_PORT=3000\nALLOW_SIGNUP=false\n'
  printf 'DB_ADMIN_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'DB_APP_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'RELAY_ENCRYPTION_KEY=%s\n' "$(openssl rand -base64 32)"
} > .env
