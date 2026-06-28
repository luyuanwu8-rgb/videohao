@echo off
chcp 65001 >nul
rem ============================================================
rem  图书带货视频工厂 — 工作台启动器(内部脚本，由 启动工作台.vbs 调起)
rem  作用：起本地服务 → 等端口就绪 → 打开浏览器工作台
rem  不要直接双击这个 .bat（会弹黑窗），请双击 启动工作台.vbs
rem ============================================================

rem 切到项目根目录（本脚本在 scripts\ 下，需回到上一级；npm/node_modules 都在根目录）
cd /d "%~dp0\.."

set PORT=3000
set URL=http://localhost:%PORT%

rem 若依赖未安装，先装一次（首次使用）
if not exist "node_modules\next" (
  echo 首次启动，正在安装依赖（仅这一次，可能需要几分钟）…
  call npm install
)

rem 若服务已在运行（端口已就绪），直接开浏览器，不再重复启动
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%')|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 (
  echo 工作台已在运行，直接打开…
  start "" "%URL%"
  exit
)

rem 后台拉起 Next 开发服务器
echo 正在启动工作台服务…
start "videohao-server" /min cmd /c "npm run dev -- -p %PORT%"

rem 轮询端口，最多等 60 秒，就绪后开浏览器
echo 等待服务就绪…
set /a tries=0
:waitloop
set /a tries+=1
powershell -NoProfile -Command "try{(Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 '%URL%')|Out-Null;exit 0}catch{exit 1}" >nul 2>&1
if %errorlevel%==0 goto ready
if %tries% geq 60 goto timeout
timeout /t 1 /nobreak >nul
goto waitloop

:ready
echo 工作台已就绪，正在打开浏览器…
start "" "%URL%"
goto done

:timeout
echo 服务启动超时（60秒）。请检查是否有报错，或手动打开 %URL%
start "" "%URL%"

:done
exit
