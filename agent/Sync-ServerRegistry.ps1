<#
=====================================================================
  е-Фактура – агент за новиот сервер: барања до регистарот на УЈП

  УЈП не е достапен од серверот (IP филтер), па апликацијата прави барање
  („Повлечи од УЈП“, „Провери во УЈП“), а оваа скрипта на компјутерот со
  пристап до УЈП го зема, го прашува УЈП (GET /api/v1/companies/{ЕДБ},
  без токен – само читање) и го враќа резултатот на серверот.

  Клучот за серверот (од апликацијата: Корисници и пристап → Агент → Нов клуч)
  се чува шифриран со Windows DPAPI во server-agent.key (само оваа Windows
  сметка на овој компјутер може да го прочита). Не се пишува во agent.config.psd1.

  Пуштање (PowerShell 7):
     .\Sync-ServerRegistry.ps1 -SetKey            (еднаш: го внесуваш клучот)
     .\Sync-ServerRegistry.ps1                    (еднаш ги обработува чекачките барања)
     .\Sync-ServerRegistry.ps1 -Watch             (следи 8 часа, проверува на секои 4 с)
     .\Sync-ServerRegistry.ps1 -Watch -Minutes 60
=====================================================================
#>
#Requires -Version 7
param([switch]$SetKey, [switch]$Watch, [int]$Minutes = 480,
      [string]$ConfigPath = "$PSScriptRoot\agent.config.psd1",
      [string]$ServerUrl)
$ErrorActionPreference = "Stop"
$KeyFile = Join-Path $PSScriptRoot "server-agent.key"

if ($SetKey) {
    $s = Read-Host "Залепи го клучот за агентот (efa_...)" -AsSecureString
    $plain = [Net.NetworkCredential]::new("", $s).Password.Trim()
    if ($plain -notmatch '^efa_[A-Za-z0-9_-]{30,}$') { throw "Ова не личи на клуч од апликацијата (почнува со efa_)." }
    ConvertFrom-SecureString -SecureString (ConvertTo-SecureString $plain -AsPlainText -Force) | Set-Content -Path $KeyFile -Encoding ascii
    Write-Host "Клучот е зачуван шифриран во $KeyFile" -ForegroundColor Green
    return
}

Import-Module "$PSScriptRoot\UjpAgent.psm1" -Force
$cfg = Import-PowerShellDataFile $ConfigPath
if (-not $cfg.AllowProduction -and $cfg.ApiBaseUrl -notmatch 'efakturatest\.') { throw "Конфигурацијата не покажува кон тест околината на УЈП." }
if (-not $ServerUrl) { $ServerUrl = if ($cfg.ServerUrl) { $cfg.ServerUrl } else { "https://92-5-149-62.sslip.io" } }
if (-not (Test-Path $KeyFile)) { throw "Нема клуч за серверот. Пушти: .\Sync-ServerRegistry.ps1 -SetKey" }
$sec = (Get-Content $KeyFile -Raw).Trim() | ConvertTo-SecureString
$key = [Net.NetworkCredential]::new("", $sec).Password
$Headers = @{ "x-agent-key" = $key; "x-efaktura" = "1" }

function Invoke-Server([string]$Method, [string]$Path, $Body) {
    $p = @{ Method = $Method; Uri = "$($ServerUrl.TrimEnd('/'))$Path"; Headers = $Headers; TimeoutSec = 30 }
    if ($null -ne $Body) {
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 5 -Compress))
        $p.ContentType = "application/json; charset=utf-8"
    }
    Invoke-RestMethod @p
}

Write-Host "Сервер: $ServerUrl   УЈП: $($cfg.ApiBaseUrl)   $(if ($Watch) { "(следи $Minutes мин., Ctrl+C за крај)" })" -ForegroundColor Cyan
$end = (Get-Date).AddMinutes($Minutes); $done = 0; $lastErr = ""
do {
    # Invoke-RestMethod ja vrakja JSON listata kako EDEN objekt -> se razviva i se filtrira (prazno [] = nema baranja)
    try { $reqs = @((Invoke-Server GET "/api/agent/registry-requests" $null) | ForEach-Object { $_ } | Where-Object { $_ -and $_.id }); $lastErr = "" }
    catch {
        $m = $_.Exception.Message
        if ($m -ne $lastErr) { Write-Host "  ! Серверот: $m" -ForegroundColor Red; $lastErr = $m }
        if ($m -match '401') { throw "Клучот е неважечки или деактивиран. Направи нов во апликацијата и пушти -SetKey." }
        $reqs = @()
    }
    foreach ($r in $reqs) {
        try {
            $c = Get-UjpCompany -Config $cfg -SellerEdb $r.sellerEdb -TaxNumber $r.edb
            $company = [ordered]@{
                name = [string]$c.Name; address = ((@($c.Street, $c.Number) | Where-Object { $_ }) -join " ")
                city = [string]$c.City; postalCode = [string]$c.PostalCode; vatNumber = [string]$c.VatNumber
                embs = [string]$c.RegNo; countryCode = [string]$c.CCode
            }
            Invoke-Server POST "/api/agent/registry-requests/$($r.id)" @{ ok = $true; company = $company } | Out-Null
            Write-Host ("  ✓ {0} {1} – {2}" -f (Get-Date -Format "HH:mm:ss"), $r.edb, $company.name) -ForegroundColor Green
        }
        catch {
            $msg = $_.Exception.Message.Split([Environment]::NewLine)[0]
            try { Invoke-Server POST "/api/agent/registry-requests/$($r.id)" @{ ok = $false; error = $msg } | Out-Null } catch { }
            Write-Host ("  ✗ {0} {1} – {2}" -f (Get-Date -Format "HH:mm:ss"), $r.edb, $msg) -ForegroundColor Red
        }
        $done++
    }
    if ($Watch) { Start-Sleep -Seconds 4 }
} while ($Watch -and (Get-Date) -lt $end)
Write-Host "Обработени барања: $done" -ForegroundColor Cyan
