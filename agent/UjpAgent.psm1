#Requires -Version 7.4
# =====================================================================
#  УЈП е-Фактура – локален агент: мапирање, потпис (JWS RS256), API
#
#  Извор: api-documentation (eInvoice-single-processing-api), примери
#  json_primeri_21.10.2026 и primer_za_json_2 (УЈП). Не се додаваат полиња
#  што ги нема во официјалните примери.
#
#  Модулот НЕ зависи од SharePoint: функциите за мапирање примаат обични
#  hashtable објекти, па се тестираат без мрежа (Test-UjpMapping.ps1).
# =====================================================================

# Version 1: hashtable-ите со опционални клучеви (VatImpact, VoidReasonCode …) не смеат да фрлаат грешка.
Set-StrictMode -Version 1.0

# ---------------------------------------------------------------------
#  Заокружување и броеви
# ---------------------------------------------------------------------

# HALF_UP (0.5 нагоре, -0.5 надолу) – правило на УЈП за тоталите.
function Get-UjpRound {
    param([Parameter(Mandatory)][decimal]$Value, [int]$Decimals = 2)
    $r = [Math]::Round($Value, $Decimals, [MidpointRounding]::AwayFromZero)
    # Цел број → long (JSON «300», не «300.0»); инаку ги брише нулите на крај (45.7600 → 45.76).
    if ($r -eq [Math]::Truncate($r)) { return [long]$r }
    return [decimal]::Parse($r.ToString("0.############################", [Globalization.CultureInfo]::InvariantCulture), [Globalization.CultureInfo]::InvariantCulture)
}

# ---------------------------------------------------------------------
#  Видови документи
# ---------------------------------------------------------------------

# Наш DocType → тип кај УЈП. Сторно = истиот тип 100 со docStorno 1 и референца ST.
# Книжно одобрение (110) и задолжение (120): во примерите на УЈП износите се ПОЗИТИВНИ,
# а кај нас одобрението е зачувано со минус → агентот праќа апсолутни вредности (Sign = -1).
$script:DocTypes = @{
    "Фактура"            = @{ Code = "100"; Name = "Фактура";            Storno = 0; Sign = 1;  RefType = $null; RefName = $null }
    "Сторно"             = @{ Code = "100"; Name = "Фактура";            Storno = 1; Sign = 1;  RefType = "ST";  RefName = "Сторно" }
    "Книжно одобрение"   = @{ Code = "110"; Name = "Книжно одобрение";   Storno = 0; Sign = -1; RefType = "SYS"; RefName = "Фактура" }
    "Книжно задолжување" = @{ Code = "120"; Name = "Книжно задолжение";  Storno = 0; Sign = 1;  RefType = "SYS"; RefName = "Фактура" }
    # Корекција (замена): истиот тип 100 со docStorno 2, референца KR / «Корекција» кон EUID на оригиналот (пример «Корекција на првата»)
    "Корекција"          = @{ Code = "100"; Name = "Фактура";            Storno = 2; Sign = 1;  RefType = "KR";  RefName = "Корекција" }
    # Авансна фактура: тип 130, без референца, docTurnoverDate = null (пример «Авансна фактура»)
    "Авансна фактура"    = @{ Code = "130"; Name = "Авансна фактура";    Storno = 0; Sign = 1;  RefType = $null; RefName = $null }
}

function Get-UjpDocTypeInfo {
    param([Parameter(Mandatory)][string]$DocType)
    if (-not $script:DocTypes.ContainsKey($DocType)) { return $null }
    return $script:DocTypes[$DocType]
}

# Наш начин на плаќање → шифра на УЈП (GET /api/v1/payment-types).
$script:PaymentCodes = @{
    "Готовина"            = "P10"
    "Платежна картичка"   = "P11"
    "Трансакциска сметка" = "P12"
    "Компензација"        = "P17"
    "Друго"               = "P19"
}

function Get-UjpPaymentCode {
    param([string]$PaymentMethod)
    if ([string]::IsNullOrWhiteSpace($PaymentMethod)) { $PaymentMethod = "Трансакциска сметка" }
    return $script:PaymentCodes[$PaymentMethod]
}

