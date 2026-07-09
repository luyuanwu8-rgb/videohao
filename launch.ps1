# ============================================================
#  videohao 工作台启动器(健壮版)
#  - 探测带超时,永不卡死
#  - 能识别"僵死服务器"(端口在监听但不响应)并自动清理重启
#  - 首次缺依赖自动 npm install
#  由 启动工作台.vbs 隐藏窗口调用;也可单独运行排查
# ============================================================
$ErrorActionPreference = "SilentlyContinue"
$port = 3000
$url  = "http://localhost:$port"
$projectDir = $PSScriptRoot
Set-Location $projectDir

# 健康探测:请求 /api/tasks,5 秒超时。返回 $true 仅当 HTTP 200。
function Test-Healthy {
  try {
    $r = Invoke-WebRequest -Uri "$url/api/tasks" -TimeoutSec 5 -UseBasicParsing
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

# 取占用 3000 端口(LISTENING)的进程 PID;无则返回 $null
function Get-PortPid {
  $line = netstat -ano | Select-String ":$port\s.*LISTENING" | Select-Object -First 1
  if ($line) {
    $cols = ($line.ToString().Trim() -split '\s+')
    return $cols[-1]
  }
  return $null
}

# 1) 已经健康 → 直接开浏览器,退出(这是最常见路径:服务已在跑)
if (Test-Healthy) {
  Start-Process $url
  exit 0
}

# 2) 端口被占但不健康 = 僵死服务器 → 杀掉,腾出端口重启
$stalePid = Get-PortPid
if ($stalePid) {
  Stop-Process -Id $stalePid -Force
  Start-Sleep -Seconds 2
}

# 3) 依赖缺失 → 先装(显示窗口让用户看到进度,阻塞等待)
if (-not (Test-Path "$projectDir\node_modules\next")) {
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c npm install" -WorkingDirectory $projectDir -Wait
}

# 4) 后台隐藏启动 dev server
Start-Process -FilePath "cmd.exe" `
  -ArgumentList "/c npm run dev -- -p $port" `
  -WorkingDirectory $projectDir -WindowStyle Hidden

# 5) 轮询就绪(最多 120 秒),健康即开浏览器退出
for ($i = 0; $i -lt 120; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Healthy) {
    Start-Process $url
    exit 0
  }
}

# 6) 超时兜底:仍打开浏览器(可能还在编译),并提示
Start-Process $url
exit 0
