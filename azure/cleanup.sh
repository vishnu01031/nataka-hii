#!/usr/bin/env bash
# Deletes every Azure resource created by deploy.sh (stops all charges).
set -euo pipefail
RG="rg-nataka-hii"
read -r -p "Delete resource group $RG and EVERYTHING in it? Type yes: " ok
[[ "$ok" == "yes" ]] || { echo "Cancelled."; exit 0; }
az group delete -n "$RG" --yes --no-wait
echo "Deletion started. It finishes in the background in a few minutes."
