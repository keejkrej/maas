<#
.SYNOPSIS
  Deploy maas to Google Cloud Run and bootstrap your first team (idempotent — safe to re-run to redeploy).

.EXAMPLE
  ./deploy/deploy.ps1 -ProjectId my-gcp-project -Team acme -TeamName "Acme Inc" -AdminId chris -AdminName "Chris"
#>
param(
  [Parameter(Mandatory = $true)] [string] $ProjectId,
  [Parameter(Mandatory = $true)] [string] $Team,
  [string] $TeamName = "",
  [Parameter(Mandatory = $true)] [string] $AdminId,
  [string] $AdminName = "",
  [string] $Region = "europe-west1",
  [string] $Service = "maas",
  [string] $AgentModel = "gemini-3.5-flash",
  [string] $DreamModel = "",
  [string] $ModelLocation = "global",
  [string] $DreamSchedule = "0 4 * * *",
  [string] $TimeZone = "Europe/Berlin"
)
$ErrorActionPreference = "Stop"
if (-not $DreamModel) { $DreamModel = $AgentModel }
if (-not $TeamName) { $TeamName = $Team }
if (-not $AdminName) { $AdminName = $AdminId }
$Bucket = "$ProjectId-maas"
$Sa = "maas-agent@$ProjectId.iam.gserviceaccount.com"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Exists($cmd) { & cmd /c "$cmd >nul 2>nul"; return $LASTEXITCODE -eq 0 }

Step "Project $ProjectId"
gcloud config set project $ProjectId | Out-Null

Step "Enabling APIs (first run takes a minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com `
  aiplatform.googleapis.com storage.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com | Out-Null

Step "Bucket gs://$Bucket (team registry, memory repo snapshots, inbox journals)"
if (-not (Exists "gcloud storage buckets describe gs://$Bucket")) {
  gcloud storage buckets create "gs://$Bucket" --location $Region --uniform-bucket-level-access
  gcloud storage buckets update "gs://$Bucket" --versioning   # every snapshot is recoverable
}

Step "Service account $Sa"
if (-not (Exists "gcloud iam service-accounts describe $Sa")) {
  gcloud iam service-accounts create maas-agent --display-name "maas memory agent"
  Start-Sleep 5
}
gcloud projects add-iam-policy-binding $ProjectId --member "serviceAccount:$Sa" --role roles/aiplatform.user --condition None | Out-Null
gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --member "serviceAccount:$Sa" --role roles/storage.objectAdmin | Out-Null

Step "Server admin token (Secret Manager: maas-admin-token)"
if (-not (Exists "gcloud secrets describe maas-admin-token")) {
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $tok = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  $tmp = New-TemporaryFile; Set-Content -Path $tmp -Value $tok -NoNewline
  gcloud secrets create maas-admin-token --replication-policy automatic --data-file $tmp | Out-Null
  Remove-Item $tmp
}
$adminToken = (gcloud secrets versions access latest --secret maas-admin-token).Trim()
gcloud secrets add-iam-policy-binding maas-admin-token --member "serviceAccount:$Sa" --role roles/secretmanager.secretAccessor | Out-Null

Step "Deploying Cloud Run service (builds remotely with Cloud Build)"
$envVars = @(
  "MAAS_GCS_BUCKET=$Bucket",
  "GOOGLE_GENAI_USE_VERTEXAI=true",
  "GOOGLE_CLOUD_PROJECT=$ProjectId",
  "GOOGLE_CLOUD_LOCATION=$ModelLocation",
  "MAAS_AGENT_MODEL=$AgentModel",
  "MAAS_DREAM_MODEL=$DreamModel"
)
# Single instance = single writer per team repo. CPU always on so agents keep working after responding.
gcloud run deploy $Service --source . --region $Region --service-account $Sa `
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 2 --memory 2Gi --concurrency 80 --timeout 3600 `
  --set-env-vars ("^@^" + ($envVars -join "@")) `
  --set-secrets "MAAS_ADMIN_TOKEN=maas-admin-token:latest" `
  --allow-unauthenticated --quiet

$Url = (gcloud run services describe $Service --region $Region --format "value(status.url)").Trim()

Step "Nightly dream via Cloud Scheduler ($DreamSchedule $TimeZone)"
$job = "$Service-dream"
$schedArgs = @("--location", $Region, "--schedule", $DreamSchedule, "--time-zone", $TimeZone, "--uri", "$Url/dream",
  "--http-method", "POST", "--headers", "Authorization=Bearer $adminToken", "--attempt-deadline", "30s")
if (Exists "gcloud scheduler jobs describe $job --location $Region") {
  gcloud scheduler jobs update http $job @schedArgs | Out-Null
} else {
  gcloud scheduler jobs create http $job @schedArgs | Out-Null
}

Step "Team '$Team'"
$h = @{ Authorization = "Bearer $adminToken" }
for ($i = 0; $i -lt 20; $i++) { try { Invoke-RestMethod "$Url/healthz" | Out-Null; break } catch { Start-Sleep 3 } }
$teams = Invoke-RestMethod "$Url/api/teams" -Headers $h
$memberKey = $null
if ($teams | Where-Object { $_.id -eq $Team }) {
  Write-Host "  team exists — keeping existing member keys (rotate with: npm run admin -- member:rotate $Team $AdminId)"
} else {
  $body = @{ id = $Team; name = $TeamName; admin = @{ id = $AdminId; name = $AdminName } } | ConvertTo-Json
  $out = Invoke-RestMethod "$Url/api/teams" -Method Post -Headers $h -ContentType "application/json" -Body $body
  $memberKey = $out.key
}

Write-Host "`n✅ maas is live" -ForegroundColor Green
Write-Host "  MCP endpoint : $Url/mcp"
Write-Host "  Admin token  : $adminToken   (server-level: create teams; keep it private)"
if ($memberKey) {
  Write-Host "  Your key     : $memberKey   ($AdminName, admin of '$Team' — shown only once, save it)" -ForegroundColor Yellow
  Write-Host "  Viewer       : $Url/view?key=$memberKey"
}
Write-Host "`nAdd teammates:  `$env:MAAS_URL='$Url'; `$env:MAAS_TOKEN='<your key>'; npm run admin -- member:add $Team alice `"Alice`""
Write-Host "Or in the viewer: Team & keys. See README.md for per-client configuration."
