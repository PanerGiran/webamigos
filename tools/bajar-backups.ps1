# Baja los backups del servidor a esta PC (copia fuera del servidor, por si se pierde).
# Uso:
#   powershell -ExecutionPolicy Bypass -File tools\bajar-backups.ps1 -Servidor ubuntu@203.0.113.10
#   (opcional) -Clave "$HOME\.ssh\mi_clave"   -Destino "D:\Backups\amigos"
# Guarda en <tu usuario>\Backups\amigos (o -Destino) y conserva 8 semanas.
param(
  [Parameter(Mandatory = $true)][string]$Servidor,
  [string]$Clave = "$HOME\.ssh\id_ed25519",
  [string]$Destino = (Join-Path $HOME 'Backups\amigos')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Destino | Out-Null

# -p conserva la fecha original, que es la que usa la limpieza de abajo.
scp -q -p -i $Clave -o IdentitiesOnly=yes -o BatchMode=yes "${Servidor}:backups/amigos-*" $Destino
if ($LASTEXITCODE -ne 0) { throw "No se pudieron bajar los backups (scp salió con $LASTEXITCODE)." }

Get-ChildItem $Destino -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-56) | Remove-Item
$last = Get-ChildItem $Destino -Filter 'amigos-db-*' | Sort-Object LastWriteTime | Select-Object -Last 1
Write-Output "Listo: $((Get-ChildItem $Destino -File).Count) archivos en $Destino (último: $($last.Name))"
