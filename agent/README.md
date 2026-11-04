# Agent (kompjuterot so USB tokenot)

UJP e dostapen samo od dozvoleni IP adresi (ne od serverot na Oracle), a potpisot bara USB token.
Zatoa baranjata kon UJP gi izvrsuva agentot na kompjuterot so tokenot.

Glavnata kopija na agentot e vo OneDrive (`eFakturi\agent`, so UjpAgent.psm1 i 89 testovi).
Ovde se cuvaat samo skriptite sto zboruvaat so noviot server.

| Skripta | Namena |
| --- | --- |
| Sync-ServerRegistry.ps1 | Baranja do registarot na UJP od aplikacijata ("Повлечи од УЈП", "Провери во УЈП") |

Kluchot za serverot: aplikacija -> Корисници и пристап -> Агент -> Нов клуч, pa `.\Sync-ServerRegistry.ps1 -SetKey`
(se cuva so Windows DPAPI vo `server-agent.key`, nikogas vo Git).