# ---------------------------------------------------------------------
#  Адреса: «ул. Тестна бр. 1» → улица + број (само ако нема податоци од регистарот)
# ---------------------------------------------------------------------
function Split-UjpAddress {
    param([string]$Address)
    $a = ([string]$Address).Trim()
    # «ул. Тестна бр. 1, Скопје» → градот на крај (дел по запирка без цифри) се отстранува
    if ($a -match '^(?<rest>.*\d.*?),\s*[^\d,]+$') { $a = $Matches.rest.Trim() }
    if ($a -match '^(?<street>.*?)[\s,]+(?:бр\.?\s*)?(?<number>\d+[\p{L}\d/\-]*)$') {
        return @{ Street = $Matches.street.Trim().TrimEnd(','); Number = $Matches.number }
    }
    return @{ Street = $a; Number = "" }
}

# ---------------------------------------------------------------------
#  Мапирање
# ---------------------------------------------------------------------

function ConvertTo-UjpParty {
    param([Parameter(Mandatory)][hashtable]$P, [Parameter(Mandatory)][ValidateSet("seller","buyer")][string]$Role)
    $o = [ordered]@{}
    $o["${Role}CCode"]      = $P.CCode
    $o["${Role}CName"]      = $P.CName
    $o["${Role}Tin"]        = $P.Tin
    $o["${Role}ForeignTin"] = $null
    $o["${Role}VatNumber"]  = if ($P.VatNumber) { $P.VatNumber } else { $null }
    $o["${Role}Name"]       = $P.Name
    $o["${Role}Address"]    = [ordered]@{
        streetAddress = $P.Street
        streetNumber  = $P.Number
        postalCode    = $P.PostalCode
        city          = $P.City
    }
    $o["${Role}Contact"]    = $null
    $o["${Role}Email"]      = if ($P.Email) { $P.Email } else { $null }
    return $o
}

# Една ставка според правилото на УЈП: единечните износи и тоталите по ставка до 4 децимали,
# без заокружување на 2 децимали.
function ConvertTo-UjpItem {
    param([Parameter(Mandatory)][hashtable]$L, [int]$LineNo, [int]$Sign = 1)
    [decimal]$qty   = [decimal]$L.Qty * $Sign
    [decimal]$price = [Math]::Abs([decimal]$L.UnitPrice)
    [decimal]$disc  = if ($L.DiscountPct) { [decimal]$L.DiscountPct } else { 0 }
    [decimal]$vat   = [decimal]$L.VatPct

    $unitDisc  = Get-UjpRound ($price * $disc / 100) 4
    $unitNet   = $price - $unitDisc
    $unitVat   = Get-UjpRound ($unitNet * $vat / 100) 4
    $totOrig   = Get-UjpRound ($qty * $price) 4
    $totNet    = Get-UjpRound ($qty * $unitNet) 4
    $totVat    = Get-UjpRound ($qty * $unitVat) 4

    return [ordered]@{
        docItemLineNo                  = $LineNo
        docItemSku                     = $null
        docItemSenderCode              = if ($L.ItemCode) { [string]$L.ItemCode } else { $null }
        docItemReceiverCode            = $null
        docItemDesc                    = [string]$L.Title
        docItemMUnit                   = [string]$L.Unit
        docItemQty                     = Get-UjpRound $qty 4
        docItemUnitOriginalPriceWoVat  = Get-UjpRound $price 4
        docItemUnitDiscountAmount      = $unitDisc
        docItemUnitPriceWoVat          = Get-UjpRound $unitNet 4
        docItemUnitItemDiscountAmount  = 0
        docItemUnitVat                 = $unitVat
        docItemVat                     = Get-UjpRound $vat 2
        docItemVatGroup                = [string]$L.VatGroup
        docItemTotalOriginalPriceWoVat = $totOrig
        docItemTotalPriceWoVat         = $totNet
        docItemTotalVat                = $totVat
        docItemTotalPriceWVat          = Get-UjpRound ($totNet + $totVat) 4
        docItemTaxIndicator            = [string]$L.TaxIndicator
        docItemDomesticProduct         = $null
    }
}

<#
.SYNOPSIS  Гради «document» (+ voidReason) за УЈП од податоците на фактурата.
.PARAMETER Invoice   @{ DocType; Title; DocId; IssueDate; SupplyDate; DueDate (yyyy-MM-dd); Currency;
                       PaymentMethod; Clauses; CorrectionReason; VoidReasonCode }
