# eFaktura web

Web aplikacija za izdavanje e-fakturi kon sistemot e-Faktura na UJP, za smetkovodstveno biro so povekje klienti.
Zamena za Power Apps + SharePoint resenieto (proektot FakturiUJP).

## Arhitektura
| Sloj | Tehnologija |
| --- | --- |
| Reverse proxy, HTTPS | Caddy 2 (Let's Encrypt) |
| Baza | PostgreSQL 17 |
| API | ASP.NET Core (C#) - vo izrabotka |
| Web | vo izrabotka |
| Potpis i prakjanje kon UJP | lokalen PowerShell agent so USB tokenot (tokenot nikogas ne odi na serverot) |

## Okolini
| Okolina | Adresa | Server |
| --- | --- | --- |
| TEST | https://92-5-149-62.sslip.io | Oracle Free Tier, eu-frankfurt-1, VM.Standard.E2.1.Micro, Ubuntu 26.04 |

Samo test okolina na UJP (efakturatest / eujptest).

## Instalacija na serverot
Vidi `deploy/`. Tajnite (lozinka za bazata) se generiraat na serverot vo `/opt/efaktura/secrets` i nikogas ne se vo Git.
