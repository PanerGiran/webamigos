# Amigos

Una red social privada para tu grupo de amigos, en tu propio servidor. Sirve para compartir memes y fotos, comentar, reaccionar y chatear, sin registro público: el admin invita a cada persona con un link.

Está pensada para grupos chicos (menos de unas 20 personas) y anda en un servidor gratuito de 1 GB de RAM.

## Qué trae

- **Feed** de posts con texto y fotos, scroll infinito, reacciones con emoji y comentarios.
- **Chat del grupo** en vivo (WebSocket), con historial y quién está conectado.
- **Perfiles**: foto de perfil, una sección para publicar solo en tu perfil y otra con lo que publicaste en el feed.
- **Notificaciones push** de posts nuevos, comentarios en tus posts y mensajes del chat. Se eligen por persona y se activan en cada dispositivo.
- **App instalable** (PWA) en Android, iPhone y PC, que abre aunque no haya conexión.
- **Panel de admin**: crear cuentas con link de invitación, resetear accesos, bloquear y eliminar (con borrado lógico).
- **Privacidad**: las fotos se reprocesan y pierden los metadatos (incluida la ubicación GPS), y solo se ven con sesión iniciada.
- **Backups** diarios verificados, con un script para bajarlos a tu PC.
- Modo claro y oscuro, pensado primero para el celular.

## Cómo está hecho

