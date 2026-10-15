# Deploying Nataka Hii to Azure

Total time: about 45–60 minutes. Everything runs in **Azure Cloud Shell** (the `>_` icon at the top of the Azure portal → choose **Bash**), so you don't need anything installed on your laptop except Git and Docker (Docker only for the fallback in step 5).

Take a screenshot in the **portal** after each step; those are your "deployment screenshots" for the report.

---

## Quick path: one command (recommended)

The script `azure/deploy.sh` runs steps 1–6 below automatically and prints everything you need for step 7.

1. Push this project to a GitHub repository (step 0).
2. Open **Azure Cloud Shell** (Bash) and run:
   ```bash
   git clone https://github.com/<your-user>/<your-repo>.git nataka && cd nataka
   SUFFIX=g11aieb bash azure/deploy.sh
   ```
   Use your own suffix (3–12 lowercase letters/digits). If a region is blocked, add `LOC=southindia` in front.
3. When it finishes (about 10–15 minutes) it prints the live URL, the SQL password, and the five GitHub secrets. They are also saved in `~/nataka-deploy-output.txt`.
4. Do **step 7** (add the GitHub secrets) and **step 8** (monitoring) below.

If the image build step fails because ACR Tasks are blocked, the script prints the three `docker` commands to run on your laptop, then tells you how to re-run it with `SKIP_BUILD=1`.

To delete everything afterwards: `bash azure/cleanup.sh`.

The manual steps below do exactly the same thing, one command at a time. Use them if you prefer to understand each step, or if the script stops partway.

---

## 0. Push the code to GitHub

Create a new GitHub repository and push this folder to its `main` branch.

## 1. Set variables (Cloud Shell)

Pick a short unique suffix (lowercase letters and digits only), e.g. your group code.

```bash
SUFFIX=g11aieb                       # change this
LOC=centralindia                     # if a step fails with "location not allowed", use southindia or eastus
RG=rg-nataka-hii
SQL=nataka-sql-$SUFFIX
SQLPASS='Nataka@Azure2026!'          # change this; needs upper, lower, digit, symbol
STG=natakastg$SUFFIX
ACR=natakaacr$SUFFIX
APP=nataka-hii-$SUFFIX

az group create -n $RG -l $LOC
```

> Azure for Students subscriptions only allow some regions. If any command says the region is not allowed, delete nothing; just set `LOC` to another region and repeat that command.

## 2. Azure SQL Database

```bash
az sql server create -g $RG -n $SQL -l $LOC --admin-user sqladmin --admin-password "$SQLPASS"

# Let Azure services (our App Service) reach the server
az sql server firewall-rule create -g $RG -s $SQL -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0

# Basic tier: about USD 5/month from student credit, never pauses (no slow first request in the demo)
az sql db create -g $RG -s $SQL -n ecommerce_db --service-objective Basic
```

You don't create any tables by hand: the app creates the schema and demo data on its first start (`INIT_DB=true`).

To run queries yourself (for the viva), add your own IP:
Portal → SQL server → **Networking** → *Add your client IPv4 address* → Save. Then use **SQL database → Query editor** with `sqladmin` and the password, and run anything from `db/queries.sql`.

## 3. Azure Blob Storage

```bash
az storage account create -g $RG -n $STG -l $LOC --sku Standard_LRS --allow-blob-public-access false
STORAGE_CS=$(az storage account show-connection-string -g $RG -n $STG -o tsv)
```

The container `product-images` is created by the app on startup. It stays **private**; the app streams images through `/images/<name>`.

## 4. Application Insights

```bash
az extension add -n application-insights --upgrade -y
az monitor app-insights component create -g $RG -a ai-nataka -l $LOC --application-type web --kind web
AI_CS=$(az monitor app-insights component show -g $RG -a ai-nataka --query connectionString -o tsv)
```

If the create command fails, use the portal instead: **Create a resource → Application Insights**, resource group `rg-nataka-hii`, then copy the **Connection String** from its Overview page into `AI_CS='...'`.

## 5. Azure Container Registry + first image

```bash
az acr create -g $RG -n $ACR --sku Basic --admin-enabled true
ACR_USER=$(az acr credential show -n $ACR --query username -o tsv)
ACR_PASS=$(az acr credential show -n $ACR --query "passwords[0].value" -o tsv)

# Build the image inside Azure from your GitHub repo (no local Docker needed)
git clone https://github.com/<your-user>/<your-repo>.git nataka && cd nataka
az acr build -r $ACR -t nataka-hii:latest .
cd ..
```

**If `az acr build` fails** with "TasksOperationsNotAllowed" (some student subscriptions block ACR Tasks), build on your laptop instead:

