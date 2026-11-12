<#
=====================================================================
  е-Фактура – агент за новиот сервер: праќање на фактури до УЈП (docs/15)

  Во апликацијата: фактура → „Прати на УЈП“ (или „Прати на УЈП (N)“ во листата).
  Оваа скрипта, на компјутерот со USB токенот:
    1. зема фактури од редицата на серверот (JSON го гради серверот);
    2. продавачот и купувачот ги освежува од регистарот на УЈП (мора да се
       идентични со регистарот – E1000), називи од шифрарниците на УЈП;
    3. потпишува со сертификатот од токенот (JWS RS256; драјверот бара PIN);
    4. праќа на УЈП и го враќа резултатот (EUID, QR или грешка) на серверот.

  Користи ги истите поставки и клуч како Sync-ServerRegistry.ps1
  (agent.config.psd1: EujpId, CertThumbprint, CertSerialNumber; server-agent.key).

  Пуштање (PowerShell 7, со вметнат токен):
     .\Send-ServerInvoices.ps1                  (еднаш ги праќа чекачките)
     .\Send-ServerInvoices.ps1 -Watch           (следи 8 часа, проверува на секои 10 с)
     .\Send-ServerInvoices.ps1 -Watch -Minutes 60
=====================================================================
#>
#Requires -Version 7.4
param([switch]$Watch, [int]$Minutes = 480,
      [string]$ConfigPath = "$PSScriptRoot\agent.config.psd1",
      [string]$ServerUrl)
$ErrorActionPreference = "Stop"
$KeyFile = Join-Path $PSScriptRoot "server-agent.key"

Import-Module "$PSScriptRoot\UjpAgent.psm1" -Force
$cfg = Import-PowerShellDataFile $ConfigPath
if (-not $cfg.AllowProduction -and ($cfg.SendUrl -notmatch 'efakturatest\.' -or $cfg.ApiBaseUrl -notmatch 'efakturatest\.')) {
    throw "Конфигурацијата не покажува кон тест околината на УЈП (efakturatest). За производство: AllowProduction = `$true."
}
if (-not $ServerUrl) { $ServerUrl = if ($cfg.ServerUrl) { $cfg.ServerUrl } else { "https://92-5-149-62.sslip.io" } }
if (-not (Test-Path $KeyFile)) { throw "Нема клуч за серверот. Пушти: .\Sync-ServerRegistry.ps1 -SetKey" }
$key = [Net.NetworkCredential]::new("", ((Get-Content $KeyFile -Raw).Trim() | ConvertTo-SecureString)).Password
$Headers = @{ "x-agent-key" = $key; "x-efaktura" = "1" }

function Invoke-Server([string]$Method, [string]$Path, $Body) {
    $p = @{ Method = $Method; Uri = "$($ServerUrl.TrimEnd('/'))$Path"; Headers = $Headers; TimeoutSec = 60 }
    if ($null -ne $Body) {
        $p.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 5 -Compress))
        $p.ContentType = "application/json; charset=utf-8"
    }
    Invoke-RestMethod @p
}

# --- сертификат од токенот (истите проверки како Send-UjpInvoices.ps1)
$cert = Get-UjpCertificate -Thumbprint $cfg.CertThumbprint
$serialDec = ConvertTo-UjpSerialDecimal $cert.SerialNumber
if ($cfg.CertSerialNumber -and [string]$cfg.CertSerialNumber -ne $serialDec) {
    throw "Сертификатот од токенот (сериски $serialDec) не е оној во поставките ($($cfg.CertSerialNumber)). Пушти .\Test-AgentReady.ps1 -Fix"
}
if ($cert.NotAfter -lt (Get-Date)) { throw "Сертификатот е истечен ($($cert.NotAfter.ToString('dd.MM.yyyy')))." }
Write-Host "Сертификат: $($cert.Subject) (сериски $serialDec, важи до $($cert.NotAfter.ToString('dd.MM.yyyy')))"
$off = Sync-UjpClock -Config $cfg
Write-Host "Сервер: $ServerUrl   УЈП: $($cfg.SendUrl)   часовник: $([int]$off.TotalSeconds) s $(if ($Watch) { "  (следи $Minutes мин., Ctrl+C за крај)" })" -ForegroundColor Cyan

