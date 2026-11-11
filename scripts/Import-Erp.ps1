<#
  Uvoz od ERPNext vo UPSTREAM (docs/11): vlezni (upstream-purchases.json) ili izlezni fakturi (upstream-sales.json).
  Raspored: proba bez zapis -> potvrda "da" -> bekap -> uvoz -> brisenje na datotekata od serverot.
  Ne bara lozinki (SSH kluc). Ne se pusta kako Administrator.

  .\Import-Erp.ps1 -Email dev@upstream.mk -File .\upstream-sales.json [-Deploy 20261111-xxxxxxx]
#>
param(
  [Parameter(Mandatory)] [string] $Email,
  [Parameter(Mandatory)] [string] $File,
  [string] $Deploy
)
$ErrorActionPreference = "Stop"
$k = "$env:USERPROFILE\.ssh\oracle-efaktura.key"; $s = "ubuntu@92.5.149.62"; $edb = "4015023508550"
$run = "cd /opt/efaktura && sudo docker compose exec -T api node dist/tools/import-erpnext-docs.js - --client $edb --user $Email"
function Step($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what ne uspea (kod $LASTEXITCODE)." } }

$File = (Resolve-Path $File).Path

if ($Deploy) {
  Step "Raspredeluvanje na $Deploy"
  ssh -i $k $s "sudo bash ~/efaktura-deploy/03-deploy.sh $Deploy"
  # 141 = SIGPIPE vo informativniot del na 03-deploy.sh (O36); api e vekje gore
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 141) { throw "Raspredeluvanjeto ne uspea (kod $LASTEXITCODE)." }
}

Step "Kopiranje i PROBA (nisto ne se zapisuva)"
scp -i $k "$File" "${s}:erp-import.json"; Check "Kopiranjeto"
ssh -i $k $s "$run --dry-run < ~/erp-import.json"; Check "Probata"

$ans = Read-Host "`nGi vidovte brojkite od probata. Da se vnesat vo UPSTREAM? (da/ne)"
if ($ans -ne "da") {
  ssh -i $k $s "rm -f ~/erp-import.json" | Out-Null
  Write-Host "Otkazano. Nisto ne e vneseno; datotekata e izbrishana od serverot." -ForegroundColor Yellow
  exit 0
}

Step "Bekap + uvoz"
ssh -i $k $s "sudo bash /opt/efaktura/bin/04-backup.sh && $run < ~/erp-import.json; rc=`$?; rm -f ~/erp-import.json; exit `$rc"; Check "Uvozot"
Write-Host "`nGOTOVO. Proverete vo aplikacijata (oznaka ERP)." -ForegroundColor Green