```bash
# on your laptop, in the project folder
docker login <acr-name>.azurecr.io -u <ACR_USER> -p <ACR_PASS>     # values from Portal > Container registry > Access keys
docker build -t <acr-name>.azurecr.io/nataka-hii:latest .
docker push <acr-name>.azurecr.io/nataka-hii:latest
```

## 6. Azure App Service (Linux, container)

```bash
az appservice plan create -g $RG -n plan-nataka -l $LOC --is-linux --sku B1

az webapp create -g $RG -p plan-nataka -n $APP \
  --container-image-name $ACR.azurecr.io/nataka-hii:latest \
  --container-registry-url https://$ACR.azurecr.io \
  --container-registry-user $ACR_USER \
  --container-registry-password "$ACR_PASS"

az webapp config appsettings set -g $RG -n $APP --settings \
  WEBSITES_PORT=8080 \
  DB_SERVER=$SQL.database.windows.net \
  DB_NAME=ecommerce_db \
  DB_USER=sqladmin \
  DB_PASSWORD="$SQLPASS" \
  INIT_DB=true \
  JWT_SECRET=$(openssl rand -hex 32) \
  AZURE_STORAGE_CONNECTION_STRING="$STORAGE_CS" \
  APPLICATIONINSIGHTS_CONNECTION_STRING="$AI_CS"

az webapp config set -g $RG -n $APP --always-on true
az webapp restart -g $RG -n $APP
echo "https://$APP.azurewebsites.net"
```

Wait 2–3 minutes, then open the URL. The status pill at the top should say **database connected**. Check `https://<app>.azurewebsites.net/api/health`; it should show `"storage":"azure-blob"`.

If it doesn't load: Portal → App Service → **Log stream**. Lines starting with `[db]` show the schema being created.

## 7. CI/CD with GitHub Actions

1. Allow publish-profile deployments (new apps have this off by default):
   ```bash
   az resource update -g $RG --namespace Microsoft.Web --resource-type basicPublishingCredentialsPolicies \
     --parent sites/$APP --name scm --set properties.allow=true
   ```
2. Download the publish profile:
   ```bash
   az webapp deployment list-publishing-profiles -g $RG -n $APP --xml
   ```
   Copy the whole XML output.
3. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**. Add:

   | Secret | Value |
   |---|---|
   | `ACR_LOGIN_SERVER` | `<acr-name>.azurecr.io` |
   | `ACR_USERNAME` | value of `$ACR_USER` |
   | `ACR_PASSWORD` | value of `$ACR_PASS` |
   | `AZURE_WEBAPP_NAME` | value of `$APP` |
   | `AZURE_WEBAPP_PUBLISH_PROFILE` | the XML from step 2 |

4. Push any change to `main` (or **Actions → Build and deploy to Azure → Run workflow**). The workflow builds the image, pushes it to ACR tagged with the commit SHA, and deploys it.

**Demo idea:** change the hero text in `frontend/index.html`, push, show the Actions run going green, refresh the live site.

## 8. Monitoring

Portal → **Application Insights → ai-nataka**:

- **Live metrics**: click around the site and watch requests arrive in real time
- **Application map**: shows App Service → Azure SQL and App Service → Blob Storage
- **Performance**: slowest API routes and SQL calls
- **Failures**: any 500 errors with stack traces

Portal → **App Service → Metrics** (Azure Monitor): CPU, memory, HTTP requests, response time.

## Screenshots checklist for the report

1. Resource group showing all resources
2. Azure SQL Database overview + Query editor running a query from `db/queries.sql`
3. Storage account → Containers → `product-images` with uploaded files
4. Container registry → Repositories → `nataka-hii` with tags
5. App Service overview (URL, Running) + Environment variables (hide the values)
6. GitHub Actions run (green)
7. Application Insights live metrics + application map
8. The live site: store, vendor portal, admin console

## Cost and cleanup

Approximate cost on student credit: App Service B1 ≈ USD 13/month, SQL Basic ≈ USD 5/month, ACR Basic ≈ USD 5/month, storage and App Insights ≈ cents. After your evaluation, delete everything with one command:

```bash
az group delete -n rg-nataka-hii --yes
```

## Identity: why not Azure AD B2C

The faculty spec lists Azure AD B2C. Microsoft stopped selling Azure AD B2C to new customers on 1 May 2025, so a new student subscription cannot create a B2C tenant. Its successor is **Microsoft Entra External ID**. This project uses its own JWT authentication with bcrypt password hashing and role-based access control (admin / vendor / customer), which keeps users and roles inside the relational database. Moving sign-in to Entra External ID is listed as future work.