$companyCache = @{}; $namesCache = @{}
function Get-Names([string]$SellerEdb, [string]$DocType) {
    $k = "$SellerEdb|$DocType"
    if ($namesCache.ContainsKey($k)) { return $namesCache[$k] }
    $n = @{
        Payment    = Get-UjpCodeNames -Config $cfg -SellerEdb $SellerEdb -Path "payment-types" -ListProperty "paymentTypeList" -NameProperty "description"
        Void       = Get-UjpCodeNames -Config $cfg -SellerEdb $SellerEdb -Path "void-reasons" -ListProperty "voidReasonList" -NameProperty "voidReason"
        Correction = Get-UjpCodeNames -Config $cfg -SellerEdb $SellerEdb -Path "correction-reason" -ListProperty "correctionReasonList" -NameProperty "correctionReason"
        Indicators = @{}
    }
    $r = Invoke-UjpApi -Method GET -Uri "$($cfg.ApiBaseUrl)/api/v1/doc-type-x-tax-indicator/$DocType" -Headers (Get-UjpHeaders -Config $cfg -SellerEdb $SellerEdb)
    if ($r.Status -eq 200 -and $r.Body.success) { foreach ($x in $r.Body.docTypeXTaxIndicatorList) { if ($x.active -ne $false) { $n.Indicators[[string]$x.taxIndicatorCode] = $true } } }
    $namesCache[$k] = $n
    return $n
}
# Продавач/купувач од регистарот на УЈП (назив, адреса, ДДВ број); држава (назив) и е-пошта остануваат од апликацијата.
function Set-Party($Doc, [string]$Role, [string]$SellerEdb) {
    $x = $Doc[$Role]; $edb = [string]$x["${Role}Tin"]
    if (-not $companyCache.ContainsKey($edb)) { $companyCache[$edb] = Get-UjpCompany -Config $cfg -SellerEdb $SellerEdb -TaxNumber $edb }
    $c = $companyCache[$edb]; $was = [string]$x["${Role}Name"]
    $x["${Role}CCode"] = $c.CCode; $x["${Role}Tin"] = $c.Tin; $x["${Role}VatNumber"] = if ($c.VatNumber) { $c.VatNumber } else { $null }; $x["${Role}Name"] = $c.Name
    $x["${Role}Address"] = [ordered]@{ streetAddress = $c.Street; streetNumber = $c.Number; postalCode = $c.PostalCode; city = $c.City }
    if ($was.Trim() -ne ([string]$c.Name).Trim()) { return "Назив ($Role) од регистарот: '$($c.Name)' (во апликацијата: '$was')." }
}

$end = (Get-Date).AddMinutes($Minutes); $done = 0; $lastErr = ""
do {
    try { $jobs = @((Invoke-Server POST "/api/agent/ujp-jobs/take" @{ limit = 5 }) | ForEach-Object { $_ } | Where-Object { $_ -and $_.jobId }); $lastErr = "" }
    catch {
        $m = $_.Exception.Message
        if ($m -ne $lastErr) { Write-Host "  ! Серверот: $m" -ForegroundColor Red; $lastErr = $m }
        if ($m -match '401') { throw "Клучот е неважечки или деактивиран. Направи нов во апликацијата и пушти .\Sync-ServerRegistry.ps1 -SetKey." }
        $jobs = @()
    }
    foreach ($j in $jobs) {
        $res = $null
        try {
            # JSON од серверот -> подреден hashtable (редоследот на полињата останува ист)
            $payload = $j.payload | ConvertTo-Json -Depth 30 -Compress | ConvertFrom-Json -AsHashtable
            $doc = $payload["document"]; $sellerEdb = [string]$j.sellerEdb
            $warn = @(@((Set-Party $doc "seller" $sellerEdb), (Set-Party $doc "buyer" $sellerEdb)) | Where-Object { $_ })
            $names = Get-Names -SellerEdb $sellerEdb -DocType $j.docType
            $pc = [string]$doc["docPayment"]["docPaymentTypeCode"]
            if ($pc -and $names.Payment[$pc]) { $doc["docPayment"]["docPaymentTypeDesc"] = $names.Payment[$pc] }
            if ($payload.Contains("voidReason") -and $names.Void[[string]$payload["voidReason"]["voidCode"]]) { $payload["voidReason"]["voidReason"] = $names.Void[[string]$payload["voidReason"]["voidCode"]] }
            if ($payload.Contains("correctionReason") -and $names.Correction[[string]$payload["correctionReason"]["correctionReasonCode"]]) {
                $payload["correctionReason"]["correctionReason"] = $names.Correction[[string]$payload["correctionReason"]["correctionReasonCode"]] }
            $problems = Test-UjpPayload -Payload $payload -Names $names
            if ($problems.Count) { throw ("Не е испратено (проверка): " + ($problems -join " ")) }

            $res = Send-UjpDocument -Config $cfg -Payload $payload -Certificate $cert
            $msg = $res.Raw + $(if ($warn) { "`n" + ($warn -join "`n") })
            Invoke-Server POST "/api/agent/ujp-jobs/$($j.jobId)" @{ ok = [bool]$res.Ok; httpStatus = $res.Status; euid = $res.Euid; qrLink = $res.QrLink
                timestamp = $res.Timestamp; message = $msg; request = $res.Json } | Out-Null
            if ($res.Ok) { Write-Host ("  ✓ {0} {1} – EUID {2}" -f (Get-Date -Format "HH:mm:ss"), $j.number, $res.Euid) -ForegroundColor Green }
            else { Write-Host ("  ✗ {0} {1} – УЈП: HTTP {2} {3}" -f (Get-Date -Format "HH:mm:ss"), $j.number, $res.Status, $res.Raw) -ForegroundColor Red }
            foreach ($w in $warn) { Write-Host "    ! $w" -ForegroundColor Yellow }
        }
        catch {
            $msg = $_.Exception.Message
            try { Invoke-Server POST "/api/agent/ujp-jobs/$($j.jobId)" @{ ok = $false; httpStatus = $(if ($res) { $res.Status } else { $null }); message = $msg } | Out-Null } catch { }
            Write-Host ("  ✗ {0} {1} – {2}" -f (Get-Date -Format "HH:mm:ss"), $j.number, $msg) -ForegroundColor Red
        }
        $done++
    }
    if ($Watch) { Start-Sleep -Seconds 10 }
} while ($Watch -and (Get-Date) -lt $end)
Write-Host "Обработени фактури: $done" -ForegroundColor Cyan
