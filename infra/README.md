# infra/: GenClass hub on Azure

These Azure resources support the GenClass project: a nightly CI against the published npm packages, public hosting
for the demos, a public mirror of the model files, CI history in Postgres, and a runner image. All of them live in
resource group **`rg-genclass-hub`** (subscription "Azure subscription 1", tag `project=genclass`) and are paid from
the Microsoft for Startups sponsorship credit. They were set up on 2026-10-09 and also count toward the credit
milestones (5+ / 7+ Azure workloads, each with at least $1 of continuous spend).

> **Cost guard: do not disable.** The Automation account `aa-cost-guard` (in `rg-jev-train`) runs `CostGuard`
> every 15 min. It treats `rg-genclass-hub` as protected: the credit-earning workloads keep running. When the
> forecast threatens a CA$3,000 credit reserve, it stops VMs outside this RG. At CA$10,000 used it deallocates all VMs,
> and at CA$12,500 (or on 2028-07-15) it cancels the subscription. Never disable or modify it, and don't create VMs
> outside this resource group. Alert email: mehar@daybot.ca.

## Resources

| resource | name | SKU / region | purpose | est. CA$/month |
|---|---|---|---|---|
| Virtual machine | `vm-genclass-ci` | Standard_B2pls_v2 (2 vCPU Arm64, 4 GB), Ubuntu 24.04, **westus2**, always on | nightly CI (cron 06:00 UTC), demo builds/deploys, Playwright | 34.75 |
| OS disk | `vm-genclass-ci_OsDisk_1_*` | 64 GiB Standard SSD (E6) | VM disk | 6.80 |
| Virtual network + public IP | `vnet-genclass` (10.0.0.0/16, `snet-ci`), `pip-genclass-ci` (Standard static, 20.114.10.214), NSG `nsg-genclass-ci-w2` | westus2 | VM network; SSH only from 129.97.124.0/23 (UWaterloo, includes the Mac's current IP) | 5.18 (IP) |
| Storage account | `stgenclass9dc31e` | StorageV2 Standard LRS, Hot, eastus | `models` (public read + CORS): every published `@genclass/runtime-model` / `@genclass/runtime` version; `ci-results` (private): nightly JSON, logs, built e2e app | < 0.10 (about 0.1 GB) |
| App Service | plan `plan-genclass-demos` (Linux B1), web app `genclass-demos-9dc31e` (Node 22, HTTPS only, always on) | eastus | public demo site **https://genclass-demos-9dc31e.azurewebsites.net/** | 17.59 |
| Application Insights | `appi-genclass-demos` (workspace-based) on Log Analytics `law-genclass` (PerGB2018, 30 days) | eastus | requests, failures and latency of the demo site (Node agent, codeless) | ~0 (inside the 5 GB/month free allowance) |
| Container Registry | `acrgenclass9dc31e` | Basic, eastus | `genclass-runner` image (node 22 + Playwright Chromium + repo + CI scripts), built with `az acr build` | 7.20 |
| PostgreSQL flexible server | `pg-genclass-9dc31e`, database `genclass` | Burstable B1ms, 32 GiB, PG 16, **westus3**, public endpoint, firewall = CI VM IP only, TLS required | `ci_results` table: one row per nightly run | 17.59 + ~5.0 storage |
| Foundry Models | existing `OpenAI-Daybot` (rg `Daybot-AI`), deployment `gpt-5.6-sol` | reused, not created | nightly one-sentence CI status + digest of the last 24 h of commits, stored in Postgres | ~2 to 5 |
| **total** | | | | **~CA$97** |

Regions: Azure would not place B-series VMs in eastus/eastus2/centralus/canadacentral for this subscription (capacity
restriction), and it would not allow PostgreSQL in eastus/westus2. So the VM runs in westus2 (the Arm B2pls_v2 is cheaper
than B2s) and Postgres in westus3. eastus2 regional cores were raised 65 → 80 (free) while trying eastus2.

Secrets: the Postgres admin password is in `~/.jev-local/secrets/pg-genclass.env` on the Mac (chmod 600) and in
`/etc/genclass-ci.env` on the VM (root:root 600). The VM's **system-assigned managed identity** handles everything
else: Storage Blob Data Contributor on the storage account, Website Contributor on the web app, and Cognitive Services
OpenAI User on `OpenAI-Daybot`. No storage or OpenAI keys are stored anywhere.

## Files

| file | where it runs | what |
|---|---|---|
| `ci/cloud-init.yaml` | VM first boot | node 22, git, jq, psql, Azure CLI, Playwright 1.63 Chromium + deps, 4 GB swap |
| `ci/genclass-ci.cron` | `/etc/cron.d/genclass-ci` | `0 6 * * *` root → `nightly.sh` (flock), log `/var/log/genclass-ci.log` |
| `ci/nightly.sh` | `/opt/genclass-ci/` (root) | run-tests (as azureuser) → AI notes → blob upload → model mirror → Postgres row |
| `ci/run-tests.sh` | as azureuser | clone/pull `runtime`, `npm ci`, `npm pack @genclass/runtime@latest @genclass/runtime-model@latest`, `packages/runtime-model/scripts/e2e.mjs` on those tarballs, `smoke-published.sh`, `summarize.mjs` |
| `ci/smoke-published.sh` | | `packages/runtime/test/smoke/smoke.sh` for an already-published tarball |
| `ci/summarize.mjs` | | e2e JSON → `ci-result.json` (guard_fixed, observe_detected, clean_calls, latency_ms, versions, ok) |
| `ci/ai-summary.mjs` | | two chat calls on `gpt-5.6-sol` with the managed identity; input is capped (40k + 50k chars) |
| `ci/mirror-models.sh` | | npm tarballs → `models/npm/<pkg>/<ver>.tgz`; model files → `models/runtime-model/<ver>/files/` (new versions only) |
| `ci/schema.sql` | Postgres | `ci_results` table |
| `webapp/server.mjs` | App Service | zero-dependency static server (wasm MIME, no-cache `sw.js`, `Service-Worker-Allowed`, `/healthz`) |
| `webapp/deploy.sh` | VM (`~/webapp/`) | build runtime + demos from `runtime` with `VITE_GENCLASS_MODEL_URL=cdn` (the runtime's jsDelivr default), zip deploy |
| `webapp/verify-site.mjs` | VM (copy into a checkout with `@playwright/test`) | Playwright check of the live site: HTTPS, Service Worker, cross-origin isolation, scripted trials off vs guard |
| `docker/Dockerfile` | ACR Tasks | `genclass-runner` image |

## Operating it

```bash
IP=20.114.10.214; ssh -i ~/.ssh/jev_azure "azureuser@${IP}"
sudo tail -50 /var/log/genclass-ci.log                       # last nightly runs
sudo bash -c 'nohup flock -n /run/genclass-ci.lock bash /opt/genclass-ci/nightly.sh >> /var/log/genclass-ci.log 2>&1 &'   # run now
sudo bash -c 'set -a; . /etc/genclass-ci.env; psql -c "select run_date, runtime_version, model_version, guard_fixed, trials, observe_detected, clean_calls, latency_ms, ok, summary from ci_results order by run_at desc limit 7"'
bash ~/webapp/deploy.sh                                       # rebuild + redeploy the demo site from origin/runtime
cd ~/demos-build/GenClass-lib && cp ~/webapp/verify-site.mjs .verify-site.mjs && node .verify-site.mjs https://genclass-demos-9dc31e.azurewebsites.net/
```

Update the CI scripts: edit them here, then `scp` them to the VM and `sudo install` them into `/opt/genclass-ci/`.
Rebuild the image: `az acr build -r acrgenclass9dc31e -t genclass-runner:latest -f infra/docker/Dockerfile infra`
(from the repo root, cloud build).
Public model mirror: `GenClass.init({ model: { baseUrl: "https://stgenclass9dc31e.blob.core.windows.net/models/runtime-model/0.2.0/files/" } })`.

## Tear down

```bash
az group delete -n rg-genclass-hub --yes            # everything above except the Foundry resource (it is shared)
az role assignment delete --assignee 8274151c-d5da-4c6e-bbb0-aa897b31d3ab \
  --scope /subscriptions/d5f80547-574e-4175-97f6-85c95c9d4c7e/resourceGroups/Daybot-AI/providers/Microsoft.CognitiveServices/accounts/OpenAI-Daybot
rm ~/.jev-local/secrets/pg-genclass.env
```

Don't touch `rg-jev-train` (training cluster + cost guard) or `rg-qwen-cpu` (another project).