.PARAMETER Lines     @( @{ Title; ItemCode; Unit; Qty; UnitPrice; DiscountPct; VatPct; TaxIndicator; VatGroup } )
.PARAMETER Seller/Buyer  @{ CCode; CName; Tin; VatNumber; Name; Street; Number; PostalCode; City; Email }
.PARAMETER Reference @{ Euid; Date }  – оригиналот (сторно, 110, 120)
.PARAMETER Names     @{ Payment = @{P10="…"}; Void = @{"S-1"="…"} } – називи од шифрарниците на УЈП
#>
function ConvertTo-UjpPayload {
    param(
        [Parameter(Mandatory)][hashtable]$Invoice,
        [Parameter(Mandatory)][object[]]$Lines,
        [Parameter(Mandatory)][hashtable]$Seller,
        [Parameter(Mandatory)][hashtable]$Buyer,
        [hashtable]$Reference,
        [hashtable]$Names = @{}
    )
    $t = Get-UjpDocTypeInfo $Invoice.DocType
    if (-not $t) { throw "Видот '$($Invoice.DocType)' не е поддржан за праќање до УЈП." }

    foreach ($l in $Lines) {
        if ($l.VatImpact -eq "PRENESEN") { throw "Ставка '$($l.Title)': пренесена даночна обврска (PRENESEN) засега не е поддржана." }
    }
    $items = [System.Collections.Generic.List[object]]::new()
    $n = 0
    foreach ($l in $Lines) { $n++; $items.Add((ConvertTo-UjpItem -L $l -LineNo $n -Sign $t.Sign)) }

    # Тотали: збир на НЕзаокружените износи по ставка, па HALF_UP на 2 децимали.
    [decimal]$sOrig = 0; [decimal]$sNet = 0; [decimal]$sVat = 0
    $groups = [ordered]@{}
    foreach ($i in $items) {
        $sOrig += $i.docItemTotalOriginalPriceWoVat; $sNet += $i.docItemTotalPriceWoVat; $sVat += $i.docItemTotalVat
        $k = "$($i.docItemTaxIndicator)|$($i.docItemVatGroup)|$($i.docItemVat)"
        if (-not $groups.Contains($k)) { $groups[$k] = @{ Ind = $i.docItemTaxIndicator; Grp = $i.docItemVatGroup; Pct = $i.docItemVat; Net = [decimal]0; Vat = [decimal]0 } }
        $groups[$k].Net += $i.docItemTotalPriceWoVat; $groups[$k].Vat += $i.docItemTotalVat
    }
    # Тест-серверот на УЈП (12.11.2026, E4018): «Unknown field docItems[0].docItemTotalOriginalPriceWoVat».
    # Полето е во json_primeri_21.10.2026, но серверот го одбива → се користи само за збирот погоре, не се праќа.
    foreach ($i in $items) { $i.Remove("docItemTotalOriginalPriceWoVat") }
    $net      = Get-UjpRound $sOrig 2
    $netDisc  = Get-UjpRound $sNet 2
    $discount = Get-UjpRound ($net - $netDisc) 2
    $vatAmt   = Get-UjpRound $sVat 2
    $gross    = Get-UjpRound ($netDisc + $vatAmt) 2
    $grossR   = Get-UjpRound $gross 0
    $avans    = if ($Invoice.AdvanceAmount) { Get-UjpRound ([decimal]$Invoice.AdvanceAmount) 2 } else { 0 }

    $vatTotals = foreach ($g in $groups.Values) {
        $gn = Get-UjpRound $g.Net 2; $gv = Get-UjpRound $g.Vat 2
        [ordered]@{
            vatTaxIndicator     = $g.Ind
            vatTaxIndicatorNote = $null
            vatCode             = $g.Grp
            vatPercent          = $g.Pct
            vatTaxableAmount    = $gn
            vatAmount           = $gv
            vatTotalAmount      = Get-UjpRound ($gn + $gv) 2
        }
    }

    $refs = @()
    if ($t.RefType) {
        if (-not $Reference -or -not $Reference.Euid) { throw "Недостасува EUID на оригиналната фактура (прво таа мора да е испратена на УЈП)." }
        $refs = @([ordered]@{ docNumberRef = $Reference.Euid; docTypeRef = $t.RefType; docDateRef = $Reference.Date; docNameRef = $t.RefName })
    }

    $payCode = if ($t.Storno -eq 1) { $null } else { Get-UjpPaymentCode $Invoice.PaymentMethod }
    $payName = if ($payCode -and $Names.Payment -and $Names.Payment[$payCode]) { $Names.Payment[$payCode] } elseif ($payCode) { [string]$Invoice.PaymentMethod } else { $null }

    $document = [ordered]@{
        header = [ordered]@{
            docStorno          = $t.Storno
            docType            = $t.Code
            docAlt             = $false
            docTypeName        = $t.Name
            docDate            = $Invoice.IssueDate
            docDeliveryDate    = $null
            docDelivery        = $null
            docTurnoverDate    = if ($t.Code -eq "130") { $null } else { $Invoice.SupplyDate }
            docPeriodStartDate = $null
            docPeriodEndDate   = $null
            docNumber          = $Invoice.Title
            docId              = [string]$Invoice.DocId
            docNotes           = $null
            docIndicator       = $null
            docHeader          = $null
            docFooter          = if ($Invoice.Clauses) { [string]$Invoice.Clauses } else { $null }
        }
        docReferences = $refs
        docAttributes = @()
        seller        = ConvertTo-UjpParty -P $Seller -Role seller
        buyer         = ConvertTo-UjpParty -P $Buyer  -Role buyer
        docPayment    = [ordered]@{
            docPaymentTypeCode    = $payCode
            docPaymentTypeDesc    = $payName
            docPaymentTypeDueDays = $null
            docPaymentTypeDueDate = if ($payCode -and $Invoice.DueDate) { $Invoice.DueDate } else { $null }
            docPaymentTerms       = $null
            docPaymentNote        = $null
            docPaymentInterest    = $null
            docPaymentDiscount    = $null
            docCurrency           = $Invoice.Currency
        }
        docItems  = $items.ToArray()
        docTotals = [ordered]@{
            docNetAmount            = $net
            docDiscountAmount       = $discount
            docNetAmountDisc        = $netDisc
            docVatAmount            = $vatAmt
            docGrossAmount          = $gross
            docGrossAmountR         = $grossR
            # Аванс (Фаза 1.4): одбиен износ од авансна фактура; docFinalAmount = docGrossAmountR − аванс
            docAvansDate            = if ($avans -gt 0) { $Invoice.AdvanceDate } else { $null }
            docAvansDesc            = if ($avans -gt 0) { [string]$Invoice.AdvanceDesc } else { $null }
            docAvansAmount          = $avans
            docAmountIncrease       = 0
            docAmountDecrease       = 0
            docFinalAmount          = Get-UjpRound ($grossR - $avans) 2
            docGlobalDiscountAmount = $discount   # како во примерот «со попуст» на УЈП
        }
        vatTotals = @($vatTotals)
    }

    $payload = [ordered]@{ document = $document }
    if ($t.Storno -eq 1) {
        $code = [string]$Invoice.VoidReasonCode
        $payload["voidReason"] = [ordered]@{
            voidCode    = $code
            voidReason  = if ($Names.Void -and $Names.Void[$code]) { $Names.Void[$code] } else { $null }
            voidComment = if ($Invoice.CorrectionReason) { [string]$Invoice.CorrectionReason } else { $null }
        }
    }
    if ($t.Storno -eq 2) {
        $code = [string]$Invoice.CorrectionReasonCode
        $payload["correctionReason"] = [ordered]@{
            correctionReasonCode    = $code
            correctionReason        = if ($Names.Correction -and $Names.Correction[$code]) { $Names.Correction[$code] } else { $null }
            correctionReasonComment = if ($Invoice.CorrectionReason) { [string]$Invoice.CorrectionReason } else { $null }
        }
    }
    return $payload
}

