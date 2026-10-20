#!/bin/sh
set -u
usage() {
  echo "Uso: office-sync.sh <slug> <planta> [<planta>...] [--ref <rama>]" >&2
  exit 64
}
[ $# -ge 2 ] || usage
slug="$1"
shift
case "$slug" in
  ''|*[!a-z0-9_-]*|[!a-z0-9]*) echo "Slug no válido: usa minúsculas, números y guiones." >&2; exit 64 ;;
esac
floors=""
ref=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      [ $# -ge 2 ] || usage
      ref="$2"
      shift 2
      continue
      ;;
    *)
      case "$1" in
        ''|*[!a-z0-9-]*) echo "Planta no válida: $1" >&2; exit 64 ;;
      esac
      floors="$floors${floors:+,}\"$1\""
      ;;
  esac
  shift
done
[ -n "$floors" ] || usage
if [ -n "$ref" ]; then
  case "$ref" in
    *[!A-Za-z0-9._/-]*|-*|*..*) echo "Rama no válida: $ref" >&2; exit 64 ;;
  esac
  body="{\"slug\":\"$slug\",\"floors\":[$floors],\"ref\":\"$ref\"}"
else
  body="{\"slug\":\"$slug\",\"floors\":[$floors]}"
fi
dir="${AGENT_OFFICE_HOME:-$HOME/.config/agent-office}"
if [ ! -r "$dir/headers" ]; then
  echo "No hay key de Agent Office en $dir: el hub no está configurado." >&2
  exit 69
fi
port=
read -r port 2>/dev/null < "$dir/port"
[ -n "$port" ] || port=4747
nl='
'
out=$(curl -sS -m 600 -w "$nl%{http_code}" -X POST "http://127.0.0.1:$port/api/redaccion/sync?format=text" \
  -H "Content-Type: application/json" \
  -H @"$dir/headers" \
  --data-binary "$body")
status=$?
if [ $status -ne 0 ]; then
  echo "No se pudo hablar con el hub de Agent Office en el puerto $port (curl $status)." >&2
  exit 69
fi
code="${out##*"$nl"}"
body="${out%"$nl"*}"
case "$code" in
  2??) printf '%s' "$body" ;;
  *)
    printf '%s' "$body" >&2
    exit 1
    ;;
esac
