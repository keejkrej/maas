<#
.SYNOPSIS
  Deploy maas to Google Cloud Run (idempotent — safe to re-run to redeploy).

.EXAMPLE
  ./deploy/deploy.ps1 -ProjectId my-gcp-project -Owner "Chris"
#>
param(
  [Parameter(Mandatory = $true)] [string] $ProjectId,
  [string] $Owner = "Owner",
  [string] $Region = "europe-west1",
  [string] $Service = "maas",
  [string] $AgentModel = "gemini-3.5-flash",
  [string] $DreamModel = "",
  [string] $ModelLocation = "global",
  [string] $DreamSchedule = "0 4 * * *",
  [string] $TimeZone = "Europe/Berlin",
  [string] $GitRemote = ""
)
$ErrorActionPreference = "Stop"
if (-not $DreamModel) { $DreamModel = $AgentModel }
$Bucket = "$ProjectId-maas"
$Sa = "maas-agent@$ProjectId.iam.gserviceaccount.com"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Exists($cmd) { & cmd /c "$cmd >nul 2>nul"; return $LASTEXITCODE -eq 0 }

Step "Project $ProjectId"
gcloud config set project $ProjectId | Out-Null

Step "Enabling APIs (first run takes a minute)"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com `
  aiplatform.googleapis.com storage.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com | Out-Null

Step "Bucket gs://$Bucket (memory repo snapshots + inbox journal)"
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

Step "Access token secret"
if (-not (Exists "gcloud secrets describe maas-token")) {
  $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  $tmp = New-TemporaryFile; Set-Content -Path $tmp -Value $token -NoNewline
  gcloud secrets create maas-token --replication-policy automatic --data-file $tmp | Out-Null
  Remove-Item $tmp
}
$token = (gcloud secrets versions access latest --secret maas-token).Trim()
gcloud secrets add-iam-policy-binding maas-token --member "serviceAccount:$Sa" --role roles/secretmanager.secretAccessor | Out-Null

Step "Deploying Cloud Run service (builds remotely with Cloud Build)"
$envVars = @(
  "MAAS_OWNER=$Owner",
  "MAAS_GCS_BUCKET=$Bucket",
  "GOOGLE_GENAI_USE_VERTEXAI=true",
  "GOOGLE_CLOUD_PROJECT=$ProjectId",
  "GOOGLE_CLOUD_LOCATION=$ModelLocation",
  "MAAS_AGENT_MODEL=$AgentModel",
  "MAAS_DREAM_MODEL=$DreamModel"
)
if ($GitRemote) { $envVars += "MAAS_GIT_REMOTE=$GitRemote" }
# Single instance = single writer for the git repo. CPU always on so the agent keeps working after responding.
gcloud run deploy $Service --source . --region $Region --service-account $Sa `
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 1Gi --concurrency 80 --timeout 3600 `
  --set-env-vars ("^@^" + ($envVars -join "@")) `
  --set-secrets "MAAS_TOKEN=maas-token:latest" `
  --allow-unauthenticated --quiet

$Url = (gcloud run services describe $Service --region $Region --format "value(status.url)").Trim()

Step "Nightly dream via Cloud Scheduler ($DreamSchedule $TimeZone)"
$job = "$Service-dream"
$schedArgs = @("--location", $Region, "--schedule", $DreamSchedule, "--time-zone", $TimeZone, "--uri", "$Url/dream",
  "--http-method", "POST", "--headers", "Authorization=Bearer $token", "--attempt-deadline", "30s")
if (Exists "gcloud scheduler jobs describe $job --location $Region") {
  gcloud scheduler jobs update http $job @schedArgs | Out-Null
} else {
  gcloud scheduler jobs create http $job @schedArgs | Out-Null
}

Write-Host "`n✅ maas is live" -ForegroundColor Green
Write-Host "  MCP endpoint : $Url/mcp"
Write-Host "  Viewer       : $Url/view?key=$token"
Write-Host "  Token        : $token"
Write-Host "  Token-in-URL : $Url/mcp/$token   (for clients that can't set headers)"
Write-Host "`nSee README.md for per-client configuration."
