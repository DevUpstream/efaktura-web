# 19 – Празнење на фирма за повторен внес (УПСТРЕАМ, 17.11.2026)

## Одлука
УПСТРЕАМ (ЕДБ 4015023508550) се празни и се внесува од почеток, година по година, од Excel. Потоа се гради материјално (магацин) година по година.

| Се брише | Останува |
|---|---|
| излезни фактури (и UPSTRI-2026-00001, UPSTRI-ST-2026-00001), влезни фактури, изводи, плаќања, компензации, опомени | фирмата и поставките |
| магацински документи, залиха, лотови, сериски броеви | **партнерите** (контакти, белешки, жиро-сметки) |
| артикли (со цени, нормативи, работни налози), повторувачки фактури, трошковни места | **магацините** (GL, SP, SVC) |
| внатрешните броеви (VF, приемници, испратници) почнуваат од 1 | бројачите на фактурите (следна: UPSTRI-2026-00002; 00001 не се користи пак) |
| | корисниците, ревизијата (`audit_log`, со нов запис `purge_documents`) |

## Скрипти
- `deploy/oneoff/purge-client-docs.sql` – една трансакција; тригерите за заштита се исклучуваат само во неа и пак се вклучуваат. Печати табела „пред / после“.
- `deploy/oneoff/purge-client-docs.sh <ЕДБ>` – проба (ROLLBACK, ништо не се брише).
- `deploy/oneoff/purge-client-docs.sh <ЕДБ> --commit` – прво `04-backup.sh`, потоа копија `backups/rezerva-pred-brisenje-<ЕДБ>-<време>.dump` (ротацијата од 14 дена не ја брише), па COMMIT.
- Тест: `api/test/purge.test.ts` (другата фирма не се допира; тригерите пак важат; погрешен ЕДБ = грешка, ништо не се брише).

## Постапка (PowerShell)
```powershell
$k = "$env:USERPROFILE\.ssh\oracle-efaktura.key"
ssh -i $k ubuntu@92.5.149.62 "sudo rm -rf ~/efaktura-deploy"
scp -i $k -r "C:\Users\User\OneDrive - FKK VIDI\eFakturi\server\deploy" ubuntu@92.5.149.62:efaktura-deploy
ssh -i $k ubuntu@92.5.149.62 "sudo bash ~/efaktura-deploy/oneoff/purge-client-docs.sh 4015023508550"
ssh -i $k ubuntu@92.5.149.62 "sudo bash ~/efaktura-deploy/oneoff/purge-client-docs.sh 4015023508550 --commit"
```

## Резервни копии
1. Серверот: `/opt/efaktura/backups/rezerva-pred-brisenje-4015023508550-*.dump` (цела база, pg_dump).
2. Облак OCI `dnevni/` (од `04-backup.sh`).
3. OneDrive: `eFakturi\export\UPSTRI-izvoz-202611171120.zip` (CSV, читливо).

Враќање: само целата база (`05-restore-test.sh` за проба). Делумно враќање на една фирма не постои.
