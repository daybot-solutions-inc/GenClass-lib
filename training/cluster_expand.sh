#!/bin/bash
# Create extra cluster nodes (TRAIN owns expansion; quota 2,048 vCPU since 2026-10-08). Mac-safe: one az call at a
# time, each wrapped in timeout. For each NAME:SIZE: create the VM in rg-jev-train (same VNet/subnet/NSG/PPG/image/key as
# scripts/cluster_up.sh; falls back to no PPG if the PPG has no capacity for the SKU), append "NAME PUB PRIV SIZE" to
# ~/.jev-local/azure_hosts, and add a DevTestLab auto-shutdown schedule in **Disabled** state.
#   training/cluster_expand.sh c12:Standard_F80ads_v7 c13:Standard_F80ads_v7 ...
set -uo pipefail
RG=rg-jev-train
HOSTS=~/.jev-local/azure_hosts
for spec in "$@"; do
  name="${spec%%:*}"; size="${spec##*:}"
  if grep -q "^$name " "$HOSTS" 2>/dev/null; then echo "$name exists"; continue; fi
  common=(-g $RG -n "vm-jev-$name" --size "$size" --image Canonical:ubuntu-24_04-lts:server:latest --admin-username azureuser
          --ssh-key-values ~/.ssh/jev_azure.pub --vnet-name vm-jev-trainVNET --subnet vm-jev-trainSubnet --nsg nsg-jev-train
          --public-ip-sku Standard --accelerated-networking true --os-disk-size-gb 256 --storage-sku Premium_LRS
          --os-disk-delete-option Delete --nic-delete-option Delete --tags project=jev-local purpose=train-cluster
          --query "[id,publicIpAddress,privateIpAddress]" -o tsv)
  out=$(timeout 900 az vm create "${common[@]}" --ppg ppg-jev 2>&1)
  if [ $? -ne 0 ]; then
    echo "$name: create with PPG failed ($(echo "$out" | grep -i -E 'error|message' | head -1 | cut -c1-160)); retrying without PPG"
    out=$(timeout 900 az vm create "${common[@]}" 2>&1)
    if [ $? -ne 0 ]; then echo "FAILED $name $size: $(echo "$out" | grep -i -E 'error|message' | head -2 | cut -c1-200)"; continue; fi
  fi
  vals=$(echo "$out" | grep -v -i warning)
  id=$(echo "$vals" | awk 'NR==1'); pub=$(echo "$vals" | awk 'NR==2'); priv=$(echo "$vals" | awk 'NR==3')
  echo "$name $pub $priv $size" >> "$HOSTS"
  props=$(printf '{"status":"Disabled","taskType":"ComputeVmShutdownTask","dailyRecurrence":{"time":"0300"},"timeZoneId":"UTC","notificationSettings":{"status":"Disabled","timeInMinutes":30},"targetResourceId":"%s"}' "$id")
  timeout 300 az resource create -g $RG -n "shutdown-computevm-vm-jev-$name" --resource-type Microsoft.DevTestLab/schedules \
    -l eastus --properties "$props" --query "properties.status" -o tsv 2>&1 | tail -1 | sed "s/^/$name schedule: /"
  echo "created $name $size $pub $priv"
done
