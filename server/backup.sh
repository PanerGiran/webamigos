#!/bin/bash
# Backup diario de Amigos: base de datos + fotos, con 7 días de retención.
# Se instala en /usr/local/sbin/amigos-backup y lo corre root desde /etc/cron.d/amigos-backup
# (mysqldump entra como root por socket, o con /root/.my.cnf si root tiene clave).
# Quedan en /home/$BACKUP_USER/backups (por defecto ubuntu), a nombre de ese usuario para poder bajarlos.
#
# Restaurar (en el servidor):
#   zcat amigos-db-AAAA-MM-DD.sql.gz | sudo mysql amigos
#   sudo tar -xzf amigos-fotos-AAAA-MM-DD.tar.gz -C /var/lib/amigos && sudo chown -R amigos:amigos /var/lib/amigos/uploads
#   sudo systemctl restart amigos
set -euo pipefail

BACKUP_USER="${BACKUP_USER:-ubuntu}"
DEST="/home/$BACKUP_USER/backups"
DAY=$(date +%F)
DB="$DEST/amigos-db-$DAY.sql.gz"
FOTOS="$DEST/amigos-fotos-$DAY.tar.gz"
umask 077 # tienen hashes de contraseñas: solo los lee el dueño
mkdir -p "$DEST"

# --single-transaction: copia consistente sin frenar la app. Se escribe a .tmp para no dejar un archivo a medias.
mysqldump --single-transaction --quick --no-tablespaces amigos | gzip > "$DB.tmp"
tar -czf "$FOTOS.tmp" -C /var/lib/amigos uploads

# Se verifica antes de darlo por bueno.
gzip -t "$DB.tmp"
zcat "$DB.tmp" | tail -1 | grep -q 'Dump completed'
tar -tzf "$FOTOS.tmp" > /dev/null
mv "$DB.tmp" "$DB"
mv "$FOTOS.tmp" "$FOTOS"

find "$DEST" -name 'amigos-*' -mtime +6 -delete
chown -R "$BACKUP_USER:$BACKUP_USER" "$DEST"
echo "ok: $(du -h "$DB" | cut -f1) base, $(du -h "$FOTOS" | cut -f1) fotos"
