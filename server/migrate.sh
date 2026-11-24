#!/bin/bash
# Aplica las migraciones nuevas de server/migrations, una sola vez cada una y en orden.
# Uso (en el servidor): bash /opt/amigos/server/migrate.sh [base]   (por defecto: amigos)
set -euo pipefail
cd "$(dirname "$0")"
DB="${1:-amigos}"

sudo mysql "$DB" -e "CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)"
pending=0
for f in migrations/*.sql; do
  name=$(basename "$f")
  [ -n "$(sudo mysql -N "$DB" -e "SELECT 1 FROM schema_migrations WHERE name = '$name'")" ] && continue
  sudo mysql "$DB" < "$f"
  sudo mysql "$DB" -e "INSERT INTO schema_migrations (name) VALUES ('$name')"
  echo "aplicada: $name"
  pending=1
done
[ "$pending" = 1 ] || echo "La base $DB ya está al día."