- **Servidor:** Node.js + Express, MySQL 8, WebSocket (`ws`), `sharp` para las imágenes y `argon2` para las contraseñas.
- **Web:** HTML, CSS y JavaScript sin frameworks y sin paso de compilación (carpeta `web/`).
- **En producción:** Apache hace de proxy y maneja el HTTPS (Let's Encrypt). Node escucha solo en `127.0.0.1:3000` y corre con systemd como un usuario sin privilegios.

```
Navegador / app ── HTTPS ──▶ Apache ──▶ Node (127.0.0.1:3000) ──▶ MySQL (127.0.0.1)
                                              └──▶ /var/lib/amigos/uploads (fotos)
```

## Lo que necesitás

- Un **servidor Linux** con IP pública. Está probado en **Ubuntu 24.04** con 1 GB de RAM; por ejemplo, el plan gratis de Oracle Cloud.
- Un **dominio** que apunte a esa IP. Puede ser uno gratis, como No-IP o DuckDNS.
- Los puertos **80 y 443** abiertos, también en el firewall del proveedor (en Oracle Cloud es la "Security List" de la VCN).

## Instalación

Todo se hace en el servidor, conectado por SSH con un usuario que tenga `sudo` (en estos ejemplos, `ubuntu`). Donde dice `tu-dominio.com`, poné el tuyo.

### 1. Paquetes

```bash
sudo apt update
sudo apt install -y apache2 mysql-server certbot python3-certbot-apache git

# Node.js LTS desde el repositorio oficial de NodeSource (22 o superior;
# cambiá el 26 por la LTS vigente que figura en nodejs.org)
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_26.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt update && sudo apt install -y nodejs
```

Si tu servidor tiene **1 GB de RAM**, conviene achicar MySQL. Creá `/etc/mysql/mysql.conf.d/zz-low-mem.cnf` con esto y reiniciá MySQL (`sudo systemctl restart mysql`):

```ini
[mysqld]
performance_schema = OFF
innodb_buffer_pool_size = 64M
innodb_log_buffer_size = 8M
max_connections = 20
key_buffer_size = 8M
tmp_table_size = 16M
max_heap_table_size = 16M
```

También ayuda tener 1 o 2 GB de swap.

### 2. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

> **Oracle Cloud:** además de la Security List, las imágenes de Ubuntu de Oracle traen reglas en `/etc/iptables/rules.v4` que bloquean todo menos SSH al reiniciar. Agregá ahí las líneas para los puertos 80 y 443, antes del `REJECT`:
> `-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT` (y lo mismo con 443).

### 3. Código, usuario y carpetas

```bash
sudo useradd --system --home-dir /opt/amigos --shell /usr/sbin/nologin amigos
sudo git clone https://github.com/PanerGiran/webamigos.git /opt/amigos
sudo chown -R "$USER": /opt/amigos
sudo install -d -o amigos -g amigos -m 0750 /var/lib/amigos /var/lib/amigos/uploads
cd /opt/amigos/server && npm ci --omit=dev
```

### 4. Base de datos y configuración

```bash
cd /opt/amigos/server
bash setup-db.sh
```

El script crea la base `amigos`, un usuario de MySQL que solo puede leer y escribir datos, y el archivo `server/.env` con una clave al azar. Usa `sudo mysql`, que en Ubuntu entra como root sin contraseña. Si tu root de MySQL tiene contraseña, poné `[client]` con `user=root` y `password=...` en `/root/.my.cnf` (con permisos 600).

Después editá `server/.env` y poné tu dominio:

```bash
nano /opt/amigos/server/.env   # ORIGIN=https://tu-dominio.com
```

**Notificaciones push (opcional):** generá las claves en el servidor y se agregan solas al `.env`:

```bash
cd /opt/amigos/server
node -e "const k=require('web-push').generateVAPIDKeys(); console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey)" >> .env
```

### 5. Apache y HTTPS

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel headers
sudo tee /etc/apache2/sites-available/amigos.conf > /dev/null <<'EOF'
<VirtualHost *:80>
  ServerName tu-dominio.com
  ProxyPreserveHost On
  ProxyPass /.well-known/acme-challenge !
  ProxyPass /ws ws://127.0.0.1:3000/ws
  ProxyPassReverse /ws ws://127.0.0.1:3000/ws
  ProxyPass / http://127.0.0.1:3000/
  ProxyPassReverse / http://127.0.0.1:3000/
</VirtualHost>
EOF
sudo a2ensite amigos && sudo a2dissite 000-default && sudo systemctl reload apache2
sudo certbot --apache -d tu-dominio.com --redirect
```

Certbot pide un email para avisarte si el certificado está por vencer. Se renueva solo.

### 6. Servicio

```bash
sudo cp /opt/amigos/server/amigos.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now amigos
systemctl status amigos      # tiene que decir "active (running)"
```

El servicio corre como el usuario `amigos`, con un límite de 300 MB de RAM para no dejar sin memoria a MySQL.

### 7. Tu cuenta de admin

```bash
cd /opt/amigos/server
npm run create-user -- tu_usuario "Tu Nombre" admin
```

Te imprime un **link de invitación** (vale 48 h y sirve una sola vez). Abrilo, elegí tu contraseña y listo. Al resto del grupo lo invitás desde el **panel Admin** de la web.

### 8. Backups

```bash
sudo install -o root -g root -m 0755 /opt/amigos/server/backup.sh /usr/local/sbin/amigos-backup
echo '15 7 * * * root /usr/local/sbin/amigos-backup 2>&1 | logger -t amigos-backup' | sudo tee /etc/cron.d/amigos-backup
sudo /usr/local/sbin/amigos-backup   # probarlo una vez
```

Todos los días (a las 07:15 hora del servidor; cambiala en el cron si querés) guarda la base y las fotos en `/home/ubuntu/backups`, verificados y con 7 días de retención. Si tu usuario no es `ubuntu`, agregá `BACKUP_USER=tu_usuario` al principio de la línea del cron. Para ver cómo salió cada noche: `journalctl -t amigos-backup`.

**Guardá una copia fuera del servidor.** Desde Windows podés usar:

```powershell
powershell -ExecutionPolicy Bypass -File tools\bajar-backups.ps1 -Servidor ubuntu@IP-DE-TU-SERVIDOR -Clave "$HOME\.ssh\tu_clave"
```

Desde Linux o Mac: `scp 'ubuntu@IP:backups/amigos-*' ~/Backups/amigos/`.

Cómo restaurar está explicado al principio de [`server/backup.sh`](server/backup.sh).

## Uso diario

- **Invitar a alguien:** Admin → Nueva cuenta → te da un link para mandarle por privado.
- **Si alguien se olvidó la contraseña:** Admin → Resetear acceso → le mandás el link nuevo.
- **Bloquear o eliminar cuentas:** desde Admin. Eliminar es lógico: la cuenta deja de poder entrar, pero sus posts quedan.
- Lo mismo se puede hacer por consola con `npm run create-user` y `npm run reset-user -- usuario`.

## Actualizar

Cada tanto hay cambios nuevos. Para traerlos:

```bash
sudo /usr/local/sbin/amigos-backup          # por las dudas, un backup antes
cd /opt/amigos && git pull
cd server && npm ci --omit=dev
bash migrate.sh                             # aplica solo los cambios nuevos de la base
sudo systemctl restart amigos
```

`migrate.sh` lleva la cuenta de qué cambios de base ya se aplicaron, así que se puede correr siempre sin miedo. Si algo sale mal, `journalctl -u amigos -n 50` muestra el error.

## Tests (opcional)

Los tests usan una base aparte, `amigos_test`, para no tocar la real:

```bash
cd /opt/amigos/server
sed "1,2s/\bamigos\b/amigos_test/" schema.sql | sudo mysql
sudo mysql -e "GRANT SELECT, INSERT, UPDATE, DELETE ON amigos_test.* TO 'amigos'@'localhost'"
UPLOAD_DIR=$(mktemp -d) DB_NAME=amigos_test npm test
```

## Seguridad

- Contraseñas con `argon2id`, mínimo 10 caracteres. Las sesiones son tokens al azar y en la base solo se guarda su hash.
- Invitaciones de un solo uso que vencen a las 48 h.
- Límite de intentos en el login, en las subidas y en el chat.
- Las fotos se validan por su formato real, se achican y pierden los metadatos. Solo se sirven con sesión iniciada.
- CSP estricta, y todo el contenido de los usuarios se muestra como texto (nunca como HTML).
- MySQL y Node escuchan solo en `127.0.0.1`. A internet sale únicamente Apache con HTTPS.

## Licencia

[MIT](LICENSE). Usalo, cambialo y armá tu grupo.
