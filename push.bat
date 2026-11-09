@echo off
rem ---------------------------------------------------------------------------
rem One command to build and publish. Works from cmd.exe, double-click, or a
rem shortcut with "Run as administrator".
rem
rem   push.bat
rem   push.bat "message for this update"
rem
rem Stages every new, changed and deleted file in the whole tree. No file lists,
rem no manual adds. .gitignore keeps .env, .dev.vars, node_modules and
rem server\data out of it.
rem ---------------------------------------------------------------------------

setlocal enabledelayedexpansion
cd /d "%~dp0"

if not exist ".git\" (
  echo [x] No git repo in "%CD%"
  exit /b 1
)

if exist "scripts\build-pages.mjs" (
  echo Building dist\ ...
  node "scripts\build-pages.mjs" >nul
  if errorlevel 1 (
    echo [x] dist build failed - run: node scripts\build-pages.mjs
    exit /b 1
  )
)

git add -A

set COUNT=0
for /f "delims=" %%L in ('git status --porcelain') do set /a COUNT+=1

if %COUNT%==0 (
  echo Nothing to push - working tree is clean.
  exit /b 0
)

set "MSG=%~1"
if "%MSG%"=="" set "MSG=update %COUNT% file(s) %DATE% %TIME%"

git commit -q -m "%MSG%"
if errorlevel 1 (
  echo [x] Commit failed.
  exit /b 1
)

git push
if errorlevel 1 (
  echo Retrying with upstream set ...
  git push -u origin main
  if errorlevel 1 (
    echo [x] Push failed - check the remote and your GitHub credentials.
    exit /b 1
  )
)

echo.
echo Pushed %COUNT% file^(s^).
git log --oneline -1
