<#
=====================================================================
  е-Фактура агент – инсталација на компјутерот на клиентот (docs/15)

  Еднаш, со вметнат токен, во PowerShell 7, во папката на агентот:
     pwsh -ExecutionPolicy Bypass -File .\Install-Agent.ps1

  Што прави (сè само за тековниот Windows корисник, без администратор):
    1. ги „одблокира“ скриптите преземени од интернет;
    2. го бара клучот за агентот (од администраторот) и го чува шифриран (DPAPI);
    3. го наоѓа сертификатот од токенот и го запишува во agent.config.psd1;
    4. го бара ЕУЈП ИД (efakturatest → профил → «Кориснички податоци»);
    5. го проверува клучот на серверот и врската до УЈП;
    6. линк «efaktura-agent:» – копчето «Вклучи агент» во апликацијата
       (прелистувачот прашува за дозвола; линкот само го стартува агентот);
    7. закажана задача: агентот стартува сам при најава на Windows.

  Повторно пуштање е безбедно (ги менува само поставките што ги прашува).
  Отстранување:  pwsh -File .\Install-Agent.ps1 -Remove
=====================================================================
#>
#Requires -Version 7.4
param([switch]$Remove, [switch]$NoTask)
$ErrorActionPreference = "Stop"
$dir = $PSScriptRoot
$task = "eFaktura-agent"
$proto = "HKCU:\Software\Classes\efaktura-agent"
function Ok([string]$m) { Write-Host "  ✓ $m" -ForegroundColor Green }
function Step([string]$m) { Write-Host "`n$m" -ForegroundColor Cyan }

if ($Remove) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $task -Confirm:$false; Ok "Закажаната задача е отстранета" }
    if (Test-Path $proto) { Remove-Item $proto -Recurse -Force; Ok "Линкот efaktura-agent: е отстранет" }
    Write-Host "Папката и клучот ($dir\server-agent.key) избришете ги рачно." -ForegroundColor Yellow
    return
}

Step "1. Датотеки"
Get-ChildItem $dir -File | Unblock-File
foreach ($f in "UjpAgent.psm1", "Send-ServerInvoices.ps1", "agent.config.psd1") { if (-not (Test-Path (Join-Path $dir $f))) { throw "Недостасува $f – распакувај го целиот ZIP." } }
Import-Module (Join-Path $dir "UjpAgent.psm1") -Force
$cfgPath = Join-Path $dir "agent.config.psd1"
$cfg = Import-PowerShellDataFile $cfgPath
Ok "Папка: $dir"
function Set-Cfg([string]$Name, [string]$Value) {
    $t = Get-Content $cfgPath -Raw -Encoding UTF8
    if ($t -notmatch "(?m)^\s*$Name\s*=") { throw "Нема линија $Name во agent.config.psd1" }
    $t = [regex]::Replace($t, "(?m)^(\s*$Name\s*=\s*)""[^""]*""", { param($m) $m.Groups[1].Value + '"' + $Value + '"' })
    Set-Content $cfgPath -Value $t -Encoding utf8BOM -NoNewline
}

