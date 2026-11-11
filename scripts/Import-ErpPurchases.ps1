<#
  Uvoz na vleznite fakturi od ERPNext vo UPSTREAM (docs/11).
  Raspored: (1) raspredeluvanje na slikata, (2) proba bez zapis, (3) potvrda, (4) bekap + uvoz, (5) brisenje na datotekata od serverot.
  Ne bara lozinki: koristi go SSH klucot. Ne se pusta so sudo/Administrator.

  .\Import-ErpPurchases.ps1 -Email adis@... [-Tag 20261111-xxxxxxx] [-SkipDeploy]
#>
param(
  [Parameter(Mandatory)] [string] $Email,                 # e-poshta so koja se najavuvash vo aplikacijata
  [string] $Tag = "__TAG__",
  [string] $File = "$PSScriptRoot\upstream-purchases.json",
  [switch] $SkipDeploy
)
$ErrorActionPreference = "Stop"
$k = "$env:USERPROFILE\.ssh\oracle-efaktura.key"; $s = "ubuntu@92.5.149.62"; $edb = "4015023508550"
$run = "cd /opt/efaktura && sudo docker compose exec -T api node dist/tools/import-erpnext-docs.js - --client $edb --user $Email"

function Step($t) { Write-Host "`n== $t ==" -ForegroundColor Cyan }
function Check($what) { if ($LASTEXITCODE -ne 0) { throw "$what ne uspea (kod $LASTEXITCODE)." } }

if (-not (Test-Path $File)) { throw "Ja nema datotekata $File" }

if (-not $SkipDeploy) {
  Step "1/4 Raspredeluvanje na $Tag"
  ssh -i $k $s "sudo bash ~/efaktura-deploy/03-deploy.sh $Tag"; Check "Raspredeluvanjeto"
}

Step "2/4 Kopiranje i PROBA (nisto ne se zapisuva)"
scp -i $k "$File" "${s}:upstream-purchases.json"; Check "Kopiranjeto"
ssh -i $k $s "$run --dry-run < ~/upstream-purchases.json"; Check "Probata"

Step "3/4 Potvrda"
$ans = Read-Host "Gi vidovte brojkite od probata. Da se vnesat vo UPSTREAM? (da/ne)"
if ($ans -ne "da") {
  ssh -i $k $s "rm -f ~/upstream-purchases.json" | Out-Null
  Write-Host "Otkazano. Nisto ne e vneseno; datotekata e izbrishana od serverot." -ForegroundColor Yellow
  exit 0
}

Step "4/4 Bekap + uvoz"
ssh -i $k $s "sudo bash /opt/efaktura/bin/04-backup.sh && $run < ~/upstream-purchases.json; rc=`$?; rm -f ~/upstream-purchases.json; exit `$rc"; Check "Uvozot"
Write-Host "`nGOTOVO. Proverete vo aplikacijata: Vlezni fakturi (oznaka ERP)." -ForegroundColor Green
