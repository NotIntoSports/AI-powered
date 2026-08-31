#!/usr/bin/env pwsh
# 部署到 175 服务器：scp 变更文件 -> 服务器构建 -> 重启
$ErrorActionPreference = "Stop"
$ServerHost = "175.27.132.61"
$ServerUser = "ubuntu"
$ServerKey  = "C:/Users/28839/.ssh/personal_server_ed25519"
$ServerBase = "/home/ubuntu/management"
$LocalRoot = "$PSScriptRoot/.."

$sshArgs = "-i", $ServerKey, "-o", "StrictHostKeyChecking=no"
$scpArgs = "-i", $ServerKey, "-o", "StrictHostKeyChecking=no"

function Run-SSH($cmd) {
    # Normalize to LF and strip any stray CR before piping to remote bash.
    $normalized = (($cmd -replace "`r`n", "`n") -replace "`r", "`n").TrimEnd("`n") + "`n"
    $normalized | & ssh @sshArgs "${ServerUser}@${ServerHost}" "tr -d '\r' | bash -s"
    if ($LASTEXITCODE -ne 0) {
        throw "SSH remote command failed with exit code $LASTEXITCODE"
    }
}

function Run-SCP($local, $remote) {
    & scp @scpArgs $local "${ServerUser}@${ServerHost}:${remote}"
}

Write-Host "=== [1/4] 同步 control-api 变更文件 ===" -ForegroundColor Cyan
$caFiles = @(
    "internal/database/migrations/00014_ai_providers_multi.sql",
    "internal/database/migrations/00015_model_catalog.sql",
    "internal/database/migrations/00016_token_plan_personal_catalog.sql",
    "internal/database/migrations/00017_voice_routes.sql",
    "internal/database/migrations/00018_voice_routes_backfill.sql",
    "internal/database/migrations/00019_speech_params_repair.sql",
    "internal/settings/store.go",
    "internal/settings/service.go",
    "internal/settings/catalog.go",
    "internal/settings/catalog_test.go",
    "internal/settings/ai_providers.go",
    "internal/settings/ai_providers_service.go",
    "internal/settings/token_plan_catalog.go",
    "internal/settings/voice_routes.go",
    "internal/settings/speech.go",
    "internal/settings/aliyun_nls.go",
    "internal/settings/aliyun_cosyvoice.go",
    "internal/httpapi/admin_settings.go",
    "internal/httpapi/admin_ai_providers.go",
    "internal/httpapi/admin_settings_test.go",
    "internal/httpapi/router.go",
    "internal/httpapi/voice_routes.go",
    "go.mod",
    "go.sum",
    "openapi/openapi.yaml"
)
foreach ($f in $caFiles) {
    Write-Host "  $f"
    Run-SCP "$LocalRoot/server/control-api/$f" "$ServerBase/control-api/$f"
}

Write-Host "=== [2/4] 同步 management-web 变更文件 ===" -ForegroundColor Cyan
Run-SSH "mkdir -p $ServerBase/management-web/components $ServerBase/management-web/app/settings/speech $ServerBase/control-api/internal/database/migrations $ServerBase/control-api/internal/httpapi $ServerBase/control-api/internal/settings"
$mwFiles = @(
    "app/settings/ai/page.tsx",
    "app/settings/speech/page.tsx",
    "app/settings/speech/voice-routes-panel.tsx",
    "app/settings/rtc/page.tsx",
    "app/overview/page.tsx",
    "app/sessions/page.tsx",
    "app/use-admin-session.ts",
    "app/clear-session/route.ts",
    "middleware.ts",
    "app/globals.css",
    "app/console-shell.tsx",
    "components/searchable-combobox.tsx",
    "lib/control-api.ts",
    "lib/cosyvoice-voice-catalog.ts"
)
foreach ($f in $mwFiles) {
    Write-Host "  $f"
    Run-SCP "$LocalRoot/server/management-web/$f" "$ServerBase/management-web/$f"
}

# 删除旧的 models 页面
Write-Host "  删除 models/page.tsx..."
Run-SSH "rm -f $ServerBase/management-web/app/settings/models/page.tsx"

Write-Host "=== [2.5/4] 同步 deploy/nginx.conf 与 LiveKit 配置 ===" -ForegroundColor Cyan
Run-SCP "$LocalRoot/server/deploy/nginx.conf" "$ServerBase/deploy/nginx.conf"
Run-SCP "$LocalRoot/server/deploy/compose.yaml" "$ServerBase/deploy/compose.yaml"
Run-SCP "$LocalRoot/server/deploy/livekit.yaml" "$ServerBase/deploy/livekit.yaml"

Write-Host "=== [3/4] 在服务器上构建并重启 ===" -ForegroundColor Cyan
$revision = (git -C $LocalRoot rev-parse --short HEAD).Trim()
$revMsg = (git -C $LocalRoot log -1 --pretty=format:'%h %ad %s' --date=short).Trim()
$remoteScript = @"
set -e
cd $ServerBase/deploy
echo '>>> 构建 control-api...'
docker compose build --build-arg GOPROXY=https://goproxy.cn,direct control-api
echo '>>> 构建 management-web...'
docker compose build management-web
echo '>>> 重启服务...'
docker compose up -d control-api management-web nginx
echo '$revMsg' > $ServerBase/DEPLOYED_REVISION
echo '>>> 清理...'
docker image prune -f
echo '=== 部署完成 ==='
cat $ServerBase/DEPLOYED_REVISION
"@
$remoteScript = ($remoteScript -replace "`r`n", "`n") -replace "`r", "`n"
Run-SSH $remoteScript

Write-Host "=== [4/4] 完成 ===" -ForegroundColor Green
Write-Host "访问 http://$ServerHost 验证（revision $revision）"
