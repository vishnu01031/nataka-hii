#!/usr/bin/env bash
# =====================================================================
#  Nataka Hii — one-command Azure deployment (Infrastructure as Code)
#
#  Run in Azure Cloud Shell (Bash), from the repository folder:
#     git clone https://github.com/<you>/<repo>.git nataka && cd nataka
#     SUFFIX=g11aieb bash azure/deploy.sh
#
#  Creates: Resource group, Azure SQL server + database, Storage account,
#           Application Insights, Container Registry (+ image build),
#           App Service plan + Web App (container), app settings, health check.
#  Safe to re-run: existing resources are reused.
#
#  Options (environment variables):
#     SUFFIX      required, lowercase letters/digits, makes names unique
#     LOC         Azure region (default centralindia; try southindia or eastus if blocked)
#     SQLPASS     SQL admin password (default: generated and printed at the end)
#     SKIP_BUILD  set to 1 if you pushed the image yourself from your laptop
# =====================================================================
set -euo pipefail

SUFFIX="${SUFFIX:?Set SUFFIX, e.g.  SUFFIX=g11aieb bash azure/deploy.sh}"
if [[ ! "$SUFFIX" =~ ^[a-z0-9]{3,12}$ ]]; then
  echo "SUFFIX must be 3-12 lowercase letters or digits"; exit 1
fi

LOC="${LOC:-centralindia}"
RG="rg-nataka-hii"
SQL="nataka-sql-$SUFFIX"
DB="ecommerce_db"
SQLUSER="sqladmin"
SQLPASS="${SQLPASS:-Nh$(openssl rand -hex 6)!Az9}"
STG="natakastg$SUFFIX"
ACR="natakaacr$SUFFIX"
AI="ai-nataka"
PLAN="plan-nataka"
APP="nataka-hii-$SUFFIX"
IMAGE="nataka-hii"
OUT="$HOME/nataka-deploy-output.txt"

step() { echo; echo "==> $*"; }

step "Using subscription: $(az account show --query name -o tsv)   region: $LOC"

step "1/8 Resource group $RG"
az group create -n "$RG" -l "$LOC" -o none

step "2/8 Azure SQL server $SQL + database $DB (Basic tier)"
if ! az sql server show -g "$RG" -n "$SQL" -o none 2>/dev/null; then
  az sql server create -g "$RG" -n "$SQL" -l "$LOC" \
    --admin-user "$SQLUSER" --admin-password "$SQLPASS" -o none
else
  echo "    server exists - reusing (keep using the password you set the first time)"
fi
az sql server firewall-rule create -g "$RG" -s "$SQL" -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
az sql db show -g "$RG" -s "$SQL" -n "$DB" -o none 2>/dev/null || \
  az sql db create -g "$RG" -s "$SQL" -n "$DB" --service-objective Basic -o none

step "3/8 Storage account $STG (private blobs)"
az storage account show -g "$RG" -n "$STG" -o none 2>/dev/null || \
  az storage account create -g "$RG" -n "$STG" -l "$LOC" --sku Standard_LRS \
    --allow-blob-public-access false --min-tls-version TLS1_2 -o none
STORAGE_CS=$(az storage account show-connection-string -g "$RG" -n "$STG" -o tsv)

step "4/8 Application Insights $AI"
az extension add -n application-insights --upgrade -y -o none 2>/dev/null || true
az monitor app-insights component show -g "$RG" -a "$AI" -o none 2>/dev/null || \
  az monitor app-insights component create -g "$RG" -a "$AI" -l "$LOC" \
    --application-type web --kind web -o none
AI_CS=$(az monitor app-insights component show -g "$RG" -a "$AI" --query connectionString -o tsv)

step "5/8 Container registry $ACR"
az acr show -g "$RG" -n "$ACR" -o none 2>/dev/null || \
  az acr create -g "$RG" -n "$ACR" --sku Basic --admin-enabled true -o none
az acr update -n "$ACR" --admin-enabled true -o none
ACR_SERVER="$ACR.azurecr.io"
ACR_USER=$(az acr credential show -n "$ACR" --query username -o tsv)
ACR_PASS=$(az acr credential show -n "$ACR" --query "passwords[0].value" -o tsv)

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  step "6/8 Building the Docker image in Azure (az acr build)"
  if ! az acr build -r "$ACR" -t "$IMAGE:latest" . ; then
    cat <<MSG

  ACR Tasks are blocked on this subscription. Build on your laptop instead:
     docker login $ACR_SERVER -u $ACR_USER -p '<password from Portal > $ACR > Access keys>'
     docker build -t $ACR_SERVER/$IMAGE:latest .
     docker push $ACR_SERVER/$IMAGE:latest
  then re-run:   SUFFIX=$SUFFIX SQLPASS='<same password>' SKIP_BUILD=1 bash azure/deploy.sh