Step "2. Клуч за агентот"
$keyFile = Join-Path $dir "server-agent.key"
if ((Test-Path $keyFile) -and (Read-Host "Клучот веќе е внесен. Нов клуч? (д/Н)") -notmatch '^[дdDД]') { Ok "Се користи постоечкиот клуч" }
else {
    $sec = Read-Host "Залепи го клучот (efa_…) од администраторот" -AsSecureString
    $plain = [Net.NetworkCredential]::new("", $sec).Password.Trim()
    if ($plain -notmatch '^efa_[A-Za-z0-9_-]{30,}$') { throw "Ова не е клуч за агент (почнува со efa_)." }
    ConvertFrom-SecureString -SecureString (ConvertTo-SecureString $plain -AsPlainText -Force) | Set-Content $keyFile
    Ok "Клучот е зачуван шифриран (само овој Windows корисник може да го прочита)"
}
$key = [Net.NetworkCredential]::new("", ((Get-Content $keyFile -Raw).Trim() | ConvertTo-SecureString)).Password
try {
    $hello = Invoke-RestMethod -Method POST -Uri "$($cfg.ServerUrl.TrimEnd('/'))/api/agent/hello" -Headers @{ "x-agent-key" = $key; "x-efaktura" = "1" } `
        -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes((@{ version = "install"; computer = [Environment]::MachineName; user = [Environment]::UserName } | ConvertTo-Json)))
    Ok "Серверот го прифати клучот „$($hello.name)“. Фирми: $(if ($hello.firms) { ($hello.firms | ForEach-Object { "$($_.name) ($($_.edb))" }) -join ', ' } else { 'сите (бирото)' })"
} catch { throw "Серверот не го прифати клучот ($($_.Exception.Message)). Провери го клучот кај администраторот." }

Step "3. Сертификат од токенот"
$certs = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) })
if (-not $certs) { throw "Нема важечки сертификат со приватен клуч. Вметни го токенот; провери дека драјверот е инсталиран (certmgr.msc → Personal)." }
for ($i = 0; $i -lt $certs.Count; $i++) {
    Write-Host ("  [{0}] {1}`n      издавач: {2}`n      сериски {3}, важи до {4}" -f ($i + 1), $certs[$i].Subject, $certs[$i].Issuer, (ConvertTo-UjpSerialDecimal $certs[$i].SerialNumber), $certs[$i].NotAfter.ToString('dd.MM.yyyy'))
}
$n = if ($certs.Count -eq 1) { 1 } else { [int](Read-Host "Кој сертификат потпишува е-фактури? (1-$($certs.Count))") }
if ($n -lt 1 -or $n -gt $certs.Count) { throw "Погрешен избор." }
$cert = $certs[$n - 1]; $serial = ConvertTo-UjpSerialDecimal $cert.SerialNumber
Set-Cfg "CertThumbprint" $cert.Thumbprint; Set-Cfg "CertSerialNumber" $serial
Ok "Сертификат: $($cert.Subject), сериски $serial"
Write-Host "    Истиот сериски број мора да стои во efakturatest → профил → «Сериски број на сертификатот (ID)» (асоцирање со DigPotpis)." -ForegroundColor Yellow

Step "4. ЕУЈП ИД"
$cfg = Import-PowerShellDataFile $cfgPath
$id = Read-Host "ЕУЈП ИД (efakturatest → профил → Кориснички податоци)$(if ($cfg.EujpId) { " [Enter = $($cfg.EujpId)]" })"
if (-not $id) { $id = $cfg.EujpId }
if ($id -notmatch '^\d+$') { throw "ЕУЈП ИД е број (на пр. 11821)." }
Set-Cfg "EujpId" $id
Ok "ЕУЈП ИД: $id"

Step "5. Врска до УЈП"
$cfg = Import-PowerShellDataFile $cfgPath
$off = Sync-UjpClock -Config $cfg
Ok "УЈП одговара; разлика во часовникот $([int]$off.TotalSeconds) s"
if ([Math]::Abs($off.TotalSeconds) -gt 120) { Write-Host "    ! Поправи го часовникот (Settings → Time → Sync now)" -ForegroundColor Yellow }

$pwsh = (Get-Command pwsh -ErrorAction Stop).Source
$run = "`"$pwsh`" -NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'Send-ServerInvoices.ps1')`" -Watch -Minutes 14400"
Step "6. Линк „Вклучи агент“ (efaktura-agent:)"
# Линкот НЕ ги предава параметрите од страницата (%1) – само го стартува агентот.
New-Item -Path "$proto\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path $proto -Name "(default)" -Value "URL:е-Фактура агент"
Set-ItemProperty -Path $proto -Name "URL Protocol" -Value ""
Set-ItemProperty -Path "$proto\shell\open\command" -Name "(default)" -Value $run
Ok "Регистриран за корисникот $env:USERNAME"

if (-not $NoTask) {
    Step "7. Старт при најава на Windows"
    $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File `"$(Join-Path $dir 'Send-ServerInvoices.ps1')`" -Watch -Minutes 14400" -WorkingDirectory $dir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description "е-Фактура: агент за праќање на УЈП (потпис со токенот). docs/15" -Force | Out-Null
    Ok "Задачата „$task“: при најава (интерактивно – PIN-от за токенот се гледа на екранот)"
}

Write-Host "`nГОТОВО. Агентот сега стартува..." -ForegroundColor Green
Start-Process -FilePath $pwsh -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $dir 'Send-ServerInvoices.ps1')`" -Watch -Minutes 14400" -WorkingDirectory $dir