<#
.SYNOPSIS  Проверки пред праќање. Враќа листа на проблеми (празна = во ред).
.PARAMETER Stored  @{ NetTotal; VatTotal; GrossTotal } – износите зачувани кај нас
#>
function Test-UjpPayload {
    param([Parameter(Mandatory)]$Payload, [hashtable]$Stored, [decimal]$Tolerance = 0.05, [hashtable]$Names = @{})
    $p = [System.Collections.Generic.List[string]]::new()
    $d = $Payload.document
    $h = $d.header

    if (-not $h.docNumber) { $p.Add("Нема број на документ.") }
    if (-not $h.docId)     { $p.Add("Нема docId.") }
    if (-not $h.docDate)   { $p.Add("Нема датум на издавање.") }
    if ($h.docType -eq "100" -and -not $h.docTurnoverDate) { $p.Add("Нема датум на промет.") }
    $tt = $d.docTotals
    if ($tt.docAvansAmount -gt 0) {
        if ($h.docType -ne "100" -or $h.docStorno -eq 1) { $p.Add("Аванс може да се одбие само на фактура или корекција.") }
        if ($tt.docAvansAmount -gt $tt.docGrossAmountR) { $p.Add("Авансот е поголем од износот на фактурата.") }
        if (-not $tt.docAvansDesc -or -not $tt.docAvansDate) { $p.Add("Аванс: недостасува број/датум на авансната фактура.") }
    }
    if ($d.docPayment.docCurrency -ne "MKD") { $p.Add("Засега се праќаат само фактури во MKD.") }

    foreach ($role in "seller","buyer") {
        $x = $d[$role]
        foreach ($f in "CCode","Tin","Name") { if (-not $x["$role$f"]) { $p.Add("$role`: недостасува $role$f.") } }
        if ($x["${role}CCode"] -and $x["${role}CCode"] -ne "MK") { $p.Add("$role`: засега се поддржани само субјекти од MK.") }
        foreach ($f in "streetAddress","streetNumber","postalCode","city") {
            if (-not $x["${role}Address"][$f]) { $p.Add("$role`: адресата нема '$f' (се пополнува од регистарот на УЈП или кај клиентот/купувачот).") }
        }
    }

    if (-not $d.docItems -or $d.docItems.Count -eq 0) { $p.Add("Нема ставки.") }
    foreach ($i in $d.docItems) {
        if (-not $i.docItemTaxIndicator) { $p.Add("Ставка $($i.docItemLineNo): ДДВ стапката нема даночен индикатор (VatRates → Даночен индикатор (УЈП)).") }
        if (-not $i.docItemVatGroup)     { $p.Add("Ставка $($i.docItemLineNo): ДДВ стапката нема даночна група.") }
        if (-not $i.docItemMUnit)        { $p.Add("Ставка $($i.docItemLineNo): нема единица мерка.") }
        if ($Names.Indicators -and $i.docItemTaxIndicator -and -not $Names.Indicators.ContainsKey($i.docItemTaxIndicator)) {
            $p.Add("Ставка $($i.docItemLineNo): индикаторот '$($i.docItemTaxIndicator)' не е дозволен за тип $($h.docType) (шифрарник на УЈП).")
        }
    }

    if ($h.docStorno -eq 1) {
        $v = $Payload.voidReason
        if (-not $v -or -not $v.voidCode) { $p.Add("Сторно: внесете шифра на причина (колона «Шифра на причина за сторно (УЈП)», на пр. S-1).") }
        elseif ($Names.Void -and $Names.Void.Count -and -not $Names.Void.ContainsKey($v.voidCode)) { $p.Add("Сторно: шифрата '$($v.voidCode)' не е во шифрарникот на УЈП.") }
        if (-not $d.docReferences -or $d.docReferences[0].docTypeRef -ne "ST") { $p.Add("Сторно: нема референца ST кон оригиналот.") }
        if ($d.docTotals.docGrossAmount -ge 0) { $p.Add("Сторно: износот мора да е негативен.") }
    } elseif ($h.docStorno -eq 2) {
        $c = $Payload.correctionReason
        if (-not $c -or -not $c.correctionReasonCode) { $p.Add("Корекција: изберете шифра на причина (C…).") }
        elseif ($Names.Correction -and $Names.Correction.Count -and -not $Names.Correction.ContainsKey($c.correctionReasonCode)) { $p.Add("Корекција: шифрата '$($c.correctionReasonCode)' не е во шифрарникот на УЈП.") }
        if (-not $d.docReferences -or $d.docReferences[0].docTypeRef -ne "KR") { $p.Add("Корекција: нема референца KR кон оригиналот.") }
        if ($d.docTotals.docGrossAmount -le 0) { $p.Add("Корекција: износот мора да е позитивен (ги содржи ставките што остануваат).") }
    } elseif ($d.docTotals.docGrossAmount -le 0) {
        $p.Add("Износот мора да е позитивен за тип $($h.docType).")
    }
    if ($h.docType -in "110","120" -and -not $d.docReferences) { $p.Add("Тип $($h.docType): референцата кон фактурата е задолжителна.") }

    if ($Stored) {
        $sign = if ($h.docType -eq "110") { -1 } else { 1 }
        $chk = @{ NetTotal = $d.docTotals.docNetAmountDisc; VatTotal = $d.docTotals.docVatAmount; GrossTotal = $d.docTotals.docGrossAmount
                  PayableAmount = $d.docTotals.docFinalAmount }
        foreach ($k in $chk.Keys) {
            if ($null -eq $Stored[$k]) { continue }
            $diff = [Math]::Abs([decimal]$Stored[$k] * $sign - [decimal]$chk[$k])
            if ($diff -gt $Tolerance) { $p.Add("$k кај нас ($($Stored[$k])) се разликува од пресметката по правилата на УЈП ($($chk[$k])) за $diff.") }
        }
    }
    return ,$p.ToArray()
}