MSG
    exit 1
  fi
else
  step "6/8 Skipping build (SKIP_BUILD=1) - using $ACR_SERVER/$IMAGE:latest"
fi

step "7/8 App Service plan $PLAN (Linux B1) + web app $APP"
az appservice plan show -g "$RG" -n "$PLAN" -o none 2>/dev/null || \
  az appservice plan create -g "$RG" -n "$PLAN" -l "$LOC" --is-linux --sku B1 -o none
if ! az webapp show -g "$RG" -n "$APP" -o none 2>/dev/null; then
  az webapp create -g "$RG" -p "$PLAN" -n "$APP" \
    --container-image-name "$ACR_SERVER/$IMAGE:latest" \
    --container-registry-url "https://$ACR_SERVER" \
    --container-registry-user "$ACR_USER" \
    --container-registry-password "$ACR_PASS" -o none
fi
# Set the image address explicitly. Newer CLI versions prepend the registry to
# --container-image-name, which can produce "<acr>/<acr>/image" - this overrides it.
az webapp config set -g "$RG" -n "$APP" --linux-fx-version "DOCKER|$ACR_SERVER/$IMAGE:latest" -o none

# Keep an existing JWT secret on re-runs so logged-in users are not signed out
JWT_SECRET=$(az webapp config appsettings list -g "$RG" -n "$APP" \
  --query "[?name=='JWT_SECRET'].value | [0]" -o tsv 2>/dev/null || true)
[[ -z "$JWT_SECRET" ]] && JWT_SECRET=$(openssl rand -hex 32)

az webapp config appsettings set -g "$RG" -n "$APP" -o none --settings \
  WEBSITES_PORT=8080 \
  DOCKER_REGISTRY_SERVER_URL="https://$ACR_SERVER" \
  DOCKER_REGISTRY_SERVER_USERNAME="$ACR_USER" \
  DOCKER_REGISTRY_SERVER_PASSWORD="$ACR_PASS" \
  DB_SERVER="$SQL.database.windows.net" \
  DB_NAME="$DB" \
  DB_USER="$SQLUSER" \
  DB_PASSWORD="$SQLPASS" \
  INIT_DB=true \
  JWT_SECRET="$JWT_SECRET" \
  AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CS" \
  AZURE_STORAGE_CONTAINER=product-images \
  APPLICATIONINSIGHTS_CONNECTION_STRING="$AI_CS"

step "8/8 Always On, health check, HTTPS only, container logs, CI/CD credentials"
az webapp config set -g "$RG" -n "$APP" --always-on true -o none
az webapp config set -g "$RG" -n "$APP" --generic-configurations '{"healthCheckPath": "/api/health"}' -o none
az webapp update -g "$RG" -n "$APP" --https-only true -o none
az webapp log config -g "$RG" -n "$APP" --docker-container-logging filesystem -o none
# Allow publish-profile deployments for GitHub Actions
az resource update -g "$RG" --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
  --parent "sites/$APP" --name scm --set properties.allow=true -o none
az webapp restart -g "$RG" -n "$APP" -o none

PUBLISH_PROFILE_FILE="$HOME/nataka-publish-profile.xml"
az webapp deployment list-publishing-profiles -g "$RG" -n "$APP" --xml > "$PUBLISH_PROFILE_FILE"

URL="https://$APP.azurewebsites.net"
cat > "$OUT" <<SUMMARY
Nataka Hii deployment ($(date -u))
================================================================
Live site ............ $URL
Health check ......... $URL/api/health

Azure SQL
  server ............. $SQL.database.windows.net
  database ........... $DB
  user / password .... $SQLUSER / $SQLPASS

GitHub Actions secrets (repo > Settings > Secrets and variables > Actions)
  ACR_LOGIN_SERVER ............... $ACR_SERVER
  ACR_USERNAME ................... $ACR_USER
  ACR_PASSWORD ................... $ACR_PASS
  AZURE_WEBAPP_NAME .............. $APP
  AZURE_WEBAPP_PUBLISH_PROFILE ... contents of $PUBLISH_PROFILE_FILE
                                   (run: cat $PUBLISH_PROFILE_FILE)

Delete everything after the evaluation:
  az group delete -n $RG --yes
SUMMARY

step "Done. Summary saved to $OUT"
cat "$OUT"
echo
echo "The first start takes 2-3 minutes (the app creates the tables and demo data)."
echo "Watch it with:  az webapp log tail -g $RG -n $APP"
