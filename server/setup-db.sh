#!/bin/bash
# Instalación nueva: crea la base "amigos" (ya con todas las migraciones), su usuario con permisos
# mínimos y el .env con una clave al azar. Una sola vez; para actualizar después, usar migrate.sh.
# Uso (en el servidor, como ubuntu): bash /opt/amigos/server/setup-db.sh
set -e
cd "$(dirname "$0")"
[ -f .env ] && { echo ".env ya existe: no hago nada"; exit 1; }
PW="$(openssl rand -base64 24 | tr -d '/+=')-Aa9"  # sufijo: validate_password exige mayúscula, dígito y símbolo
{ cat schema.sql
  echo "CREATE USER 'amigos'@'localhost' IDENTIFIED BY '$PW';"
  echo "GRANT SELECT, INSERT, UPDATE, DELETE ON amigos.* TO 'amigos'@'localhost';"
  # schema.sql ya incluye todas las migraciones existentes: se marcan como aplicadas.
  for f in migrations/*.sql; do echo "INSERT INTO amigos.schema_migrations (name) VALUES ('$(basename "$f")');"; done
} | sudo mysql
(umask 077; sed "s|^DB_PASSWORD=.*|DB_PASSWORD=$PW|" .env.example > .env)
echo "Listo: base amigos creada y .env escrito. Editá ORIGIN en server/.env con tu dominio."