# ---------------------------------------------------------------------
#  JSON и потпис (JWS compact, RS256)
# ---------------------------------------------------------------------

function ConvertTo-UjpJson {
    param([Parameter(Mandatory)]$Object, [switch]$Pretty)
    if ($Pretty) { return ($Object | ConvertTo-Json -Depth 30) }
    return ($Object | ConvertTo-Json -Depth 30 -Compress)
}

function ConvertTo-Base64Url([byte[]]$Bytes) {
    return [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

<#
.SYNOPSIS  Потпишува JSON текст како JWS: BASE64URL(header).BASE64URL(payload).BASE64URL(RSA-SHA256)
           Клучот останува во сертификатот (USB токен / Windows store); драјверот на токенот бара PIN.
#>
function New-UjpJws {
    param([Parameter(Mandatory)][string]$PayloadJson,
          [Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    if (-not $rsa) { throw "Сертификатот '$($Certificate.Subject)' нема RSA приватен клуч достапен на овој компјутер (вметнат ли е токенот?)." }
    $enc = [System.Text.UTF8Encoding]::new($false)
    $h = ConvertTo-Base64Url ($enc.GetBytes('{"alg":"RS256","typ":"JWT"}'))
    $b = ConvertTo-Base64Url ($enc.GetBytes($PayloadJson))
    $sig = $rsa.SignData($enc.GetBytes("$h.$b"), [System.Security.Cryptography.HashAlgorithmName]::SHA256,
                         [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    return "$h.$b.$(ConvertTo-Base64Url $sig)"
}

function Test-UjpJws {
    param([Parameter(Mandatory)][string]$Jws,
          [Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $parts = $Jws.Split('.')
    if ($parts.Count -ne 3) { return $false }
    $s = $parts[2].Replace('-','+').Replace('_','/'); $s += '=' * ((4 - $s.Length % 4) % 4)
    $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($Certificate)
    return $rsa.VerifyData([System.Text.Encoding]::ASCII.GetBytes("$($parts[0]).$($parts[1])"), [Convert]::FromBase64String($s),
                           [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
}

function Get-UjpCertificate {
    param([Parameter(Mandatory)][string]$Thumbprint)
    $tp = ($Thumbprint -replace '[^0-9A-Fa-f]','').ToUpperInvariant()
    foreach ($loc in "CurrentUser","LocalMachine") {
        $c = Get-ChildItem "Cert:\$loc\My\$tp" -ErrorAction SilentlyContinue
        if ($c) { return $c }
    }
    throw "Сертификатот со отпечаток $tp не е најден во Cert:\CurrentUser\My (вметнете го токенот)."
}

# Сериски број: Windows го дава во hex, УЈП (еУЈП «Сериски број на сертификатот (ID)») во децимален запис.
function ConvertTo-UjpSerialDecimal {
    param([Parameter(Mandatory)][string]$Hex)
    $h = ($Hex -replace '[^0-9A-Fa-f]','').ToUpperInvariant()
    if (-not $h) { throw "Празен сериски број." }
    return [System.Numerics.BigInteger]::Parse("0$h", [Globalization.NumberStyles]::AllowHexSpecifier).ToString()
}

# ---------------------------------------------------------------------
#  Време (Скопје) и API
# ---------------------------------------------------------------------

function Get-UjpSkopjeTime {
    param([datetime]$Utc = [datetime]::UtcNow)
    $tz = [TimeZoneInfo]::FindSystemTimeZoneById("Europe/Skopje")
    return [TimeZoneInfo]::ConvertTimeFromUtc($Utc.ToUniversalTime(), $tz)
}

# SharePoint враќа датум како UTC (полноќ по Скопје = претходниот ден 22/23 ч UTC) → датум по Скопје.
function ConvertTo-UjpDate {
    param($Value)
    if ($null -eq $Value -or "$Value" -eq "") { return $null }
    $d = [datetime]$Value
    if ($d.Kind -eq [DateTimeKind]::Utc) { $d = Get-UjpSkopjeTime $d }
    return $d.ToString("yyyy-MM-dd")
}

$script:LastCall = [datetime]::MinValue
$script:ClockOffset = [timespan]::Zero

function Wait-UjpRateLimit {
    # УЈП: најмногу 1 барање во секунда.
    $wait = 1100 - ([datetime]::UtcNow - $script:LastCall).TotalMilliseconds
    if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]$wait) }
    $script:LastCall = [datetime]::UtcNow
}

function Invoke-UjpApi {
    param([Parameter(Mandatory)][ValidateSet("GET","POST")][string]$Method,
          [Parameter(Mandatory)][string]$Uri,
          [hashtable]$Headers = @{},
          [string]$Body)
    Wait-UjpRateLimit
    $req = @{ Method = $Method; Uri = $Uri; Headers = $Headers; SkipHttpErrorCheck = $true; StatusCodeVariable = "code"; TimeoutSec = 60 }
    if ($Body) { $req.Body = [System.Text.Encoding]::UTF8.GetBytes($Body); $req.ContentType = "application/json; charset=utf-8" }
    $resp = Invoke-RestMethod @req
    return [pscustomobject]@{ Status = [int]$code; Body = $resp }
}

function Get-UjpHeaders {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)][string]$SellerEdb, [string]$Serial, [string]$DocType)
    $id = if ($Config.EujpIdByEdb -and $Config.EujpIdByEdb[$SellerEdb]) { $Config.EujpIdByEdb[$SellerEdb] } else { $Config.EujpId }
    $h = @{ "X-EUJP-ID" = $id; "X-EDB" = $SellerEdb }
    if ($Serial)  { $h["X-SERIAL-NUMBER"] = $Serial }
    if ($DocType) { $h["X-DOC-TYPE-CODE"] = $DocType }
    return $h
}

# Разлика меѓу нашиот часовник и серверот на УЈП (барањата смеат да отстапуваат најмногу ±5 минути).
function Sync-UjpClock {
    param([Parameter(Mandatory)][hashtable]$Config)
    $r = Invoke-UjpApi -Method GET -Uri "$($Config.ApiBaseUrl)/api/v1/server-time"
    if ($r.Status -ne 200 -or -not $r.Body.timestamp) { throw "server-time: HTTP $($r.Status)" }
    $script:ClockOffset = [datetime]::Parse($r.Body.timestamp, [Globalization.CultureInfo]::InvariantCulture) - (Get-UjpSkopjeTime)
    return $script:ClockOffset
}

function Get-UjpRequestTimestamp {
    return ((Get-UjpSkopjeTime) + $script:ClockOffset).ToString("yyyy-MM-ddTHH:mm:ss")
}

# Податоци од регистарот (назив, адреса, ДДВ број) – мора да се идентични со регистарот (E1000).
function Get-UjpCompany {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)][string]$SellerEdb, [Parameter(Mandatory)][string]$TaxNumber)
    $r = Invoke-UjpApi -Method GET -Uri "$($Config.ApiBaseUrl)/api/v1/companies/$TaxNumber" -Headers (Get-UjpHeaders -Config $Config -SellerEdb $SellerEdb)
    if ($r.Status -ne 200 -or -not $r.Body.success -or -not $r.Body.company) { throw "companies/$TaxNumber`: HTTP $($r.Status) $(ConvertTo-UjpJson $r.Body)" }
    $c = $r.Body.company
    return @{
        CCode = if ($c.countryCode) { $c.countryCode } else { "MK" }
        Tin = $c.taxNumber; VatNumber = $c.vatNumber; Name = $c.name; RegNo = $c.registrationNumber
        Street = $c.address.street; Number = $c.address.number; PostalCode = $c.address.zip; City = $c.address.city
    }
}

# Шифрарник (payment-types, void-reasons …) → @{ code = назив }
function Get-UjpCodeNames {
    param([Parameter(Mandatory)][hashtable]$Config, [Parameter(Mandatory)][string]$SellerEdb,
          [Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$ListProperty, [Parameter(Mandatory)][string]$NameProperty)
    $r = Invoke-UjpApi -Method GET -Uri "$($Config.ApiBaseUrl)/api/v1/$Path" -Headers (Get-UjpHeaders -Config $Config -SellerEdb $SellerEdb)
    if ($r.Status -ne 200 -or -not $r.Body.success) { throw "$Path`: HTTP $($r.Status)" }
    $m = @{}
    foreach ($x in $r.Body.$ListProperty) { if ($x.isActive -ne $false) { $m[[string]$x.code] = [string]$x.$NameProperty } }
    return $m
}

<#
.SYNOPSIS  Потпишува и праќа документ. Враќа @{ Ok; Status; Euid; QrLink; Timestamp; Raw; Json }.
#>
function Send-UjpDocument {
    param([Parameter(Mandatory)][hashtable]$Config,
          [Parameter(Mandatory)]$Payload,
          [Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate)
    $ts = Get-UjpRequestTimestamp
    $signed = [ordered]@{ requestTimestamp = $ts }
    foreach ($k in $Payload.Keys) { $signed[$k] = $Payload[$k] }
    $json = ConvertTo-UjpJson $signed
    $jws  = New-UjpJws -PayloadJson $json -Certificate $Certificate
    $body = ConvertTo-UjpJson ([ordered]@{ requestTimestamp = $ts; jws = $jws })
    $serial = if ($Config.CertSerialNumber) { [string]$Config.CertSerialNumber } else { ConvertTo-UjpSerialDecimal $Certificate.SerialNumber }
    $h = Get-UjpHeaders -Config $Config -SellerEdb $Payload.document.seller.sellerTin -Serial $serial -DocType $Payload.document.header.docType
    $r = Invoke-UjpApi -Method POST -Uri $Config.SendUrl -Headers $h -Body $body
    $b = $r.Body
    $euid = if ($b -and $b.PSObject.Properties.Name -contains "euid") { [string]$b.euid } else { $null }
    return @{
        Ok        = ($r.Status -ge 200 -and $r.Status -lt 300 -and $euid)
        Status    = $r.Status
        Euid      = $euid
        QrLink    = if ($b -and $b.PSObject.Properties.Name -contains "qr_link") { [string]$b.qr_link } else { $null }
        Timestamp = if ($b -and $b.PSObject.Properties.Name -contains "timestamp") { [string]$b.timestamp } else { $null }
        Raw       = if ($b -is [string]) { $b } else { ConvertTo-UjpJson $b }
        Json      = $json
    }
}

Export-ModuleMember -Function ConvertTo-UjpSerialDecimal, Get-UjpRound, Get-UjpDocTypeInfo, Get-UjpPaymentCode, Split-UjpAddress,
    ConvertTo-UjpItem, ConvertTo-UjpPayload, Test-UjpPayload, ConvertTo-UjpJson, New-UjpJws, Test-UjpJws,
    Get-UjpCertificate, Get-UjpSkopjeTime, ConvertTo-UjpDate, Sync-UjpClock, Get-UjpRequestTimestamp,
    Get-UjpCompany, Get-UjpCodeNames, Get-UjpHeaders, Send-UjpDocument, Invoke-UjpApi
